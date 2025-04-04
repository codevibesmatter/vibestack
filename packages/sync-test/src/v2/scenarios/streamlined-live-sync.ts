// Load environment variables
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Determine the correct path to .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Go up 3 directories: /scenarios -> /v2 -> /src -> /sync-test (root)
const rootDir = resolve(__dirname, '../../../');
// Load the environment variables
dotenv.config({ path: resolve(rootDir, '.env') });

import { DB_TABLES, TEST_DEFAULTS } from '../config.ts';
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
import { messageDispatcher } from '../core/message-dispatcher.ts';
import type {
  ServerChangesMessage,
  ServerCatchupCompletedMessage,
  TableChange
} from '@repo/sync-types';

// Import core sync modules
import { initialize as initializeDatabase } from '../core/entity-changes/index.ts';
import { generateAndApplyMixedChanges } from '../core/entity-changes/batch-changes.ts';
import { ChangeTracker } from '../core/entity-changes/change-tracker.ts';
import { DataSource, Logger } from 'typeorm';
import { serverEntities } from '@repo/dataforge/server-entities';

// Logger for this module
const logger = createLogger('streamlined-live-sync');

// Create a silent logger that doesn't log anything
class SilentLogger implements Logger {
  logQuery() {}
  logQueryError() {}
  logQuerySlow() {}
  logSchemaBuild() {}
  logMigration() {}
  log() {}
}

// Create a DataSource instance for database operations
const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: serverEntities,
  synchronize: false,
  logging: false,
  logger: new SilentLogger()
});

// Define additional types for tracking
interface LsnRange {
  batch: number;
  min: string;
  max: string;
  count?: number;
}

interface ExtendedTableChange extends TableChange {
  lsn: string;
}

/**
 * Streamlined Live Sync Test Scenario
 * 
 * A simplified version of the live sync test that leverages improved server-side sync
 * and uses the new batch changes system
 */
