// Load environment variables
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

// Determine the correct path to .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Go up 3 directories: /scenarios -> /v2 -> /src -> /sync-test (root)
const rootDir = resolve(__dirname, '../../../');
// Load the environment variables
dotenv.config({ path: resolve(rootDir, '.env') });

import { DB_TABLES, TEST_DEFAULTS, API_CONFIG } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { 
  ScenarioRunner, 
  Scenario, 
  Action, 
  StepDefinition, 
  ApiAction, 
  ChangesAction, 
  WSAction, 
  ValidationAction,
  InteractiveAction,
  OperationContext 
} from '../core/scenario-runner.ts';
import { MessageProcessor } from '../core/message-processor.ts';
import { EntityType, EntityChange, Operation } from '../types.ts';
import { messageDispatcher } from '../core/message-dispatcher.ts';
import type {
  ServerChangesMessage,
  ServerLSNUpdateMessage,
  ServerCatchupCompletedMessage,
  ServerSyncStatsMessage,
  ClientHeartbeatMessage,
  ClientReceivedMessage,
  SrvMessageType,
  CltMessageType,
  TableChange
} from '@repo/sync-types';

// Import from entity-changes module
import { 
  ChangeTracker,
  initialize as initializeDatabase,
  createChangeTracker
} from '../core/entity-changes/index.ts';

// Also import the change-operations types directly to get GeneratedChanges interface
import type { GeneratedChanges } from '../core/entity-changes/change-operations.ts';

// Import TypeORM DataSource and serverEntities
import { DataSource } from 'typeorm';
import { serverEntities } from '@repo/dataforge/server-entities';

// Logger for this module
const logger = createLogger('live-sync');

// Default options for live sync test
const defaultOptions: LiveSyncOptions = {};

// Log environment status
logger.info(`Loaded environment from ${resolve(rootDir, '.env')}`);
logger.info(`Database URL configured: ${process.env.DATABASE_URL ? 'Yes' : 'No'}`);
logger.info(`API URL configured: ${process.env.API_URL ? 'Yes' : 'No'}`);
logger.info(`WebSocket URL configured: ${process.env.WS_URL ? 'Yes' : 'No'}`);

// Check if the DATABASE_URL environment variable is set
if (!process.env.DATABASE_URL) {
  logger.error('No DATABASE_URL configured. Tests cannot run.');
  logger.error('Please ensure you have configured a proper database connection in .env file.');
  process.exit(1);
}

// Create a DataSource instance directly like in entity-changes-test.ts
const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: serverEntities,
  synchronize: false,
  logging: false
});

// Define table mappings for validation
const TABLE_MAP: Record<string, string> = {
  task: DB_TABLES.TASKS,
  project: DB_TABLES.PROJECTS,
  user: DB_TABLES.USERS,
  comment: DB_TABLES.COMMENTS
};

// Helper function to reset inactivity timeout
function resetInactivityTimeout(context: OperationContext): void {
  if (context.state.timeoutId) {
    clearTimeout(context.state.timeoutId);
  }
  
  // Set a longer inactivity timeout (300 seconds) - increased to handle high server load
  context.state.timeoutId = setTimeout(() => {
    context.logger.warn('Inactivity timeout expired, forcing completion');
    messageDispatcher.dispatchMessage({
      type: 'timeout_force_completion',
      timestamp: Date.now()
    });
  }, 300000); // Increased to 300 seconds (5 minutes)
  
  context.state.lastChangeTime = Date.now();
}

/**
 * Default options for live sync test
 */
interface LiveSyncOptions {
  errorOnTimeout?: boolean;
  timeoutMs?: number;
  logLevel?: string;
  initializeParams?: any;
}

/**
 * Live Sync Test Scenario
 * 
 * This scenario tests a multiple client live synchronization scenario:
 * 1. Initialize and clear database
 * 2. Set up replication
 * 3. Create WebSocket clients
 * 4. Set up clients (connect to WebSocket server)
 * 5. Handle catchup sync
 * 6. Create changes in the database
 * 7. Wait for changes to be delivered to all clients
 * 8. Validate changes
 * 9. Disconnect clients
 */
