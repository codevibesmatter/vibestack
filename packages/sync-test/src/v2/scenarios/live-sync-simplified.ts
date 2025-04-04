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
import { 
  generateMixedChanges, 
  generateAndApplyMixedChanges 
} from '../core/entity-changes/batch-changes.ts';
import { ChangeTracker } from '../core/entity-changes/change-tracker.ts';
import { DataSource } from 'typeorm';
import { serverEntities } from '@repo/dataforge/server-entities';

// Import modular sync operations
import { 
  syncClientOperations 
} from '../modules/sync-client-operations.ts';

// Logger for this module
const logger = createLogger('live-sync-simplified');

// Create a DataSource instance for database operations
const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: serverEntities,
  synchronize: false,
  logging: ['error', 'schema']
});

// Add helper function for LSN comparisons
function compareLSNs(lsn1: string, lsn2: string): number {
  try {
    // Parse LSNs to extract segments
    const [major1, minor1] = lsn1.split('/').map(n => parseInt(n, 16));
    const [major2, minor2] = lsn2.split('/').map(n => parseInt(n, 16));
    
    // Compare major segments first
    if (major1 !== major2) {
      return major1 - major2;
    }
    
    // If major segments are equal, compare minor segments
    return minor1 - minor2;
  } catch (e) {
    // If parsing fails, return NaN
    return NaN;
  }
}

/**
 * Simplified Live Sync Test Scenario
 * 
 * A streamlined version of the live sync test that moves complex operations to modules
 */