export const StreamlinedLiveSyncScenario: Scenario = {
  name: 'Streamlined Live Sync Test',
  description: 'Tests the live sync capability with improved server communication',
  config: {
    timeout: 30000,
    changeCount: 5,
    customProperties: {
      clientCount: 1
    }
  },
  
  hooks: {
    beforeScenario: async (context) => {
      context.logger.info(`Starting streamlined live sync test with ${context.config.customProperties?.clientCount || 1} clients and ${context.config.changeCount} changes`);
      
      // Register message handlers for interactive steps
      messageDispatcher.registerHandler('srv_live_changes', () => false);
      messageDispatcher.registerHandler('srv_catchup_completed', () => false);
      
      // Initialize a change tracker in the context
      context.state.changeTracker = new ChangeTracker({
        tolerance: 0,
        deduplicationEnabled: true,
        batchSize: 100
      });
      
      // Track changes across batches to identify duplicates
      context.state.allReceivedChangesById = new Map<string, any>();
      context.state.duplicateChanges = [] as Array<{
        key: string;
        current: {
          lsn?: string;
          txid?: string;
          timestamp?: string;
        };
        previous: {
          lsn?: string;
          txid?: string;
          timestamp?: string;
        }
      }>;
      
      // Function to track and detect duplicates
      context.state.trackAndDetectDuplicates = (changes: any[]): number => {
        const newDuplicates: Array<{
          key: string;
          current: {
            lsn?: string;
            txid?: string;
            timestamp?: string;
          };
          previous: {
            lsn?: string;
            txid?: string;
            timestamp?: string;
          };
        }> = [];
        
        changes.forEach(change => {
          const id = change.data?.id;
          if (!id) return;
          
          const key = `${change.table}:${id}:${change.operation}`;
          
          if (context.state.allReceivedChangesById.has(key)) {
            // This is a duplicate!
            const previousChange = context.state.allReceivedChangesById.get(key);
            newDuplicates.push({
              key,
              current: {
                lsn: change.lsn, 
                txid: change.txid,
                timestamp: change.updated_at
              },
              previous: {
                lsn: previousChange.lsn,
                txid: previousChange.txid,
                timestamp: previousChange.updated_at
              }
            });
          }
          
          // Store this change for future duplicate detection
          context.state.allReceivedChangesById.set(key, change);
        });
        
        // If we found duplicates, log them
        if (newDuplicates.length > 0) {
          context.logger.warn(`Found ${newDuplicates.length} duplicate changes in this batch!`);
          newDuplicates.forEach(dup => {
            context.logger.warn(`Duplicate ${dup.key}: 
              Current:  LSN=${dup.current.lsn || 'none'}, TXID=${dup.current.txid || 'none'}, Time=${dup.current.timestamp || 'none'}
              Previous: LSN=${dup.previous.lsn || 'none'}, TXID=${dup.previous.txid || 'none'}, Time=${dup.previous.timestamp || 'none'}`);
          });
          
          context.state.duplicateChanges.push(...newDuplicates);
        }
        
        return newDuplicates.length;
      };
    }
  },
  
  steps: [
    // Step 1: Initialize Database
    {
      name: 'Initialize Environment',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Initialize Database',
          operation: 'exec',
          params: async (context: OperationContext) => {
            context.logger.info('Initializing database for live sync test');
            
            try {
              const initialized = await initializeDatabase(dataSource);
              
              if (!initialized) {
                context.logger.error('Failed to initialize database');
                return { success: false, error: 'Database initialization failed' };
              }
              
              context.logger.info('Database initialized successfully');
              return { success: true };
            } catch (error) {
              context.logger.error(`Error initializing database: ${error}`);
              return { success: false, error: String(error) };
            }
          }
        } as ChangesAction,
        {
          type: 'api',
          name: 'Initialize Server Replication',
          endpoint: '/api/replication/init',
          method: 'POST',
          responseHandler: async (response: any, context: OperationContext) => {
            if (response && response.lsn) {
              context.state.initialLSN = response.lsn;
              context.logger.info(`Retrieved initial replication LSN: ${response.lsn}`);
            }
            return response;
          }
        } as ApiAction
      ]
    },
    
    // Step 2: Set Up Clients
    {
      name: 'Set Up Clients',
      execution: 'serial',
      actions: [
        {
          type: 'ws',
          name: 'Create and Setup WebSocket Clients',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const clientCount = context.config.customProperties?.clientCount || 1;
            context.logger.info(`Creating ${clientCount} WebSocket clients`);
            
            try {
              // Create new clients directly using operations
              const clients = [];
              for (let i = 0; i < clientCount; i++) {
                const profileId = i + 1;
                const clientId = await operations.ws.createClient(profileId);
                clients.push(clientId);
                
                // Set up the client (connect to server)
                await operations.ws.setupClient(clientId);
                context.logger.info(`Created and set up client ${clientId} with profile ${profileId}`);
              }
              
              // Store clients in context for later use
              context.state.clients = clients;
              
              // Register clients with the change tracker
              if (context.state.changeTracker) {
                context.state.changeTracker.registerClients(clients);
                context.logger.info(`Registered ${clients.length} clients with the ChangeTracker`);
              }
              
              return { success: true, clients };
            } catch (error) {
              context.logger.error(`Error creating clients: ${error}`);
              return { success: false, error: String(error) };
            }
          }
        } as WSAction
      ]
    },
    
    // Step 3: Handle Catchup Sync
    {
      name: 'Wait For Catchup Sync',
      execution: 'serial',
      actions: [
        {
          type: 'interactive',
          name: 'Wait for Catchup Sync',
          protocol: 'catchup-sync',
          maxTimeout: 10000, // 10 seconds should be enough for catchup
          
          handlers: {
            // Handle server changes during catchup
            'srv_catchup_changes': async (message: ServerChangesMessage, context: OperationContext, operations: Record<string, any>) => {
              const clientId = message.clientId || context.state.clients[0];
              
              context.logger.info(`Received catchup changes: chunk ${message.sequence?.chunk}/${message.sequence?.total} with ${message.changes?.length || 0} changes`);
              
              // We intentionally don't track or validate catchup changes.
              // These are historical changes from previous runs that clients need to get current.
              
              // Acknowledge receipt of the catchup chunk
              await operations.ws.sendMessage(
                clientId, 
                {
                  type: 'clt_catchup_received',
                  messageId: `catchup_ack_${Date.now()}`,
                  clientId,
                  timestamp: Date.now(),
                  chunk: message.sequence?.chunk || 1,
                  lsn: message.lastLSN || '0/0'
                }
              );
              
              return false; // Keep waiting for more messages
            },
            
            // Handle catchup completion from server
            'srv_catchup_completed': async (message: any, context: OperationContext) => {
              const clientId = message.clientId;
              context.logger.info(`Catchup sync completed for client ${clientId}`);
              
              // Server now automatically updates LSN, no need for manual handling
              return true; // Signal completion
            }
          }
        } as InteractiveAction
      ]
    },
    
    // Step 4: Set up change tracking and generate changes in parallel
    {
      name: 'Set Up Tracking and Generate Changes',
      execution: 'parallel', // Run actions in parallel
      actions: [
        // Action 1: Set up change tracking
        {
          type: 'interactive',
          name: 'Track Live Changes',
          protocol: 'live-changes',
          maxTimeout: 60000, // Increased timeout to 60 seconds
          
          initialAction: {
            type: 'ws',
            name: 'Initialize Live Change Tracking',
            operation: 'exec',
            params: async (context: OperationContext) => {
              // Initialize tracking objects
              context.state.receivedChanges = {} as Record<string, any[]>;
              context.state.clients.forEach((clientId: string) => {
                context.state.receivedChanges[clientId] = [];
              });
              
              // Initialize batch tracking
              context.state.batchesSeen = 0;
              context.state.noMoreChanges = false;
              // Track last batch time to reset timeout
              context.state.lastBatchTime = Date.now();
              context.state.inactivityTimeout = 15000; // 15 seconds of inactivity before considering sync complete
              
              context.logger.info(`Setting up change tracking before generating changes`);
              
              return { success: true };
            }
          },
          
          handlers: {
            // Handle live changes from server
            'srv_live_changes': async (message: ServerChangesMessage, context: OperationContext, operations: Record<string, any>) => {
              const clientId = message.clientId;
              const changes = message.changes || [];
              
              // Update the last batch time whenever we receive changes
              context.state.lastBatchTime = Date.now();
              
              if (changes.length > 0) {
                // Track batch statistics
                context.state.batchesSeen = (context.state.batchesSeen || 0) + 1;
                
                context.logger.info(`Received batch #${context.state.batchesSeen} with ${changes.length} live changes for client ${clientId}`);
                
                // Summarized logging of changes - group by table and operation
                const changesByTableOp = changes.reduce((acc, change) => {
                  const key = `${change.table}:${change.operation}`;
                  if (!acc[key]) acc[key] = [];
                  acc[key].push(change);
                  return acc;
                }, {} as Record<string, any[]>);

                context.logger.info('===== CHANGE SUMMARY =====');
                Object.entries(changesByTableOp).forEach(([tableOp, tableChanges]: [string, any[]]) => {
                  const [table, operation] = tableOp.split(':');
                  context.logger.info(`${table}: ${operation} - ${tableChanges.length} changes`);
                  
                  // Only log IDs if there are 5 or fewer
                  if (tableChanges.length <= 5) {
                    const ids = tableChanges.map(c => {
                      const id = c.data?.id || 'no-id';
                      return typeof id === 'string' ? id.substring(0, 8) : id;
                    }).join(', ');
                    context.logger.info(`  IDs: ${ids}`);
                  }
                });
                
                // Check for matches with our database changes
                if (context.state.databaseChanges) {
                  const matches = changes.filter(change => 
                    context.state.databaseChanges.some((dbChange: TableChange) => 
                      dbChange.table === change.table && 
                      dbChange.operation === change.operation && 
                      dbChange.data?.id === change.data?.id
                    )
                  );
                  
                  context.logger.info(`Matches with our applied changes: ${matches.length}/${changes.length}`);
                  if (matches.length > 0 && matches.length <= 5) {
                    const matchIds = matches.map(m => {
                      const id = m.data?.id || 'no-id';
                      return typeof id === 'string' ? id.substring(0, 8) : id;
                    }).join(', ');
                    context.logger.info(`  Matched IDs: ${matchIds}`);
                  }
                }
                context.logger.info('===== END SUMMARY =====');
                
                // Track changes in our simplified approach
                if (!context.state.receivedChanges[clientId]) {
                  context.state.receivedChanges[clientId] = [];
                }
                context.state.receivedChanges[clientId].push(...changes);
                
                // Track changes in the change tracker
                if (context.state.changeTracker) {
                  context.state.changeTracker.trackChanges(clientId, changes);
                  
                  // Log progress from the change tracker
                  const progress = context.state.changeTracker.getClientProgress(clientId);
                  if (progress) {
                    context.logger.info(`Client ${clientId} has received ${progress.current}/${progress.expected} changes (${((progress.current / progress.expected) * 100).toFixed(1)}%)`);
                  }
                }
                
                // Track duplicates across batches
                if (context.state.trackAndDetectDuplicates) {
                  const duplicateCount = context.state.trackAndDetectDuplicates(changes);
                  if (duplicateCount > 0) {
                    context.logger.warn(`Detected ${duplicateCount} duplicates out of ${changes.length} changes in this batch`);
                  }
                }
                
                // Send acknowledgment
                await operations.ws.sendMessage(clientId, {
                  type: 'clt_changes_ack',
                  clientId,
                  timestamp: Date.now()
                });
                
                // Check if all expected changes have been received by this client
                if (context.state.changeTracker && context.state.databaseChangesApplied) {
                  const allReceived = context.state.changeTracker.getCompletionStats().percentComplete >= 100;
                  if (allReceived) {
                    context.logger.info(`All clients have received 100% of expected changes. Protocol complete.`);
                    context.state.noMoreChanges = true;
                    return true; // Signal completion to the protocol handler
                  }
                }
              } else {
                // Empty batch - send acknowledgment and continue
                await operations.ws.sendMessage(clientId, {
                  type: 'clt_changes_ack',
                  clientId,
                  timestamp: Date.now()
                });
              }
              
              // Complete if signaled or if we've received all expected changes
              if (context.state.noMoreChanges) {
                return true;
              }
              
              // Don't complete until database changes have been applied and we have expected counts
              if (!context.state.databaseChangesApplied) {
                return false;
              }
              
              return false; // Continue waiting for changes
            },
            
            // Allow timeout to complete naturally
            'timeout': async (message: any, context: OperationContext) => {
              const currentTime = Date.now();
              const timeSinceLastBatch = currentTime - (context.state.lastBatchTime || 0);
              
              // Only consider it a timeout if we've had no activity for the inactivity period
              if (timeSinceLastBatch > context.state.inactivityTimeout) {
                context.logger.info(`Protocol timeout reached after ${timeSinceLastBatch/1000} seconds of inactivity`);
                return true;
              }
              
              // Otherwise, extend the timeout if we're still receiving changes
              context.logger.info(`Extending timeout - last batch was ${timeSinceLastBatch/1000} seconds ago`);
              return false; // Continue waiting for changes
            }
          }
        } as InteractiveAction,
        
        // Action 2: Generate and apply changes
        {
          type: 'changes',
          name: 'Generate and Apply Changes',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            // Use the specified changeCount from config
            const changeCount = context.config.changeCount || 5;
            context.logger.info(`Generating and applying ${changeCount} changes with the updated batch system`);

            try {
              // Get current LSN before applying changes
              try {
                const preLSN = await operations.changes.getCurrentLSN();
                context.logger.info(`Current LSN before applying changes: ${preLSN}`);
              } catch (e) {
                context.logger.warn(`Could not get pre-change LSN: ${e}`);
              }
              
              // Generate and apply changes using the updated batch changes system
              // For mixed mode, always use a fixed batch size of 20 with exactly one delete operation
              const appliedResult = await generateAndApplyMixedChanges(
                changeCount, 
                'mixed' // Use mixed mode for a mix of operations (create/update/delete)
              );
              
              // Extract changes and duplicates from the result
              const appliedChanges = appliedResult.changes;
              const intentionalDuplicates = appliedResult.duplicates;
              
              // Store the duplicates for validation
              context.state.intentionalDuplicates = intentionalDuplicates;
              
              // Get current LSN after applying changes
              try {
                const postLSN = await operations.changes.getCurrentLSN();
                context.logger.info(`Current LSN after applying changes: ${postLSN}`);
              } catch (e) {
                context.logger.warn(`Could not get post-change LSN: ${e}`);
              }
              
              // Store all applied changes in state for validation
              context.state.databaseChanges = appliedChanges;
              context.state.totalChangesCount = appliedChanges.length;
              
              // Count changes per table and operation type for logging
              const changesByTableOp = appliedChanges.reduce((acc: Record<string, Record<string, number>>, change: TableChange) => {
                const tableName = change.table || 'unknown';
                const operation = change.operation || 'unknown';
                
                if (!acc[tableName]) {
                  acc[tableName] = {};
                }
                
                acc[tableName][operation] = (acc[tableName][operation] || 0) + 1;
                return acc;
              }, {});
              
              // Log change summary by table and operation
              context.logger.info('Applied changes summary:');
              Object.entries(changesByTableOp).forEach(([table, operations]: [string, Record<string, number>]) => {
                const opsDesc = Object.entries(operations)
                  .map(([op, count]) => `${op}:${count}`)
                  .join(', ');
                  
                context.logger.info(`- ${table}: ${opsDesc}`);
              });
              
              // Set expected changes for clients in the change tracker
              if (context.state.changeTracker) {
                // Count intentional duplicates
                const expectedDedupCount = intentionalDuplicates.length;
                
                // Calculate expected count after deduplication
                const rawChangeCount = appliedChanges.length;
                const expectedChangeCount = rawChangeCount - expectedDedupCount;
                
                context.state.clients.forEach((clientId: string) => {
                  context.state.changeTracker.setClientExpectedCount(clientId, expectedChangeCount);
                });
                context.logger.info(`Set expected change count of ${expectedChangeCount} for all clients in ChangeTracker (${rawChangeCount} raw changes - ${expectedDedupCount} intentional duplicates)`);
              }
              
              // Track the database changes in our change tracker with batch identifier
              if (context.state.changeTracker) {
                // Use a meaningful batch identifier including timestamp
                const batchId = `main-batch-${Date.now()}`;
                context.state.changeTracker.trackDatabaseChangesWithBatch(appliedChanges, batchId);
                context.logger.info(`Tracked ${appliedChanges.length} database changes in ChangeTracker with batch identifier ${batchId}`);
                
                // Store the batch ID for reference
                context.state.mainBatchId = batchId;
              }
              
              // Set the database changes applied flag to true
              context.state.databaseChangesApplied = true;
              
              // Update the expected count for the UI
              if (context.state.tableChanges) {
                const expectedCount = context.state.tableChanges.length;
                context.logger.info(`Expecting ${expectedCount} changes to be received by each client`);
              }
              
              return { 
                success: true, 
                changeCount: appliedChanges.length 
              };
            } catch (error) {
              context.logger.error(`Error generating and applying changes: ${error}`);
              return { 
                success: false, 
                error: error instanceof Error ? error.message : String(error)
              };
            }
          }
        } as ChangesAction
      ]
    },
    
    // Step 5: Validate Results
    {
      name: 'Validate Results',
      execution: 'serial',
      actions: [
        {
          type: 'validation',
          name: 'Validate Synchronized Changes',
          operation: 'exec',
          params: async (context: OperationContext) => {
            context.logger.info(`Validating synchronized changes`);
            
            try {
              // Get information about intentional duplicates
              const intentionalDuplicates = context.state.intentionalDuplicates || [];
              const expectedDuplicationCount = intentionalDuplicates.length;
              
              // Create a consolidated report of all missing changes
              const totalDatabaseChanges = context.state.databaseChanges?.length || 0;
              const totalReceivedChanges = context.state.receivedChanges?.[context.state.clients[0]]?.length || 0;
              
              // Calculate adjusted expected count by removing intentional duplicates
              const adjustedExpectedCount = totalDatabaseChanges - expectedDuplicationCount;
              
              // Calculate missing changes count based on adjusted expectations
              const adjustedMissingCount = adjustedExpectedCount - totalReceivedChanges;
                  
              // Track all missing changes centrally
              const missingChanges: TableChange[] = [];
              const missingByType: Record<string, number> = {};
              
              // Create a set of all duplicate change IDs for quick lookup
              const duplicateIds = new Set<string>();
              if (intentionalDuplicates && intentionalDuplicates.length > 0) {
                intentionalDuplicates.forEach((dup: { original: TableChange; duplicate: TableChange }) => {
                  if (dup.duplicate.data?.id) {
                    const key = `${dup.duplicate.table}:${dup.duplicate.operation}:${dup.duplicate.data.id}`;
                    duplicateIds.add(key);
                  }
                });
                context.logger.info(`Created lookup set of ${duplicateIds.size} intentional duplicate keys`);
              }
                  
              if (adjustedMissingCount > 0) {
                context.logger.warn(`===== MISSING CHANGES REPORT =====`);
                context.logger.warn(`Found ${adjustedMissingCount} missing changes out of ${adjustedExpectedCount} expected changes (${((totalReceivedChanges/adjustedExpectedCount)*100).toFixed(1)}% received)`);
                context.logger.info(`Note: Expected count adjusted from ${totalDatabaseChanges} to ${adjustedExpectedCount} to account for ${expectedDuplicationCount} intentional duplicates`);
                
                // Create a centralized list of all applied changes by ID
                const appliedChangesById = new Map<string, TableChange>();
                const receivedChangesById = new Map<string, TableChange>();
                
                // Index database changes by their unique key
                if (context.state.databaseChanges) {
                  context.state.databaseChanges.forEach((change: TableChange) => {
                    if (change.data?.id) {
                      const key = `${change.table}:${change.operation}:${change.data.id}`;
                      appliedChangesById.set(key, change);
                    }
                  });
                }
                
                // Index received changes by their unique key
                if (context.state.receivedChanges && context.state.clients[0]) {
                  const clientChanges = context.state.receivedChanges[context.state.clients[0]];
                  if (clientChanges) {
                    clientChanges.forEach((change: TableChange) => {
                      if (change.data?.id) {
                        const key = `${change.table}:${change.operation}:${change.data.id}`;
                        receivedChangesById.set(key, change);
                      }
                    });
                  }
                }
                
                // Identify missing changes by comparing the two sets, excluding intentional duplicates
                appliedChangesById.forEach((change, key) => {
                  if (!receivedChangesById.has(key)) {
                    // Check if this is an intentional duplicate before adding to missing changes
                    if (!duplicateIds.has(key)) {
                      missingChanges.push(change);
                      
                      // Group by table and operation for reporting
                      const reportKey = `${change.table}:${change.operation}`;
                      missingByType[reportKey] = (missingByType[reportKey] || 0) + 1;
                    } else {
                      context.logger.info(`Skipping intentional duplicate from missing changes: ${key}`);
                    }
                  }
                });
                
                // Report missing changes by type
                context.logger.warn(`Missing changes breakdown:`);
                Object.entries(missingByType).forEach(([type, count]: [string, number]) => {
                  const [table, operation] = type.split(':');
                  context.logger.warn(`- ${table}: ${operation} - ${count} changes`);
                  
                  // Show IDs of missing changes of this type
                  const changesOfType = missingChanges.filter(c => 
                    c.table === table && c.operation === operation
                  );
                  
                  const ids = changesOfType.map(c => {
                    const id = c.data?.id || 'no-id';
                    return typeof id === 'string' ? id.substring(0, 8) : id;
                  }).join(', ');
                  
                  context.logger.warn(`  IDs: ${ids}`);
                });
                
                // Create a detailed missing changes table for all entities
                context.logger.warn(`===== DETAILED CHANGES TABLE =====`);
                // Generate table headers
                context.logger.warn(`Entity   | Operation | Expected | Received | Missing`);
                context.logger.warn(`-------------------------------------------------`);
                
                // Group database changes by table and operation for the table
                const expectedByType: Record<string, number> = {};
                const duplicatesByType: Record<string, number> = {};
                
                // First track duplicates by type for later adjustment
                if (intentionalDuplicates.length > 0) {
                  intentionalDuplicates.forEach((dup: { original: TableChange; duplicate: TableChange }) => {
                    const key = `${dup.duplicate.table}:${dup.duplicate.operation}`;
                    duplicatesByType[key] = (duplicatesByType[key] || 0) + 1;
                  });
                }
                
                // Then process database changes and adjust for duplicates
                if (context.state.databaseChanges) {
                  context.state.databaseChanges.forEach((change: TableChange) => {
                    const key = `${change.table}:${change.operation}`;
                    expectedByType[key] = (expectedByType[key] || 0) + 1;
                  });
                }
                
                // Group received changes by table and operation for the table
                const receivedByType: Record<string, number> = {};
                if (context.state.receivedChanges && context.state.clients[0]) {
                  const clientChanges = context.state.receivedChanges[context.state.clients[0]];
                  if (clientChanges) {
                    clientChanges.forEach((change: TableChange) => {
                      const key = `${change.table}:${change.operation}`;
                      receivedByType[key] = (receivedByType[key] || 0) + 1;
                    });
                  }
                }
                
                // Generate table rows for all entity types that have changes
                const allTypes = new Set([...Object.keys(expectedByType), ...Object.keys(receivedByType)]);
                
                Array.from(allTypes).sort().forEach(type => {
                  const [table, operation] = type.split(':');
                  // Adjust expected count by subtracting intentional duplicates for this type
                  const rawExpected = expectedByType[type] || 0;
                  const duplicatesForType = duplicatesByType[type] || 0;
                  const expected = rawExpected - duplicatesForType;
                  const received = receivedByType[type] || 0;
                  const missing = Math.max(0, expected - received);
                  
                  // Format the table row with padding for alignment
                  const tableStr = table.padEnd(8);
                  const opStr = operation.padEnd(9);
                  const expectedStr = expected.toString().padStart(8);
                  const rawExpectedStr = (duplicatesForType > 0) ? 
                    `${expected}(${rawExpected})`.padStart(8) : 
                    expected.toString().padStart(8);
                  const receivedStr = received.toString().padStart(8);
                  const missingStr = missing.toString().padStart(7);
                  
                  // Highlight rows with missing changes
                  if (missing > 0) {
                    context.logger.warn(`${tableStr} | ${opStr} | ${rawExpectedStr} | ${receivedStr} | ${missingStr} ⚠️`);
                  } else {
                    context.logger.info(`${tableStr} | ${opStr} | ${rawExpectedStr} | ${receivedStr} | ${missingStr}`);
                  }
                });
                
                context.logger.warn(`===== END OF DETAILED TABLE =====`);
              } else {
                context.logger.info(`All expected changes received (after accounting for ${expectedDuplicationCount} intentional duplicates)`);
              }
                
              // Check if we have a change tracker
              if (context.state.changeTracker) {
                // Generate a validation report using the change tracker
                const report = context.state.changeTracker.getValidationReport();
                const completionStats = context.state.changeTracker.getCompletionStats();
                
                // Override the "missing changes" count in the report with our adjusted count
                const updatedMissingCount = adjustedMissingCount > 0 ? adjustedMissingCount : 0;
                // Calculate extra changes when we received more than expected
                const extraChangesCount = adjustedMissingCount < 0 ? Math.abs(adjustedMissingCount) : 0;
                
                // Generate a comprehensive validation summary
                context.logger.info(`\n===== SYNC VALIDATION SUMMARY =====`);
                context.logger.info(`Total database changes: ${totalDatabaseChanges}`);
                context.logger.info(`Adjusted expected changes: ${adjustedExpectedCount} (after removing ${expectedDuplicationCount} intentional duplicates)`);
                context.logger.info(`Total received changes: ${totalReceivedChanges}`);
                context.logger.info(`Missing changes: ${updatedMissingCount}`);
                context.logger.info(`Extra changes: ${extraChangesCount}`);
                context.logger.info(`Sync completion rate: ${((totalReceivedChanges/adjustedExpectedCount)*100).toFixed(1)}%`);
                context.logger.info(`Status: ${updatedMissingCount === 0 ? 'SUCCESS ✅' : 'FAILED ❌'}`);
                context.logger.info(`===== END OF SUMMARY =====\n`);
                
                // Individual client reports
                context.state.clients.forEach((clientId: string) => {
                  const progress = context.state.changeTracker.getClientProgress(clientId);
                  if (progress) {
                    context.logger.info(`Client ${clientId} received ${progress.current}/${progress.expected} changes (${((progress.current / progress.expected) * 100).toFixed(1)}%)`);
                  }
                });
                
                // If there are any issues (missing or extra changes), show a detailed report
                if (updatedMissingCount > 0 || extraChangesCount > 0) {
                  context.logger.warn(`\n===== DETAILED CHANGE DISCREPANCY REPORT =====`);
                  
                  // FIRST SECTION: Missing Changes Report
                  if (updatedMissingCount > 0 && report.realMissingChanges && report.realMissingChanges.length > 0) {
                    context.logger.warn(`\n▶ MISSING CHANGES (${report.realMissingChanges.length}):`);
                    
                    // Group by table and operation for reporting
                    const missingByTableOp = report.realMissingChanges.reduce((acc: Record<string, TableChange[]>, change: TableChange) => {
                      const key = `${change.table}:${change.operation}`;
                      if (!acc[key]) acc[key] = [];
                      acc[key].push(change);
                      return acc;
                    }, {} as Record<string, TableChange[]>);
                    
                    // Sort the table operations for consistent reporting
                    const sortedMissingEntries = Object.entries(missingByTableOp).sort(([a], [b]) => a.localeCompare(b));
                    
                    sortedMissingEntries.forEach(entry => {
                      const [tableOp, changes] = entry as [string, TableChange[]];
                      const [table, operation] = tableOp.split(':');
                      
                      context.logger.warn(`  TABLE: ${table.toUpperCase()} | OPERATION: ${operation.toUpperCase()} | COUNT: ${changes.length}`);
                      
                      // Show IDs with metadata
                      changes.slice(0, 5).forEach((change: TableChange, index: number) => {
                        const id = change.data?.id || 'no-id';
                        const idStr = typeof id === 'string' ? id.substring(0, 8) : id;
                        const timestamp = change.updated_at ? new Date(change.updated_at).toISOString().split('T')[1].replace('Z', '') : 'unknown';
                        const lsn = change.lsn || 'unknown';
                        
                        context.logger.warn(`    ${index + 1}. ID: ${idStr}... | LSN: ${lsn} | Time: ${timestamp}`);
                      });
                      
                      if (changes.length > 5) {
                        context.logger.warn(`    ... and ${changes.length - 5} more`);
                      }
                    });
                  }
                  
                  // SECOND SECTION: Extra Changes Report
                  if (extraChangesCount > 0 && report.extraChanges && report.extraChanges.length > 0) {
                    context.logger.warn(`\n▶ EXTRA CHANGES (${report.extraChanges.length}):`);
                    
                    // Group by table and operation for reporting
                    const extraByTableOp = report.extraChanges.reduce((acc: Record<string, TableChange[]>, change: TableChange) => {
                      const key = `${change.table}:${change.operation}`;
                      if (!acc[key]) acc[key] = [];
                      acc[key].push(change);
                      return acc;
                    }, {} as Record<string, TableChange[]>);
                    
                    // Sort the table operations for consistent reporting
                    const sortedExtraEntries = Object.entries(extraByTableOp).sort(([a], [b]) => a.localeCompare(b));
                    
                    sortedExtraEntries.forEach(entry => {
                      const [tableOp, changes] = entry as [string, TableChange[]];
                      const [table, operation] = tableOp.split(':');
                      
                      context.logger.warn(`  TABLE: ${table.toUpperCase()} | OPERATION: ${operation.toUpperCase()} | COUNT: ${changes.length}`);
                      
                      // Show IDs with metadata
                      changes.slice(0, 5).forEach((change: TableChange, index: number) => {
                        const id = change.data?.id || 'no-id';
                        const idStr = typeof id === 'string' ? id.substring(0, 8) : id;
                        const timestamp = change.updated_at ? new Date(change.updated_at).toISOString().split('T')[1].replace('Z', '') : 'unknown';
                        const lsn = change.lsn || 'unknown';
                        
                        context.logger.warn(`    ${index + 1}. ID: ${idStr}... | LSN: ${lsn} | Time: ${timestamp}`);
                      });
                      
                      if (changes.length > 5) {
                        context.logger.warn(`    ... and ${changes.length - 5} more`);
                      }
                    });
                  }
                  
                  // THIRD SECTION: Batch Origin Information
                  context.logger.warn(`\n▶ BATCH ORIGIN INFORMATION:`);
                  
                  // For missing changes
                  if (updatedMissingCount > 0 && report.realMissingChanges && report.realMissingChanges.length > 0) {
                    context.logger.warn(`  MISSING CHANGES BATCH ORIGINS:`);
                    const batchHistory = context.state.changeTracker.getChangesBatchHistory 
                        ? context.state.changeTracker.getChangesBatchHistory(report.realMissingChanges)
                        : {};
                    
                    if (Object.keys(batchHistory).length === 0) {
                      context.logger.warn(`    No batch origin information available for missing changes`);
                    } else {
                      Object.entries(batchHistory).forEach(([changeKey, batches]) => {
                        const [table, id, op] = changeKey.split(':');
                        context.logger.warn(`    ${table} ${op} ${id.substring(0, 8)}... : ${(batches as string[]).join(', ')}`);
                      });
                    }
                  }
                  
                  // For extra changes
                  if (extraChangesCount > 0 && report.extraChanges && report.extraChanges.length > 0) {
                    context.logger.warn(`  EXTRA CHANGES BATCH ORIGINS:`);
                    const batchHistory = context.state.changeTracker.getChangesBatchHistory 
                        ? context.state.changeTracker.getChangesBatchHistory(report.extraChanges)
                        : {};
                    
                    if (Object.keys(batchHistory).length === 0) {
                      context.logger.warn(`    No batch origin information available for extra changes`);
                    } else {
                      Object.entries(batchHistory).forEach(([changeKey, batches]) => {
                        const [table, id, op] = changeKey.split(':');
                        context.logger.warn(`    ${table} ${op} ${id.substring(0, 8)}... : ${(batches as string[]).join(', ')}`);
                      });
                    }
                  }
                  
                  context.logger.warn(`===== END OF DETAILED REPORT =====\n`);
                } else {
                  context.logger.info(`\nAll changes synchronized correctly! ✅\n`);
                }
                
                return {
                  success: updatedMissingCount === 0,
                  validationReport: {
                    missingChanges: missingChanges,
                    missingChangesCount: updatedMissingCount,
                    extraChanges: report.extraChanges || [],
                    extraChangesCount: extraChangesCount
                  },
                  completionStats
                };
              }
              
              // Log the intentional duplicates
              if (expectedDuplicationCount > 0) {
                context.logger.info(`Test includes ${expectedDuplicationCount} intentional duplicates for deduplication testing:`);
                intentionalDuplicates.forEach((dup: { original: TableChange; duplicate: TableChange }, idx: number) => {
                  const origId = dup.original.data?.id || 'unknown';
                  const dupId = dup.duplicate.data?.id || 'unknown';
                  const origOp = dup.original.operation;
                  const dupOp = dup.duplicate.operation;
                  context.logger.info(`Duplicate #${idx+1}: ${dup.original.table} ${origOp}/${dupOp} for ID ${origId === dupId ? origId : `${origId} and ${dupId}`}`);
                });
              }
              
              // Calculate missing or extra changes
              const updatedMissingCount = adjustedMissingCount > 0 ? adjustedMissingCount : 0;
              const extraChangesCount = adjustedMissingCount < 0 ? Math.abs(adjustedMissingCount) : 0;
              
              return {
                success: updatedMissingCount === 0,
                missingChanges: missingChanges,
                missingChangesCount: updatedMissingCount
              };
            } catch (error) {
              context.logger.error(`Error validating changes: ${error}`);
              return { success: false, error: String(error) };
            }
          }
        } as ValidationAction
      ]
    },
    
    // Step 6: Cleanup
    {
      name: 'Cleanup',
      execution: 'serial',
      actions: [
        {
          type: 'ws',
          name: 'Disconnect Clients',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const clients = context.state.clients || [];
            context.logger.info(`Disconnecting ${clients.length} WebSocket clients`);
            
            try {
              // Disconnect each client
              for (const clientId of clients) {
                await operations.ws.disconnectClient(clientId);
                context.logger.info(`Disconnected client ${clientId}`);
              }
              
              return { success: true };
            } catch (error) {
              context.logger.warn(`Error disconnecting clients: ${error}`);
              return { success: false, error: String(error) };
            }
          }
        } as WSAction
      ]
    }
  ]
};