export const LiveSyncScenario: Scenario = {
  name: 'Live Sync Test',
  description: 'Tests the live sync capability with multiple clients',
  config: {
    timeout: 30000,
    changeCount: 5,
    customProperties: {
      clientCount: 1,
      tolerance: 0
    }
  },
  
  hooks: {
    beforeScenario: async (context) => {
      context.logger.info(`Starting live sync test with ${context.config.customProperties?.clientCount || 1} clients and ${context.config.changeCount} changes`);
      
      // Create a single ChangeTracker instance to use throughout the entire scenario
      // Configure it for optimized handling of large datasets
      const options = {
        tolerance: 0, // No tolerance for strict validation
        deduplicationEnabled: true, // Enable deduplication support
        batchSize: 50 // Process in reasonable batch sizes
      };
      
      context.state.changeTracker = createChangeTracker(options);
      
      // Register the message handlers EARLY to ensure they're available before messages are processed
      // This prevents the "Message was NOT handled by any dispatcher handler" warnings
      messageDispatcher.registerHandler('srv_live_changes', (message: any) => {
        // DO NOT fully handle the message - let it pass through to the interactive protocol handler
        return false;
      });
      
      messageDispatcher.registerHandler('srv_catchup_changes', (message: any) => {
        // DO NOT fully handle the message - let it pass through to the interactive protocol handler
        return false;
      });
      
      messageDispatcher.registerHandler('srv_catchup_completed', (message: any) => {
        // DO NOT fully handle the message - let it pass through to the interactive protocol handler
        return false;
      });

      messageDispatcher.registerHandler('srv_sync_stats', (message: any) => {
        // DO NOT fully handle the message - let it pass through to the interactive protocol handler
        return false;
      });
    },
    
    // Add a hook to check for fatal errors after each step
    afterStep: async (step, context) => {
      if (context.state.shouldExit) {
        context.logger.error(`Critical error in step "${step.name}", exiting scenario`);
        throw new Error(`Step "${step.name}" encountered a fatal error, terminating scenario`);
      }
    }
  },
  
  steps: [
    // Step 1: Initialize Database
    {
      name: 'Initialize Database',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Initialize Database',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            context.logger.info('Initializing database for live sync test');
            
            try {
              // Use the initialize function from entity-changes with direct dataSource
              const initialized = await initializeDatabase(dataSource);
              
              if (!initialized) {
                context.logger.error('Failed to initialize database');
                context.state.shouldExit = true;
                return { success: false, error: 'Database initialization failed' };
              }
              
              context.logger.info('Database initialized successfully');
              return { success: true };
            } catch (error) {
              context.logger.error(`Error initializing database: ${error}`);
              context.state.shouldExit = true;
              return { success: false, error: String(error) };
            }
          }
        } as ChangesAction
      ]
    },
    
    // Step 2: Initialize Replication
    {
      name: 'Initialize Replication',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Initialize Replication',
          operation: 'initializeReplication'
        } as ChangesAction,
        {
          type: 'api',
          name: 'Initialize Server Replication',
          endpoint: '/api/replication/init',
          method: 'POST',
          responseHandler: async (response: any, context: OperationContext) => {
            if (response && response.lsn) {
              context.state.initialLSN = response.lsn;
              context.logger.info(`Retrieved initial replication LSN from init: ${response.lsn}`);
            }
            return response;
          }
        } as ApiAction
      ]
    },
    
    // Step 3: Create WebSocket Clients
    {
      name: 'Create WebSocket Clients',
      execution: 'serial',
      actions: [
        {
          type: 'ws',
          name: 'Create WebSocket Clients',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const clientCount = context.config.customProperties?.clientCount || 1;
            context.logger.info(`Creating ${clientCount} WebSocket clients (reusing if available)`);
            
            // Create or reuse clients
            const clients: string[] = [];
            for (let i = 0; i < clientCount; i++) {
              const profileId = i + 1; // 1-based profile ID
              const clientId = await operations.ws.createClient(profileId);
              clients.push(clientId);
              context.logger.info(`Client ${i+1}/${clientCount}: ${clientId} with profile ID ${profileId}`);
            }
            
            // Store clients in context
            context.state.clients = clients;
            context.logger.info(`Successfully created ${clients.length} clients: ${clients.join(', ')}`);
            
            return clients;
          }
        } as WSAction
      ]
    },
    
    // Step 4: Set Up Clients
    {
      name: 'Set Up Clients',
      execution: 'serial',
      actions: [
        {
          type: 'ws',
          name: 'Set Up WebSocket Clients',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const clients = context.state.clients || [];
            context.logger.info(`Setting up ${clients.length} WebSocket clients`);
            
            // Set up clients in parallel using promises
            const setupPromises = clients.map(async (clientId: string, index: number) => {
              try {
                await operations.ws.setupClient(clientId);
                context.logger.info(`Client ${index+1}/${clients.length} setup complete: ${clientId}`);
              } catch (err) {
                context.logger.error(`Failed to setup client ${clientId}: ${err}`);
                throw err;
              }
            });
            
            await Promise.all(setupPromises);
            context.logger.info('All clients successfully set up and connected');
            
            return clients.length;
          }
        } as WSAction
      ]
    },
    
    // UPDATED STEP: Initialize clients with the same LSN
    {
      name: 'Initialize Clients with Same LSN',
      execution: 'serial',
      actions: [
        {
          type: 'ws',
          name: 'Update All Clients with Same LSN',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            // Use the LSN we got from the init call
            const initialLSN = context.state.initialLSN;
            if (!initialLSN) {
              context.logger.info('No initial LSN available from replication init, skipping client LSN updates');
              return { success: true, skipped: true };
            }
            
            const clients = context.state.clients || [];
            context.logger.info(`Updating ${clients.length} clients with initial LSN: ${initialLSN}`);
            
            // Update each client's LSN in parallel
            const updatePromises = clients.map(async (clientId: string, index: number) => {
              try {
                await operations.ws.updateLSN(clientId, initialLSN);
                context.logger.info(`Updated client ${index+1}/${clients.length} (${clientId}) with LSN ${initialLSN}`);
                return true;
              } catch (err) {
                context.logger.error(`Failed to update LSN for client ${clientId}: ${err}`);
                return false;
              }
            });
            
            const results = await Promise.all(updatePromises);
            const successCount = results.filter(result => result).length;
            
            if (successCount === clients.length) {
              context.logger.info(`Successfully updated all ${clients.length} clients with LSN ${initialLSN}`);
            } else {
              context.logger.warn(`Updated ${successCount}/${clients.length} clients with LSN ${initialLSN}`);
            }
            
            return { 
              success: successCount > 0,
              updatedCount: successCount,
              totalClients: clients.length,
              lsn: initialLSN
            };
          }
        } as WSAction
      ]
    },
    
    // Step 5: Handle Catchup Sync
    {
      name: 'Handle Catchup Sync',
      execution: 'serial',
      actions: [
        {
          type: 'interactive',
          name: 'Wait for Catchup Sync',
          protocol: 'catchup-sync',
          maxTimeout: 180000, 
          
          initialAction: {
            type: 'ws',
            name: 'Initialize Catchup Tracking',
            operation: 'exec',
            params: async (context: OperationContext) => {
              // Initialize a simple set to track which clients have completed catchup
              context.state.clientsCompleted = new Set();
              
              context.logger.info(`Initialized simple catchup tracking for ${context.state.clients?.length || 0} clients`);
              return { success: true };
            }
          },
          
          handlers: {
            // Handle server changes during catchup
            'srv_catchup_changes': async (message: ServerChangesMessage, context: OperationContext, operations: Record<string, any>) => {
              const clientId = message.clientId || context.state.clients[0];
              
              context.logger.info(`Received catchup changes: chunk ${message.sequence?.chunk}/${message.sequence?.total} with ${message.changes?.length || 0} changes`);
              
              if (message.lastLSN) {
                context.state.lastLSN = message.lastLSN;
                
                // Update the client's LSN
                try {
                  await operations.ws.updateLSN(clientId, message.lastLSN);
                  context.logger.info(`Updated client LSN to ${message.lastLSN}`);
                } catch (error) {
                  context.logger.warn(`Failed to update client LSN: ${error}`);
                }
              }
              
              // Acknowledge receipt of the catchup chunk
              try {
                await operations.ws.sendMessage(
                  clientId, 
                  {
                    type: 'clt_catchup_received',
                    messageId: `catchup_ack_${Date.now()}`,
                    clientId,
                    timestamp: Date.now(),
                    chunk: message.sequence?.chunk || 1,
                    lsn: message.lastLSN || context.state.lastLSN || '0/0'
                  }
                );
                
                context.logger.info(`Acknowledged catchup chunk ${message.sequence?.chunk}/${message.sequence?.total}`);
              } catch (error) {
                context.logger.error(`Failed to acknowledge catchup: ${error}`);
              }
              
              // Don't complete the handler yet, wait for catchup completed message
              return false;
            },
            
            // Also handle heartbeats
            'srv_heartbeat': async (message: { type: string, clientId?: string }) => {
              return false; // Just ignore heartbeats
            },
            
            // Handle catchup completion
            'srv_catchup_completed': async (message: ServerCatchupCompletedMessage, context: OperationContext, operations: Record<string, any>) => {
              const clientId = message.clientId || context.state.clients[0];
              
              context.logger.info(`Catchup sync completed for client ${clientId}: finalLSN=${message.finalLSN}, changes=${message.changeCount}`);
              
              if (message.finalLSN) {
                // Store the LSN and update the client
                context.state.lastLSN = message.finalLSN;
                await operations.ws.updateLSN(clientId, message.finalLSN);
              }
              
              // Mark this client as complete
              context.state.clientsCompleted.add(clientId);
              
              const totalClients = context.state.clients?.length || 0;
              const completedCount = context.state.clientsCompleted.size;
              
              context.logger.info(`Catchup progress: ${completedCount}/${totalClients} clients complete`);
              
              // Complete when all clients are done
              if (completedCount >= totalClients) {
                context.logger.info(`All ${completedCount} clients have completed catchup sync`);
                return true;
              }
              
              return false; // Keep waiting for other clients
            }
          }
        } as InteractiveAction
      ]
    },
    
    // Step 6: Generate Changes
    {
      name: 'Generate Changes',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Generate Changes',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const changeCount = context.config.changeCount || 3;
            
            context.logger.info(`Generating ${changeCount} changes`);
            
            try {
              // First seed database with dependencies - users and projects first
              // Keep generation and application as separate steps
              const seedChanges = await operations.changes.generateChanges(5, {
                distribution: {
                  user: 0.5,  // Create users first
                  project: 0.5, // Create projects first
                  task: 0,
                  comment: 0
                },
                mode: 'seed'  // Insert only
              });
              
              // Apply seed changes
              const seedTableChanges = operations.changes.convertToTableChanges(seedChanges);
              await operations.changes.applyBatchChanges(seedTableChanges);
              
              context.logger.info('Seeded database with dependencies (users and projects)');
              
              // Now generate the actual test changes
              const generatedChanges = await operations.changes.generateChanges(changeCount, {
                distribution: {
                  user: 0.2,
                  project: 0.2,
                  task: 0.3,
                  comment: 0.3
                },
                useExistingIds: true, // Use existing entities for foreign keys
                operations: {
                  create: 0.6,
                  update: 0.3,
                  delete: 0.1
                }
              });
              
              // Store for the next step
              context.state.generatedChanges = generatedChanges;
              
              // Log change counts
              let totalChanges = 0;
              Object.entries(generatedChanges as GeneratedChanges).forEach(([entityType, entityOps]) => {
                const entityCount = entityOps.create.length + entityOps.update.length + entityOps.delete.length;
                if (entityCount > 0) {
                  context.logger.info(`Generated ${entityCount} changes for ${entityType}`);
                  totalChanges += entityCount;
                }
              });
              
              context.logger.info(`Successfully generated ${totalChanges} changes`);
              
              return {
                success: true,
                changeCount: totalChanges
              };
            } catch (error) {
              context.logger.error(`Error generating changes: ${error}`);
              context.state.shouldExit = true;
              return { success: false, error: String(error) };
            }
          }
        } as ChangesAction
      ]
    },
    
    // Step 7: Apply and Track Changes
    {
      name: 'Apply and Track Changes',
      execution: 'parallel',
      actions: [
        // Action 1: Apply the generated changes to the database
        {
          type: 'changes',
          name: 'Apply Generated Changes',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            try {
              // Get the generated changes from the previous step
              const generatedChanges = context.state.generatedChanges;
              
              if (!generatedChanges) {
                context.logger.error('No generated changes found from previous step');
                context.state.shouldExit = true;
                return { success: false, error: 'No generated changes available' };
              }
              
              // Convert to TableChange format
              context.logger.info('Converting generated changes to TableChange format');
              const tableChanges = await operations.changes.convertToTableChanges(generatedChanges);
              
              // Apply the changes to the database
              context.logger.info(`Applying ${tableChanges.length} changes to database`);
              
              // NOTE: applyBatchChanges already processes entities in dependency order
              // (users → projects → tasks → comments) inside a transaction
              const appliedChanges = await operations.changes.applyBatchChanges(tableChanges);
              
              // Store the applied changes for validation
              context.state.databaseChanges = appliedChanges;
              
              // Track the database changes for validation
              if (context.state.changeTracker) {
                context.state.changeTracker.trackDatabaseChanges(appliedChanges);
              }
              
              context.logger.info(`Successfully applied ${appliedChanges.length} changes to database`);
              
              return {
                success: true,
                changeCount: appliedChanges.length
              };
            } catch (error) {
              context.logger.error(`Error applying changes: ${error}`);
              context.state.shouldExit = true;
              return { success: false, error: String(error) };
            }
          }
        } as ChangesAction,
        
        // Action 2: Wait for changes across all clients
        {
          type: 'interactive',
          name: 'Wait for Change Messages on All Clients',
          protocol: 'live-changes',
          maxTimeout: 30000,
          
          initialAction: {
            type: 'ws',
            name: 'Initialize Change Tracking',
            operation: 'exec',
            params: async (context: OperationContext, operations: Record<string, any>) => {
              const clients = context.state.clients || [];
              const expectedChanges = context.config.changeCount || 3;
              
              // Use the existing ChangeTracker instance from beforeScenario
              const tracker = context.state.changeTracker;
              
              // Register clients with the tracker
              tracker.registerClients(clients, expectedChanges);
              
              // Listen for completion events from the tracker
              tracker.on('complete', () => {
                // Force completion using the message dispatcher
                messageDispatcher.dispatchMessage({
                  type: 'tracker_complete',
                  timestamp: Date.now()
                });
              });
              
              // Initialize timeout management
              context.state.lastChangeTime = Date.now();
              context.state.timeoutId = null;
              context.state.timeoutDuration = context.config.timeout || 90000; // Increased default timeout
              
              // Log expected changes with zero tolerance for debugging
              context.logger.info(`Setting up to wait for ${expectedChanges} changes on each of ${clients.length} clients (strict validation, no tolerance)`);
              
              return { success: true };
            }
          },
          
          handlers: {
            // Main handler for live changes from server
            'srv_live_changes': async (message: any, context: OperationContext, operations: Record<string, any>) => {
              const clientId = message.clientId;
              
              // Reset timeout since we received changes
              resetInactivityTimeout(context);
              
              // Use the processed changes instead of raw changes
              const changes = message._processedChanges || [];
              
              // Detailed logging of received change IDs
              if (changes.length > 0) {
                context.logger.info(`Received ${changes.length} changes from server for client ${clientId}`);
                
                // Generate a batch ID based on LSN and timestamp for traceability
                const batchId = `batch-${message.lastLSN || '0-0'}-${Date.now()}`;
                
                // Use the change tracker's batch tracking to track these changes
                context.state.changeTracker.trackChanges(clientId, changes, batchId);
                
                // Update last change time to now
                context.state.lastChangeTime = Date.now();
              }
              
              // Send acknowledgment to server
              try {
                await operations.ws.sendMessage(clientId, {
                  type: 'clt_changes_ack',
                  clientId,
                  lastLSN: message.lastLSN || '0/0',
                  timestamp: Date.now()
                });
              } catch (error) {
                context.logger.warn(`Error sending acknowledgment: ${error}`);
              }
              
              // Update LSN if available
              if (message.lastLSN) {
                operations.ws.updateLSN(clientId, message.lastLSN);
              }
              
              // Check if all clients have completed - if yes, return true to complete the protocol
              const isComplete = context.state.changeTracker.checkCompletion();
              
              if (isComplete) {
                // If complete, clear any pending timeout
                if (context.state.timeoutId) {
                  clearTimeout(context.state.timeoutId);
                  context.state.timeoutId = null;
                }
                return true;
              }
              
              return false;
            },
            
            // Handler for sync stats messages
            'srv_sync_stats': async (message: any, context: OperationContext, operations: Record<string, any>) => {
              const statsMsg = message as ServerSyncStatsMessage;
              const clientId = message.clientId;
              
              // Log detailed stats information for debugging
              context.logger.info(`Received sync stats for client ${clientId}, sync type: ${statsMsg.syncType}`);
              
              if (statsMsg.deduplicationStats) {
                const dedup = statsMsg.deduplicationStats;
                context.logger.info(`Deduplication: ${dedup.beforeCount} → ${dedup.afterCount} (${dedup.reductionPercent}% reduction)`);
                
                // Log deduplication reasons if available
                if (dedup.reasons && Object.keys(dedup.reasons).length > 0) {
                  context.logger.info(`Deduplication reasons: ${JSON.stringify(dedup.reasons)}`);
                }
              }
              
              if (statsMsg.filteringStats) {
                const filter = statsMsg.filteringStats;
                context.logger.info(`Filtering: ${filter.beforeCount} → ${filter.afterCount} (${filter.filtered} filtered)`);
                
                // Log filtering reasons if available
                if (filter.reasons && Object.keys(filter.reasons).length > 0) {
                  context.logger.info(`Filtering reasons: ${JSON.stringify(filter.reasons)}`);
                }
                
                // Log details of filtered changes for verification if available
                if (filter.filteredChanges && filter.filteredChanges.length > 0) {
                  const filteredByReason: Record<string, number> = {};
                  filter.filteredChanges.forEach(change => {
                    filteredByReason[change.reason] = (filteredByReason[change.reason] || 0) + 1;
                  });
                  
                  context.logger.info(`Filtered changes by reason: ${JSON.stringify(filteredByReason)}`);
                  
                  // If there aren't too many, show details of each filtered change
                  if (filter.filteredChanges.length <= 10) {
                    filter.filteredChanges.forEach(change => {
                      context.logger.info(`  - Filtered: ${change.table}/${change.id} (${change.reason})`);
                    });
                  } else {
                    // Otherwise just show the first few
                    filter.filteredChanges.slice(0, 5).forEach(change => {
                      context.logger.info(`  - Filtered: ${change.table}/${change.id} (${change.reason})`);
                    });
                    context.logger.info(`  - And ${filter.filteredChanges.length - 5} more filtered changes...`);
                  }
                }
              }
              
              if (statsMsg.contentStats) {
                const content = statsMsg.contentStats;
                if (content.operations) {
                  context.logger.info(`Operations: ${JSON.stringify(content.operations)}`);
                }
                if (content.tables) {
                  context.logger.info(`Tables: ${JSON.stringify(content.tables)}`);
                }
              }
              
              if (statsMsg.performanceStats) {
                context.logger.info(`Processing time: ${statsMsg.performanceStats.processingTimeMs}ms`);
              }
              
              // Stats messages don't affect completion status, just log them
              return false;
            },
            
            // Handler for tracker complete event
            'tracker_complete': (message: any, context: OperationContext) => {
              // Clear any pending timeout
              if (context.state.timeoutId) {
                clearTimeout(context.state.timeoutId);
                context.state.timeoutId = null;
              }
              
              context.logger.info(`All clients have received all expected changes!`);
              return true; // Complete the protocol
            },
            
            // Handler for timeout
            'timeout_force_completion': (message: any, context: OperationContext) => {
              // Clear any pending timeout to avoid duplicates
              if (context.state.timeoutId) {
                clearTimeout(context.state.timeoutId);
                context.state.timeoutId = null;
              }
              
              const progress = context.state.changeTracker?.getProgressSummary() || 'unknown';
              const lastChangeSecs = (Date.now() - context.state.lastChangeTime) / 1000;
              context.logger.warn(`Inactivity timeout after ${lastChangeSecs.toFixed(1)}s since last change. Progress: ${progress}`);
              
              // Get detailed information about missing changes for debugging
              try {
                // Get missing changes per client
                const missingByClient: Record<string, Array<any>> = {};
                const receivedByClient: Record<string, Record<string, boolean>> = {};
                
                // Initialize trackers
                context.state.clients.forEach((clientId: string) => {
                  const received = context.state.changeTracker.getClientChanges(clientId) || [];
                  receivedByClient[clientId] = {};
                  received.forEach((change: any) => {
                    receivedByClient[clientId][change.id] = true;
                  });
                });
                
                // Get all database changes
                const dbChanges = context.state.changeTracker.getDatabaseChanges() || [];
                
                // Find missing changes per client
                context.state.clients.forEach((clientId: string) => {
                  missingByClient[clientId] = dbChanges.filter(
                    (change: any) => !receivedByClient[clientId][change.id]
                  );
                });
                
                // Log detailed missing change information
                Object.entries(missingByClient).forEach(([clientId, missing]) => {
                  if (missing.length > 0) {
                    context.logger.warn(`Client ${clientId} missing ${missing.length} changes:`);
                    missing.slice(0, 5).forEach((change: any) => {
                      context.logger.info(`  - ${change.id} (${change.type}, ${change.operation})`);
                    });
                    if (missing.length > 5) {
                      context.logger.info(`  - And ${missing.length - 5} more missing changes...`);
                    }
                  }
                });
              } catch (error) {
                context.logger.error(`Error getting missing changes: ${error}`);
              }
              
              return true; // Complete the protocol
            }
          }
        } as InteractiveAction
      ]
    },
    
    // Step 8: Validate Changes and WAL
    {
      name: 'Validate Changes and WAL',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Verify Changes in Database and Change History',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            context.logger.info('Starting comprehensive change verification...');
            
            // Get all the changes we applied
            const changes = context.state.generatedChanges || [];
            if (!changes.length) {
              context.logger.warn('No generated changes found to verify');
              return { success: false, error: 'No changes to verify' };
            }
            
            // Get start and end LSN
            const startLSN = context.state.initialLSN || '0/0';
            const currentLSN = await operations.changes.getCurrentLSN();
            
            context.logger.info(`Verifying changes between LSN ${startLSN} and ${currentLSN}`);
            
            try {
              // Get changes from change_history table to verify they were captured
              const changesHistory = await operations.changes.queryChangeHistory(startLSN, currentLSN);
              
              // Count changes by table and operation
              const changesByTable: Record<string, {created: number, updated: number, deleted: number}> = {};
              
              for (const change of changesHistory) {
                if (!changesByTable[change.table_name]) {
                  changesByTable[change.table_name] = { created: 0, updated: 0, deleted: 0 };
                }
                // Map operation types to counter keys
                const operationKey = change.operation === 'insert' ? 'created' :
                                    change.operation === 'update' ? 'updated' : 'deleted';
                changesByTable[change.table_name][operationKey]++;
              }
              
              // Log the breakdown of changes in the history table
              context.logger.info('Changes captured in change_history table:');
              Object.entries(changesByTable).forEach(([table, counts]) => {
                context.logger.info(`  ${table}: ${counts.created} created, ${counts.updated} updated, ${counts.deleted} deleted`);
              });
              
              // Check for expected tables
              const trackedTables = ['users', 'projects', 'tasks', 'comments'];
              const missingTables = trackedTables.filter(table => !changesByTable[table]);
              
              if (missingTables.length > 0) {
                context.logger.error(`Missing change records for tables: ${missingTables.join(', ')}`);
                context.logger.info('This suggests these tables are not being tracked in WAL or not being processed correctly');
              } else {
                context.logger.info('All expected tables have change records in the history table');
              }
              
              // Compare with our tracker's database changes
              if (context.state.changeTracker) {
                const trackerDbChanges = context.state.changeTracker.getDatabaseChanges() || [];
                const trackerDbChangesByTable: Record<string, number> = {};
                
                trackerDbChanges.forEach((change: TableChange) => {
                  const table = change.table || 'unknown';
                  trackerDbChangesByTable[table] = (trackerDbChangesByTable[table] || 0) + 1; 
                });
                
                context.logger.info('Changes tracked in our ChangeTracker:');
                Object.entries(trackerDbChangesByTable).forEach(([table, count]) => {
                  context.logger.info(`  ${table}: ${count}`);
                });
                
                // Compare with what's in the database history
                const totalHistoryChanges = Object.values(changesByTable).reduce(
                  (sum, counts) => sum + counts.created + counts.updated + counts.deleted, 0
                );
                const totalTrackerChanges = Object.values(trackerDbChangesByTable).reduce(
                  (sum, count) => sum + count, 0
                );
                
                context.logger.info(`Total changes in history: ${totalHistoryChanges}, in tracker: ${totalTrackerChanges}`);
                
                if (totalHistoryChanges !== totalTrackerChanges) {
                  context.logger.warn(`Mismatch between changes in history table and tracker`);
                  
                  // Check if some tables are present in tracker but not in history
                  const tablesOnlyInTracker = Object.keys(trackerDbChangesByTable)
                    .filter(table => !changesByTable[table]);
                  
                  if (tablesOnlyInTracker.length > 0) {
                    context.logger.error(`Tables in tracker but not in history: ${tablesOnlyInTracker.join(', ')}`);
                    context.logger.info('These tables may not be tracked in the server WAL configuration');
                  }
                }
              }
              
              return {
                success: true,
                changesByTable,
                historyCount: changesHistory.length,
                message: 'Change verification completed'
              };
            } catch (error) {
              context.logger.error(`Error verifying changes: ${error}`);
              return { 
                success: false, 
                error: String(error)
              };
            }
          }
        } as ChangesAction,
        
        // Original validation action
        {
          type: 'validation',
          name: 'Validate Changes',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            context.logger.info(`Validating synchronized changes`);
            
            // Use the existing ChangeTracker from beforeScenario
            const tracker = context.state.changeTracker;
            
            // Get the validation report from the tracker
            const trackerReport = tracker.getValidationReport();
            
            // Log the validation report with detailed information
            context.logger.info(`Validation Summary:`);
            context.logger.info(`- Database changes: ${trackerReport.databaseChanges}`);
            context.logger.info(`- Total received changes: ${trackerReport.receivedChanges}`);
            context.logger.info(`- Unique records changed: ${trackerReport.uniqueRecordsChanged}`);
            context.logger.info(`- Unique records received: ${trackerReport.uniqueRecordsReceived}`);
            context.logger.info(`- Exact match count: ${trackerReport.exactMatchCount}`);
            context.logger.info(`- Potential deduplications: ${trackerReport.deduplicatedChanges}`);
            
            // Get deduplication information
            const deduplication = tracker.analyzeDuplication();
            if (deduplication.duplicatedIds > 0) {
              context.logger.info(`Deduplication analysis: ${deduplication.duplicatedIds} IDs had multiple changes (${Math.round(deduplication.duplicationRate * 100)}% duplication rate)`);
            }
            
            // Focus on real missing changes not affected by deduplication
            if (trackerReport.realMissingChanges.length > 0) {
              context.logger.error(`Found ${trackerReport.realMissingChanges.length} changes missing from clients (not related to deduplication)`);
              
              // Analyze missing changes by type
              const missingByType: Record<string, number> = {};
              trackerReport.realMissingChanges.forEach((change: TableChange) => {
                const type = change.table || 'unknown';
                missingByType[type] = (missingByType[type] || 0) + 1;
              });
              
              // Log missing changes by type
              context.logger.error(`Missing changes by type: ${
                Object.entries(missingByType)
                  .map(([type, count]) => `${type}: ${count}`)
                  .join(', ')
              }`);
              
              // Force the test to fail if we have real missing changes
              return { 
                success: false,
                error: `Test failed: ${trackerReport.realMissingChanges.length} changes missing`,
                report: trackerReport,
                deduplication
              };
            }
            
            // The report includes success status based on validation rules in the tracker
            const success = trackerReport.success;
            
            // Store validation results in context state for reference
            context.state.validationResults = {
              report: trackerReport,
              success,
              deduplication
            };
            
            return { 
              success,
              report: trackerReport,
              deduplication
            };
          }
        } as ValidationAction
      ]
    },
    
    // Step 9: Disconnect Clients
    {
      name: 'Disconnect Clients',
      execution: 'serial',
      actions: [
        {
          type: 'ws',
          name: 'Disconnect All WebSocket Clients',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const clients = context.state.clients || [];
            context.logger.info(`Disconnecting ${clients.length} WebSocket clients`);
            
            // Function to disconnect a client with timeout and robust error handling
            const disconnectWithTimeout = async (clientId: string, index: number): Promise<boolean> => {
              try {
                // Use getClientStatus to validate client first
                const status = operations.ws.getClientStatus(clientId);
                
                if (status === 'connected') {
                  context.logger.info(`Disconnecting client ${index+1}/${clients.length}: ${clientId}`);
                  
                  // Create a timeout promise that resolves after 10 seconds
                  const timeoutPromise = new Promise<boolean>(resolve => {
                    setTimeout(() => {
                      context.logger.warn(`Timeout disconnecting client ${clientId}, forcing cleanup`);
                      resolve(false);
                    }, 10000);
                  });
                  
                  // Create the disconnect promise
                  const disconnectPromise = operations.ws.disconnectClient(clientId)
                    .then(() => {
                      context.logger.info(`Client ${clientId} disconnected gracefully`);
                      return true;
                    })
                    .catch((error: Error) => {
                      context.logger.error(`Error disconnecting client ${clientId}: ${error}`);
                      return false;
                    });
                  
                  // Race the promises to handle timeouts
                  const success = await Promise.race([disconnectPromise, timeoutPromise]);
                  
                  if (!success) {
                    // If we failed or timed out, try to force disconnect
                    try {
                      await operations.ws.removeClient(clientId);
                      context.logger.info(`Force removed client ${clientId}`);
                    } catch (removeError) {
                      context.logger.error(`Even force remove failed for client ${clientId}: ${removeError}`);
                    }
                  }
                  
                  return success;
                } else {
                  context.logger.info(`Client ${clientId} is not connected (status: ${status}), skipping disconnect`);
                  return true;
                }
              } catch (error) {
                context.logger.warn(`Error processing client ${clientId}: ${error}`);
                return false;
              }
            };
            
            // Filter out invalid clients
            const validClientIds: string[] = [];
            
            for (const clientId of clients) {
              try {
                const status = operations.ws.getClientStatus(clientId);
                context.logger.info(`Client ${clientId} status: ${status}`);
                validClientIds.push(clientId);
              } catch (err) {
                context.logger.warn(`Client ${clientId} is not valid: ${err}`);
              }
            }
            
            // Disconnect each client sequentially to avoid race conditions
            for (let i = 0; i < validClientIds.length; i++) {
              await disconnectWithTimeout(validClientIds[i], i);
            }
            
            context.logger.info('Client disconnection complete');
            
            // Ensure any tracked clients are removed from profiles
            return { success: true };
          }
        } as WSAction
      ]
    }
  ]
};