export const LiveSyncSimplifiedScenario: Scenario = {
  name: 'Simplified Live Sync Test',
  description: 'Tests the live sync capability with minimal implementation',
  config: {
    timeout: 30000,
    changeCount: 5,
    customProperties: {
      clientCount: 1
    }
  },
  
  hooks: {
    beforeScenario: async (context) => {
      context.logger.info(`Starting simplified live sync test with ${context.config.customProperties?.clientCount || 1} clients and ${context.config.changeCount} changes`);
      
      // Register message handlers for interactive steps
      messageDispatcher.registerHandler('srv_live_changes', () => false);
      messageDispatcher.registerHandler('srv_catchup_changes', () => false);
      messageDispatcher.registerHandler('srv_catchup_completed', () => false);
      
      // Initialize a change tracker in the context
      context.state.changeTracker = new ChangeTracker({
        tolerance: 0,
        deduplicationEnabled: true,
        batchSize: 100
      });
      
      // Enable detailed change tracking for debugging
      // This will ensure we log every single change that comes through
      context.logger.info('Enabling detailed change tracking for debugging purposes');
      
      // Set up a detailed tracking of each change
      const originalTrackChanges = context.state.changeTracker.trackChanges.bind(context.state.changeTracker);
      context.state.changeTracker.trackChanges = (clientId: string, changes: any[], batchId?: string) => {
        // Log each change in detail to see exactly what's happening
        context.logger.info(`===== DETAILED CHANGE TRACKING (${changes.length} changes) =====`);
        
        changes.forEach((change, index) => {
          const id = change.data?.id || 'no-id';
          const tableOp = `${change.table}:${change.operation}`;
          const metadata = {
            id: id.substring(0, 8),
            seq: index,
            timestamp: change.updated_at || 'no-timestamp',
            lsn: change.lsn || 'no-lsn',
            txid: change.txid || 'no-txid'
          };
          
          context.logger.info(`Change ${index+1}/${changes.length}: ${tableOp} ${JSON.stringify(metadata)}`);
        });
        
        context.logger.info('===== END DETAILED TRACKING =====');
        
        // Call the original function to maintain normal behavior
        return originalTrackChanges(clientId, changes, batchId);
      };
      
      // Track the Database changes in detail as well
      const originalTrackDbChanges = context.state.changeTracker.trackDatabaseChanges.bind(context.state.changeTracker);
      context.state.changeTracker.trackDatabaseChanges = (changes: any[]) => {
        // Log each database change in detail
        context.logger.info(`===== DETAILED DATABASE CHANGE TRACKING (${changes.length} changes) =====`);
        
        changes.forEach((change, index) => {
          const id = change.data?.id || 'no-id';
          const tableOp = `${change.table}:${change.operation}`;
          
          context.logger.info(`DB Change ${index+1}/${changes.length}: ${tableOp} ID:${id.substring(0, 8)}`);
        });
        
        context.logger.info('===== END DETAILED DB TRACKING =====');
        
        // Call the original function
        return originalTrackDbChanges(changes);
      };
      
      context.logger.info('ChangeTracker initialized for entity changes monitoring');
      
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
        };
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
    // Step 1: Initialize Database and Replication
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
    
    // Step 2: Create and Set Up Clients
    {
      name: 'Set Up Clients',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Get Current LSN from Server',
          operation: 'getCurrentLSN',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            try {
              const lsn = await operations.changes.getCurrentLSN();
              context.state.currentLSN = lsn;
              context.logger.info(`Retrieved current server LSN: ${lsn}`);
              return { success: true, lsn };
            } catch (error) {
              context.logger.error(`Error getting current LSN: ${error}`);
              return { success: false, error: String(error) };
            }
          }
        } as ChangesAction,
        {
          type: 'ws',
          name: 'Create and Configure WebSocket Clients',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const clientCount = context.config.customProperties?.clientCount || 1;
            context.logger.info(`Creating and configuring ${clientCount} WebSocket clients`);
            
            try {
              // Use the sync client operations module to create and configure clients
              const clients = await syncClientOperations.createAndConfigureClients({
                count: clientCount,
                initialLSN: context.state.currentLSN || context.state.initialLSN, // Use current LSN first, fall back to initial LSN
                wsOperations: operations // Pass the operations object so the module can use it
              });
              
              context.state.clients = clients;
              context.logger.info(`Successfully created and configured ${clients.length} clients`);
              
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
      name: 'Handle Catchup Sync',
      execution: 'serial',
      actions: [
        {
          type: 'interactive',
          name: 'Wait for Catchup Sync',
          protocol: 'catchup-sync',
          maxTimeout: 60000,
          
          initialAction: {
            type: 'ws',
            name: 'Initialize Catchup Tracking',
            operation: 'exec',
            params: async (context: OperationContext) => {
              // Initialize a simple set to track which clients have completed catchup
              context.state.clientsCompleted = new Set();
              context.logger.info(`Initialized catchup tracking for ${context.state.clients?.length || 0} clients`);
              return { success: true };
            }
          },
          
          handlers: {
            // Handle server changes during catchup
            'srv_catchup_changes': async (message: ServerChangesMessage, context: OperationContext, operations: Record<string, any>) => {
              const clientId = message.clientId || context.state.clients[0];
              
              context.logger.info(`Received catchup changes: chunk ${message.sequence?.chunk}/${message.sequence?.total} with ${message.changes?.length || 0} changes`);
              
              // We intentionally don't track or validate catchup changes.
              // These are historical changes from previous runs that clients need to get current.
              
              if (message.lastLSN) {
                context.state.lastLSN = message.lastLSN;
                await operations.ws.updateLSN(clientId, message.lastLSN);
              }
              
              // Acknowledge receipt of the catchup chunk
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
              
              return false; // Keep waiting for more messages
            },
            
            // Handle catchup completion from server
            'srv_catchup_completed': async (message: any, context: OperationContext, operations: Record<string, any>) => {
              const clientId = message.clientId;
              context.logger.info(`Catchup sync completed for client ${clientId} with finalLSN: ${message.finalLSN}`);
              
              if (message.finalLSN) {
                // Save LSN in context state
                context.state.lastLSN = message.finalLSN;
                
                // Critical: Update the LSN in both websocket connection and message dispatcher
                await operations.ws.updateLSN(clientId, message.finalLSN);
                messageDispatcher.updateClientLSN(clientId, message.finalLSN);
                
                context.logger.info(`Updated LSN for client ${clientId} to ${message.finalLSN}`);
                
                // Log the current LSN from messageDispatcher to verify it was updated
                const dispatcherLSN = messageDispatcher.getClientLSN(clientId);
                context.logger.info(`Verification - messageDispatcher now has LSN: ${dispatcherLSN}`);
                
                if (dispatcherLSN !== message.finalLSN) {
                  context.logger.error(`ERROR: LSN mismatch after update! Dispatcher has ${dispatcherLSN} but should have ${message.finalLSN}`);
                }
              }
              
              return true;
            }
          }
        } as InteractiveAction,

        // Add a waiting period to ensure LSN is fully updated
        {
          type: 'changes',
          name: 'Ensure LSN propagation',
          operation: 'exec',
          params: async (context: OperationContext) => {
            context.logger.info(`Adding small delay to ensure LSN propagation completes...`);
            
            // Short wait to ensure all LSN updates are propagated
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            context.logger.info(`LSN propagation period completed.`);
            return { success: true };
          }
        } as ChangesAction
      ]
    },
    
    // New Step: Validate Consistent LSNs
    {
      name: 'Validate LSN Consistency',
      execution: 'serial',
      actions: [
        {
          type: 'validation',
          name: 'Check Client LSN Consistency',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            context.logger.info('Validating that all clients have consistent LSNs after catchup sync');
            
            try {
              const clients = context.state.clients || [];
              if (!clients.length) {
                throw new Error('No clients found to validate LSNs');
              }
              
              // Get each client's LSN from the message dispatcher
              const clientLSNs = new Map<string, string>();
              for (const clientId of clients) {
                const lsn = messageDispatcher.getClientLSN(clientId);
                if (!lsn) {
                  throw new Error(`Client ${clientId} has no LSN recorded in message dispatcher`);
                }
                clientLSNs.set(clientId, lsn);
                context.logger.info(`Client ${clientId} has LSN: ${lsn}`);
              }
              
              // Check if all LSNs are the same
              const firstLSN = clientLSNs.get(clients[0]);
              let allMatch = true;
              let mismatchDetails = '';
              
              for (const [clientId, lsn] of clientLSNs.entries()) {
                if (lsn !== firstLSN) {
                  allMatch = false;
                  mismatchDetails += `\n  Client ${clientId}: ${lsn} (should be ${firstLSN})`;
                }
              }
              
              if (!allMatch) {
                context.logger.error(`LSN mismatch detected! Clients have inconsistent LSNs after catchup sync:${mismatchDetails}`);
                throw new Error(`LSN consistency check failed. All clients must have the same LSN after catchup sync.`);
              }
              
              context.logger.info(`LSN consistency check passed. All clients have LSN: ${firstLSN}`);
              
              // Verify with server that client LSN is current
              try {
                // Use the built-in getCurrentLSN operation
                const serverLSN = await operations.changes.getCurrentLSN();
                
                if (serverLSN) {
                  context.logger.info(`Current server LSN: ${serverLSN}`);
                  
                  // Compare if client LSN is reasonably close to server LSN
                  // Note: They won't match exactly, but client should not be too far behind
                  const clientIsUpToDate = firstLSN && serverLSN ? 
                    compareLSNs(firstLSN, serverLSN) >= -2 : 
                    false;
                  
                  if (!clientIsUpToDate) {
                    context.logger.warn(`Client LSN (${firstLSN}) appears to be significantly behind server LSN (${serverLSN})`);
                  } else {
                    context.logger.info(`Client LSN (${firstLSN}) is reasonably close to server LSN (${serverLSN})`);
                  }
                }
              } catch (error) {
                context.logger.warn(`Could not verify server's LSN: ${error}`);
              }
              
              return { 
                success: true,
                consistentLSN: firstLSN
              };
            } catch (error) {
              context.logger.error(`Error in LSN consistency validation: ${error}`);
              return { success: false, error: String(error) };
            }
          }
        } as ValidationAction
      ]
    },
    
    // Step 4: Generate Changes
    {
      name: 'Generate Changes',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Generate Changes',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            // Use the specified changeCount from config, not a hardcoded value
            const changeCount = context.config.changeCount || 10;
            context.logger.info(`Generating and applying ${changeCount} changes`);

            try {
              // Get current LSN before applying changes
              try {
                const preLSN = await operations.changes.getCurrentLSN();
                context.logger.info(`LSN TRACKING: Current LSN before applying changes: ${preLSN}`);
                context.state.preLSN = preLSN;
              } catch (e) {
                context.logger.warn(`Could not get pre-change LSN: ${e}`);
              }

              // Generate and apply changes directly in one step using our new simplified batch changes system
              const appliedChanges = await generateAndApplyMixedChanges(changeCount, 'mixed');
              
              // Get current LSN after applying changes
              try {
                const postLSN = await operations.changes.getCurrentLSN();
                context.logger.info(`LSN TRACKING: Current LSN after applying changes: ${postLSN}`);
                context.state.postLSN = postLSN;
                
                if (context.state.preLSN && postLSN) {
                  context.logger.info(`LSN TRACKING: Changes were applied between LSN ${context.state.preLSN} and ${postLSN}`);
                }
              } catch (e) {
                context.logger.warn(`Could not get post-change LSN: ${e}`);
              }
              
              // Store the generated and applied changes in context state for validation later
              context.state.tableChanges = appliedChanges;
              context.state.databaseChanges = appliedChanges;
              context.state.totalChangesCount = appliedChanges.length;
              
              // Count changes per table for logging
              const changeTypes = appliedChanges.reduce((acc: Record<string, number>, change: TableChange) => {
                const tableName = change.table || 'unknown';
                acc[tableName] = (acc[tableName] || 0) + 1;
                return acc;
              }, {});
              
              // Log summary of changes by table
              Object.entries(changeTypes).forEach(([table, count]) => {
                context.logger.info(`Generated and applied ${count} changes for table ${table}`);
              });
              
              // Set expected changes for clients in the change tracker
              if (context.state.changeTracker) {
                context.state.clients.forEach((clientId: string) => {
                  context.state.changeTracker.setClientExpectedCount(clientId, appliedChanges.length);
                });
                context.logger.info(`Set expected change count of ${appliedChanges.length} for all clients in ChangeTracker`);
              }
              
              // Track the database changes in our change tracker
              if (context.state.changeTracker) {
                context.state.changeTracker.trackDatabaseChanges(appliedChanges);
                context.logger.info(`Tracked ${appliedChanges.length} database changes in ChangeTracker`);
              }
              
              // Set the database changes applied flag to true
              context.state.databaseChangesApplied = true;
              context.logger.info(`All database changes have been applied. Database changes are the source of truth.`);
              
              context.logger.info(`Total changes generated and applied: ${appliedChanges.length}`);
              
              return { 
                success: true, 
                changeCount: appliedChanges.length 
              };
            } catch (error) {
              context.logger.error(`Error generating changes: ${error}`);
              return { success: false, error: String(error) };
            }
          }
        } as ChangesAction
      ]
    },
    
    // Step 5: Set up Tracking and Wait for Changes
    {
      name: 'Track Live Changes',
      execution: 'parallel',
      actions: [
        // Action: Set up tracking and wait for changes 
        {
          type: 'interactive',
          name: 'Wait for Live Changes',
          protocol: 'live-changes',
          maxTimeout: 90000, // 90 second timeout to ensure we get all batches
          
          initialAction: {
            type: 'ws',
            name: 'Initialize Live Change Tracking',
            operation: 'exec',
            params: async (context: OperationContext, operations: Record<string, any>) => {
              // Initialize tracking objects
              context.state.receivedChanges = {} as Record<string, any[]>;
              context.state.clients.forEach((clientId: string) => {
                context.state.receivedChanges[clientId] = [];
              });
              
              // Initialize database changes tracking
              context.state.databaseChangesApplied = false;
              
              // Initialize batch tracking
              context.state.lastBatchTime = 0;
              context.state.batchesSeen = 0;
              context.state.noMoreChanges = false;
              
              // Store the operations in the module for later use
              syncClientOperations.setOperations(operations);
              
              // Log the number of changes we expect
              const expectedCount = context.state.tableChanges?.length || 0;
              context.logger.info(`Expecting ${expectedCount} changes to be received by each client`);
              
              return { success: true };
            }
          },
          
          handlers: {
            // Handle live changes from server
            'srv_live_changes': async (message: ServerChangesMessage, context: OperationContext, operations: Record<string, any>) => {
              const clientId = message.clientId;
              const changes = message.changes || [];
              
              if (changes.length > 0) {
                // Track batch statistics
                const now = Date.now();
                context.state.batchesSeen = (context.state.batchesSeen || 0) + 1;
                const timeSinceLastBatch = context.state.lastBatchTime ? (now - context.state.lastBatchTime) : 0;
                context.state.lastBatchTime = now;
                
                context.logger.info(`Received batch #${context.state.batchesSeen} with ${changes.length} live changes for client ${clientId}${timeSinceLastBatch ? ` (${timeSinceLastBatch}ms since last batch)` : ''}`);
                
                // Track LSN information for this batch
                if (message.lastLSN) {
                  const batchLSN = message.lastLSN;
                  context.logger.info(`LSN TRACKING: This batch has LSN ${batchLSN}`);
                  
                  // Compare against our database change LSN range
                  if (context.state.preLSN && context.state.postLSN) {
                    const preComparison = compareLSNs(batchLSN, context.state.preLSN);
                    const postComparison = compareLSNs(batchLSN, context.state.postLSN);
                    
                    if (preComparison < 0) {
                      context.logger.warn(`LSN TRACKING: Batch LSN ${batchLSN} is BEFORE our change range (${context.state.preLSN}). These are likely changes from previous test runs.`);
                    } else if (postComparison > 0) {
                      context.logger.warn(`LSN TRACKING: Batch LSN ${batchLSN} is AFTER our change range (${context.state.postLSN}). These are likely changes from concurrent operations.`);
                    } else {
                      context.logger.info(`LSN TRACKING: Batch LSN ${batchLSN} is WITHIN our change range (${context.state.preLSN} to ${context.state.postLSN}).`);
                    }
                  }
                }
                
                // Also check timestamps of individual changes
                if (changes.length > 0) {
                  const changeTimestamps = changes.map(change => new Date(change.updated_at || 0).getTime());
                  const minTimestamp = Math.min(...changeTimestamps);
                  const maxTimestamp = Math.max(...changeTimestamps);
                  const now = Date.now();
                  
                  // Report on age of changes
                  context.logger.info(`LSN TRACKING: Changes timestamp range: ${new Date(minTimestamp).toISOString()} to ${new Date(maxTimestamp).toISOString()}`);
                  const oldestAgeMs = now - minTimestamp;
                  if (oldestAgeMs > 60000) { // 1 minute
                    context.logger.warn(`LSN TRACKING: Some changes are ${Math.round(oldestAgeMs/1000)} seconds old. These might be from previous test runs.`);
                  }
                }
                
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
                    context.logger.info(`ChangeTracker: Client ${clientId} has received ${progress.current}/${progress.expected} changes (${((progress.current / progress.expected) * 100).toFixed(1)}%)`);
                  }
                }
                
                // Compare received changes against our database changes
                if (context.state.databaseChanges && context.state.databaseChanges.length > 0) {
                  // Create a set of known database change IDs by table
                  if (!context.state.dbChangeIdsByTable) {
                    context.state.dbChangeIdsByTable = new Map<string, Set<string>>();
                    
                    (context.state.databaseChanges || []).forEach((dbChange: TableChange) => {
                      const table = dbChange.table || 'unknown';
                      const id = dbChange.data?.id;
                      if (!id) return;
                      
                      if (!context.state.dbChangeIdsByTable.has(table)) {
                        context.state.dbChangeIdsByTable.set(table, new Set<string>());
                      }
                      context.state.dbChangeIdsByTable.get(table)?.add(String(id));
                    });
                    
                    context.logger.info('CHANGE TRACKING: Created index of known database change IDs');
                  }
                  
                  // Check each received change against our known database changes
                  const unknownChanges: Array<{table: string, id: string, timestamp?: string}> = [];
                  changes.forEach(change => {
                    const table = change.table || 'unknown';
                    const id = change.data?.id;
                    if (!id) return;
                    
                    const tableIds = context.state.dbChangeIdsByTable.get(table);
                    if (!tableIds || !tableIds.has(String(id))) {
                      // This change doesn't match any of our known database changes
                      unknownChanges.push({table, id: String(id), timestamp: change.updated_at});
                    }
                  });
                  
                  if (unknownChanges.length > 0) {
                    context.logger.warn(`CHANGE TRACKING: Received ${unknownChanges.length}/${changes.length} changes that don't match our database changes`);
                    
                    // Group by table for better reporting
                    const byTable = new Map<string, Array<{table: string, id: string, timestamp?: string}>>();
                    unknownChanges.forEach(change => {
                      if (!byTable.has(change.table)) {
                        byTable.set(change.table, []);
                      }
                      byTable.get(change.table)?.push(change);
                    });
                    
                    byTable.forEach((changes, table) => {
                      context.logger.warn(`CHANGE TRACKING: Table ${table} has ${changes.length} unknown changes: ${changes.map(c => c.id.substring(0, 8)).join(', ')}`);
                    });
                  } else {
                    context.logger.info('CHANGE TRACKING: All received changes match our known database changes');
                  }
                }
                
                // Track duplicates across batches
                if (context.state.trackAndDetectDuplicates) {
                  const duplicateCount = context.state.trackAndDetectDuplicates(changes);
                  if (duplicateCount > 0) {
                    context.logger.warn(`Detected ${duplicateCount} duplicates out of ${changes.length} changes in this batch`);
                  }
                }
                
                // Capture both the changes and client ID for later validation
                context.state.lastChangesForClient = {
                  clientId, 
                  changes
                };
                
                // Critical: Update the client's stored LSN in the message dispatcher
                // This ensures the server won't resend the same changes on the next request
                if (message.lastLSN) {
                  messageDispatcher.updateClientLSN(clientId, message.lastLSN);
                  context.logger.info(`Updated LSN for client ${clientId} to ${message.lastLSN}`);
                }
                
                // Log current progress to see how close we are to expected changes
                const receivedCount = context.state.receivedChanges[clientId].length;
                const expectedCount = context.state.tableChanges?.length || 0;
                context.logger.info(`Client ${clientId} has now received ${receivedCount}/${expectedCount} changes (${((receivedCount / expectedCount) * 100).toFixed(1)}%)`);
                
                // Check if all expected changes have been received by this client
                if (receivedCount >= expectedCount && context.state.databaseChangesApplied) {
                  context.logger.info(`Client ${clientId} has received all expected changes (${receivedCount}/${expectedCount}). Signaling completion.`);
                  
                  // Signal completion to the change tracker
                  if (context.state.changeTracker) {
                    const allReceived = context.state.changeTracker.getCompletionStats().percentComplete >= 100;
                    if (allReceived) {
                      context.logger.info(`All clients have received 100% of expected changes. Protocol complete.`);
                      context.state.noMoreChanges = true;
                      return true; // Signal completion to the protocol handler
                    }
                  }
                }
              }
              
              // Send acknowledgment
              await operations.ws.sendMessage(clientId, {
                type: 'clt_changes_ack',
                clientId,
                lastLSN: message.lastLSN || '0/0',
                timestamp: Date.now()
              });
              
              // Only complete when we're told to end the protocol or when all changes are received
              if (context.state.noMoreChanges) {
                context.logger.info(`Test process has indicated completion. Ending live changes handler.`);
                return true;
              }
              
              // Never complete based just on the number of changes - need to ensure all clients are done
              // and that database changes are fully applied
              return false;
            },
            
            // Allow timeout to complete naturally
            'timeout': async (message: any, context: OperationContext) => {
              context.logger.info(`Protocol timeout reached after ${context.state.maxTimeout/1000} seconds. Forcing completion.`);
              return true;
            }
          }
        } as InteractiveAction
      ]
    },
    
    // Step 6: Validate Results
    {
      name: 'Validate Results',
      execution: 'serial',
      actions: [
        {
          type: 'validation',
          name: 'Validate Synchronized Changes',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            context.logger.info(`Validating synchronized changes`);
            
            try {
              // Check if we have a change tracker
              if (context.state.changeTracker) {
                // Generate a validation report using the change tracker
                const report = context.state.changeTracker.getValidationReport();
                const completionStats = context.state.changeTracker.getCompletionStats();
                
                context.logger.info(`ChangeTracker validation report:
                  Total database changes: ${report.databaseChanges}
                  Total received changes: ${report.receivedChanges}
                  Missing changes: ${report.missingChanges.length}
                  Exact matches: ${report.exactMatchCount}
                  Success: ${report.success ? 'YES' : 'NO'}
                  Completion: ${completionStats.percentComplete.toFixed(1)}%
                `);
                
                // Individual client reports
                context.state.clients.forEach((clientId: string) => {
                  const progress = context.state.changeTracker.getClientProgress(clientId);
                  if (progress) {
                    context.logger.info(`Client ${clientId} received ${progress.current}/${progress.expected} changes (${((progress.current / progress.expected) * 100).toFixed(1)}%)`);
                  }
                });
                
                return {
                  success: report.success,
                  validationReport: report,
                  completionStats
                };
              }
              
              // Fall back to the legacy validation if no change tracker
              // Use databaseChanges which is already stored as an array
              const appliedChanges = context.state.databaseChanges || [];
              
              if (!appliedChanges.length) {
                context.logger.warn(`No database changes found for validation`);
                return {
                  success: true,
                  warning: 'No changes to validate'
                };
              }
              
              context.logger.info(`Validating against ${appliedChanges.length} database changes`);
              
              // Create a unique identifier for each change based on data.id and operation
              const getChangeKey = (change: TableChange): string => {
                const entityId = change.data?.id || 'unknown';
                return `${change.table}:${change.operation}:${entityId}`;
              };
              
              // Track unique changes by their key
              const appliedChangeKeys = new Set<string>();
              appliedChanges.forEach((change: TableChange) => {
                appliedChangeKeys.add(getChangeKey(change));
              });
              
              context.logger.info(`Found ${appliedChangeKeys.size} unique changes to validate against`);
              
              // Check what each client received
              const validationResults: Record<string, { expected: number, received: number, successRate: string }> = {};
              let totalSuccess = 0;
              let totalExpected = 0;
              
              for (const clientId of context.state.clients) {
                const receivedChanges = context.state.receivedChanges[clientId] || [];
                
                // Get unique keys of changes this client received
                const receivedChangeKeys = new Set<string>();
                receivedChanges.forEach((change: TableChange) => {
                  receivedChangeKeys.add(getChangeKey(change));
                });
                
                // Calculate how many applied changes this client received
                let received = 0;
                appliedChangeKeys.forEach(key => {
                  if (receivedChangeKeys.has(key)) {
                    received++;
                  }
                });
                
                const expected = appliedChangeKeys.size;
                const successRate = expected > 0 ? (received / expected) * 100 : 0;
                
                validationResults[clientId] = {
                  expected,
                  received,
                  successRate: `${successRate.toFixed(1)}%`
                };
                
                totalSuccess += received;
                totalExpected += expected;
                
                context.logger.info(`Client ${clientId} received ${received}/${expected} changes (${successRate.toFixed(1)}%)`);
              }
              
              // Calculate overall success rate
              const overallSuccessRate = totalExpected > 0 ? (totalSuccess / totalExpected) * 100 : 0;
              
              context.logger.info(`Overall: ${totalSuccess}/${totalExpected} changes received (${overallSuccessRate.toFixed(1)}%)`);
              
              return {
                success: true,
                validationResults,
                overallSuccessRate: `${overallSuccessRate.toFixed(1)}%`
              };
            } catch (error) {
              context.logger.error(`Error validating changes: ${error}`);
              return { success: false, error: String(error) };
            }
          }
        } as ValidationAction
      ]
    },
    
    // Step 7: Cleanup
    {
      name: 'Cleanup',
      execution: 'serial',
      actions: [
        {
          type: 'ws',
          name: 'Signal Protocol Completion',
          operation: 'exec',
          params: async (context: OperationContext) => {
            context.logger.info(`Signaling that no more changes will be accepted`);
            
            // Signal to the protocol that it should complete
            context.state.noMoreChanges = true;
            
            // Short delay to ensure the signal is processed
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            return { success: true };
          }
        } as WSAction,
        {
          type: 'ws',
          name: 'Disconnect Clients',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const clients = context.state.clients || [];
            context.logger.info(`Disconnecting ${clients.length} WebSocket clients`);
            
            try {
              // Ensure operations are set in the module
              syncClientOperations.setOperations(operations);
              
              // Use the sync client operations module to disconnect clients
              await syncClientOperations.disconnectClients(clients);
              
              // Reset the module state for future test runs
              syncClientOperations.reset();
              
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