// Register this scenario with the default export
export default LiveSyncScenario;

/**
 * Run a live sync test with multiple clients
 * @param clientCount Number of clients to run in parallel
 * @param changeCount Number of changes to create per client
 */
export async function runLiveSyncTest(clientCount: number = 1, changeCount: number = 10): Promise<any[]> {
  logger.info(`Starting live sync test with ${clientCount} clients and ${changeCount} changes`);
  
  // Configure the scenario
  const scenario = { ...LiveSyncScenario };
  scenario.config.changeCount = changeCount;
  
  // Ensure customProperties exists before setting
  if (!scenario.config.customProperties) {
    scenario.config.customProperties = {};
  }
  scenario.config.customProperties.clientCount = clientCount;
  
  // Create and run the scenario
  const runner = new ScenarioRunner();
  
  try {
    // Create a state object to capture results
    const state: Record<string, any> = {};
    
    // Add afterScenario hook to clean up resources
    if (!scenario.hooks) {
      scenario.hooks = {};
    }
    
    // Save the original afterScenario if it exists
    const originalAfterScenario = scenario.hooks.afterScenario;
    
    // Add our own afterScenario that captures results and performs cleanup
    scenario.hooks.afterScenario = async (context) => {
      // Run the original hook if it exists
      if (originalAfterScenario) {
        await originalAfterScenario(context);
      }
      
      // Capture the results
      state.results = context.state.results;
      
      // Perform explicit cleanup
      await cleanupResources(context);
    };
    
    // Run the scenario
    await runner.runScenario(scenario);
    
    // Return the results stored in state
    return state.results || [{ success: true }];
  } catch (error) {
    logger.error(`Test failed: ${error instanceof Error ? error.message : String(error)}`);
    return [{ success: false, error: String(error) }];
  }
}

/**
 * Clean up all resources to ensure the process can exit properly
 * This is crucial to avoid hanging processes due to active handles
 */
async function cleanupResources(context: any): Promise<void> {
  logger.info('Performing final cleanup of resources...');
  
  try {
    // Clear any active timeouts
    if (context.state.timeoutId) {
      clearTimeout(context.state.timeoutId);
      context.state.timeoutId = null;
    }
    
    // Clean up message dispatcher handlers
    ['srv_live_changes', 'srv_catchup_changes', 'srv_catchup_completed', 
     'srv_sync_stats', 'srv_heartbeat', 'tracker_complete', 'timeout_force_completion'].forEach(type => {
      try {
        messageDispatcher.removeAllHandlers(type);
        logger.debug(`Removed all handlers for message type: ${type}`);
      } catch (e) {
        // Ignore errors during cleanup
      }
    });
    
    // Clean up any remaining event listeners
    context.runner.removeAllListeners();
    
    // If we have a ChangeTracker, remove all its listeners
    if (context.state.changeTracker) {
      context.state.changeTracker.removeAllListeners();
    }
    
    // Clean up any remaining WebSocket connections
    if (context.state.clients && Array.isArray(context.state.clients)) {
      const operations = context.operations || {};
      if (operations.ws && operations.ws.removeClient) {
        for (const clientId of context.state.clients) {
          try {
            // Force terminate the client
            await operations.ws.removeClient(clientId);
            logger.debug(`Force cleaned up WebSocket client: ${clientId}`);
          } catch (e) {
            // Ignore errors during cleanup
          }
        }
      }
    }
    
    // Clear the MessageProcessor cache
    if (context.messageProcessor && typeof context.messageProcessor.clearCache === 'function') {
      context.messageProcessor.clearCache();
    }
    
    logger.info('Resource cleanup completed');
  } catch (error) {
    logger.warn(`Error during cleanup: ${error}`);
  }
}

// If run directly from command line (not imported)
if (typeof import.meta !== 'undefined' && import.meta.url) {
  // This is a more reliable way to check if this module is the main entry point
  // rather than being imported by another module like the CLI
  
  // Check if the file was executed directly by checking argv
  const isDirectCommandExecution = process.argv[1] && 
    (process.argv[1].endsWith('live-sync.ts') || process.argv[1].includes('live-sync.ts'));
    
  if (isDirectCommandExecution) {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const clientCount = parseInt(args[0] || '1', 10);
    const changeCount = parseInt(args[1] || '5', 10);
    
    logger.info(`Starting live sync test with ${clientCount} clients and ${changeCount} changes from direct command line execution`);
    
    runLiveSyncTest(clientCount, changeCount)
      .then(results => {
        // Check if any test failed
        const anyFailed = results.some(result => !result.success);
        
        // Log summary
        if (!anyFailed) {
          logger.info('✅ Live sync test completed successfully!');
        } else {
          logger.error('❌ Live sync test failed!');
        }
        
        // Force exit after a short delay to ensure logs are flushed
        setTimeout(() => {
          logger.info('Test completed, forcing exit in 1 second...');
          process.exit(anyFailed ? 1 : 0);
        }, 1000);
      })
      .catch(error => {
        console.error('Test failed:', error);
        process.exit(1);
      });
  } else {
    logger.debug('Live sync test module imported by another module, not running automatically');
  }
}

/**
 * Main live sync test definition
 */
export function liveSyncTest(
  clients: number = 1, 
  count: number = 3,
  options: LiveSyncOptions = {}
): Scenario {
  // Implementation of the function
  // This is a placeholder and should be replaced with the actual implementation
  throw new Error('liveSyncTest function not implemented');
}
