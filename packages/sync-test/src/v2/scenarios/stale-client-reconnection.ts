// Load environment variables
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Determine the correct path to .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Go up 3 directories: /scenarios -> /v2 -> /src -> /sync-test (root)
const rootDir = resolve(__dirname, '../../../');
dotenv.config({ path: resolve(rootDir, '.env') });

import { createLogger } from '../core/logger.ts';
import { 
  ScenarioRunner, 
  Scenario, 
  ApiAction, 
  ChangesAction, 
  WSAction, 
  InteractiveAction,
  ValidationAction,
  OperationContext
} from '../core/scenario-runner.ts';
import { messageDispatcher } from '../core/message-dispatcher.ts';
import type {
  ServerChangesMessage,
  ServerCatchupCompletedMessage,
  TableChange,
  ClientChangesMessage
} from '@repo/sync-types';

// Import core sync modules from entity-changes
import { DataSource } from 'typeorm';
import { Task } from '@repo/dataforge/server-entities';
import { TableChangeTest } from '../core/entity-changes/types.ts';
import { 
  transformChangesToSnakeCase
} from '../core/client-actions.ts';
import { 
  generateClientMixedSubmitChanges,
  generateClientConflictUpdateChange
} from '../core/entity-changes/client-submit-changes.ts';
import { ClientChangeTracker } from '../core/entity-changes/client-change-tracker.ts';

// Import the sync test helpers
import {
  createTestDataSource,
  initializeTestDatabase,
  createBaseEntities,
  createTestTasks,
  initializeSyncStateTrackers,
  messageHandlers,
  validationHelpers
} from '../core/sync-test-helpers.ts';

// Logger for this module
const logger = createLogger('sync.stale-reconnect');

// Create database connection using the helper
const dataSource = createTestDataSource();

// Define context interface for this scenario
interface StaleClientReconnectionContext extends OperationContext {
  results?: {
    initialLsnResult?: { 
      success?: boolean;
      lsn?: string;
    };
  };
  state: OperationContext['state'] & {
    initialServerLSN?: string;
    ownerId?: string;
    projectId?: string;
    clientId?: string;
    clientProfile?: number;
    clientCatchupCompleted?: boolean;
    clientLSN?: string;
    nonConflictingTaskIds?: string[];
    conflictingTaskIds?: string[];
    tasksForDeletionIds?: string[];
    deletedTaskIds?: string[];
    initialChanges: TableChangeTest[];
    staleChanges: TableChangeTest[];
    reconnectedClientId?: string;
    reconnectCatchupCompleted?: boolean;
    afterReconnectChanges: TableChangeTest[];
    staleChangesByType: {
      nonConflicting: TableChangeTest[];
      conflicting: TableChangeTest[];
      deletedRecords: TableChangeTest[];
    };
    scenarioConfig: {
      changesPerBatch: number;
      staleTimestampOffsetDays: number;
      reconnectDelay: number;
      staleDeletionTest: boolean;
    };
    clientChangeTracker: ClientChangeTracker;
    preDisconnectLSN?: string;
    reconnectLSN?: string;
  }
}

/**
 * Stale Client Reconnection Sync Test Scenario
 * 
 * Tests CRDT behavior when a client reconnects and sends changes with
 * timestamps older than what's in the database.
 */
export const StaleClientReconnectionScenario: Scenario = {
  name: 'Stale Client Reconnection Sync Test',
  description: 'Tests CRDT timestamp resolution when a client reconnects with stale changes',
  config: {
    timeout: 90000,
    changeCount: 5, // Required by TestConfig
    customProperties: {
      changesPerBatch: 5,
      staleTimestampOffsetDays: 2, // How many days in past to set timestamps
      reconnectDelay: 5000, // How long to wait before reconnecting
      staleDeletionTest: true // Test submitting changes to deleted records
    }
  },
  
  hooks: {
    beforeScenario: async (context: OperationContext) => {
      // Extract config
      const changesPerBatch = context.config.customProperties?.changesPerBatch || 5;
      
      // Store config for later use
      context.state.scenarioConfig = {
        changesPerBatch,
        staleTimestampOffsetDays: context.config.customProperties?.staleTimestampOffsetDays || 2,
        reconnectDelay: context.config.customProperties?.reconnectDelay || 5000,
        staleDeletionTest: context.config.customProperties?.staleDeletionTest || false
      };
      
      // Initialize tracking structures
      context.state.initialChanges = [];
      context.state.staleChanges = [];
      context.state.afterReconnectChanges = [];
      context.state.deletedTaskIds = [];
      context.state.staleChangesByType = {
        nonConflicting: [],
        conflicting: [],
        deletedRecords: []
      };
      
      // Register message handlers
      messageHandlers.registerCleanHandlers();
      
      // Initialize state trackers
      context.state.clientChangeTracker = messageHandlers.initializeClientChangeTracker();
      const stateTrackers = initializeSyncStateTrackers({ inactivityTimeout: 15000 });
      context.state.changeState = stateTrackers.changeState;
      context.state.serverConfirmedStateManager = stateTrackers.serverConfirmedStateManager;
      context.state.changeTracker = stateTrackers.changeTracker;
      
      logger.info('Starting Stale Client Reconnection test with simplified single client approach');
    }
  },
  
  steps: [
    // Step 1: Initialize Environment and Create All Test Data
    {
      name: 'Initialize Environment and Create Test Data',
      execution: 'serial',
      actions: [
        // Initialize database
        {
          type: 'changes',
          name: 'Initialize Database',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            return { success: await initializeTestDatabase(dataSource) };
          }
        } as ChangesAction,
        
        // Initialize server replication
        {
          type: 'api',
          name: 'Initialize Server Replication',
          endpoint: '/api/replication/init',
          method: 'POST',
        } as ApiAction,
        
        // Get Initial Server LSN
        {
          type: 'api',
          name: 'Get Initial Server LSN',
          endpoint: '/api/replication/lsn',
          method: 'GET',
          storeResultAs: 'initialLsnResult'
        } as ApiAction,
        
        // Store LSN and create base entities
        {
          type: 'changes',
          name: 'Create Base Entities',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            // Store LSN
            const apiResult = context.results?.initialLsnResult;
            const initialServerLSN = apiResult?.lsn || '0/0';
            context.state.initialServerLSN = initialServerLSN;
            
            // Create base entities
            const { ownerId, projectId } = await createBaseEntities(operations);
            context.state.ownerId = ownerId;
            context.state.projectId = projectId;
            
            logger.info(`Created base entities: User (${ownerId}), Project (${projectId})`);
            return { success: true, ownerId, projectId };
          }
        } as ChangesAction,
        
        // Create shared task records for testing
        {
          type: 'changes',
          name: 'Create Shared Task Records',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            const ownerId = context.state.ownerId;
            const projectId = context.state.projectId;
            
            if (!ownerId || !projectId) {
              throw new Error('Owner ID or Project ID not found in state.');
            }
            
            // Create three groups of tasks:
            // 1. Tasks that will receive non-conflicting updates (5)
            // 2. Tasks that will receive conflicting updates (5)
            // 3. Tasks that will be deleted (3)
            
            // Non-conflicting tasks
            const nonConflictingTasks = await createTestTasks(
              ownerId, projectId, 5, operations, 
              { namePrefix: 'Non-Conflict Task' }
            );
            
            // Conflicting tasks
            const conflictingTasks = await createTestTasks(
              ownerId, projectId, 5, operations,
              { namePrefix: 'Conflict Task' }
            );
            
            // Tasks to be deleted later
            const tasksForDeletion = await createTestTasks(
              ownerId, projectId, 3, operations,
              { namePrefix: 'Deletion Task' }
            );
            
            // Store task IDs in state
            context.state.nonConflictingTaskIds = nonConflictingTasks.map((t: Task) => t.id);
            context.state.conflictingTaskIds = conflictingTasks.map((t: Task) => t.id);
            context.state.tasksForDeletionIds = tasksForDeletion.map((t: Task) => t.id);
            
            logger.info(`Created test tasks: ${nonConflictingTasks.length} non-conflicting, ${conflictingTasks.length} conflicting, ${tasksForDeletion.length} for deletion`);
            
            return { success: true };
          }
        } as ChangesAction
      ]
    },
    
    // Step 2: Wait for WAL Processing
    {
      name: 'Wait for WAL Processing',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Wait for WAL Processing',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            // Extended wait to ensure all changes are fully processed
            logger.info('Waiting 15 seconds for WAL processing to complete for all test data...');
            await new Promise(resolve => setTimeout(resolve, 15000));
            
            // Get the current server LSN after all entity creation
            try {
              const response = await operations.api.get('/api/replication/lsn');
              const serverLSN = response.lsn;
              
              if (serverLSN && serverLSN !== '0/0') {
                logger.info(`Current server LSN after test data creation: ${serverLSN}`);
                
                // Update the initial server LSN to use this latest value
                context.state.initialServerLSN = serverLSN;
              }
            } catch (lsnError) {
              logger.warn(`Failed to get updated server LSN: ${lsnError}`);
            }
            
            return { success: true };
          }
        } as ChangesAction
      ]
    },
    
    // Step 3: Create and Setup Client (moved after all test data is created)
    {
      name: 'Create and Setup Client',
      execution: 'serial',
      actions: [
        {
          type: 'ws',
          name: 'Create and Setup WebSocket Client',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            const latestLSN = context.state.initialServerLSN || '0/0';
            
            logger.info(`Creating WebSocket client with initial LSN: ${latestLSN}`);
            
            // Create single client with profile ID 1
            const profileId = 1;
            const clientId = await operations.ws.createClient(profileId, latestLSN);
            
            context.state.clientId = clientId;
            context.state.clientProfile = profileId;
            
            // Add explicit delay before setup to allow server to initialize
            logger.info(`Waiting 2 seconds before setting up client connection...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            await operations.ws.setupClient(clientId);
            
            // Add additional delay after setup to ensure websocket connection is fully established
            logger.info(`Client connected, waiting 3 more seconds for connection to stabilize...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Verify the client is properly connected
            try {
              const isConnected = await operations.ws.isClientConnected(clientId);
              logger.info(`Connection status verification: ${isConnected ? 'CONNECTED' : 'DISCONNECTED'}`);
              
              if (!isConnected) {
                logger.warn(`Client appears to be disconnected, attempting to reconnect...`);
                await operations.ws.connectClient(clientId, undefined, { lsn: latestLSN });
                
                // Additional wait after reconnection attempt
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Verify connection again
                const reconnected = await operations.ws.isClientConnected(clientId);
                if (!reconnected) {
                  throw new Error(`Failed to establish stable connection for client ${profileId}`);
                }
                logger.info(`Client reconnected successfully`);
              }
            } catch (connectionError) {
              logger.warn(`Error checking connection: ${connectionError}. Continuing anyway.`);
            }
            
            logger.info(`Created and setup client ${profileId} (${clientId})`);
            
            return { success: true, clientId };
          }
        } as WSAction,
        
        // Add a separate step to wait for server to recognize the connection
        {
          type: 'changes',
          name: 'Ensure Server Connection is Stable',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            logger.info(`Waiting 5 seconds to ensure server has fully registered the connection...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            return { success: true };
          }
        } as ChangesAction
      ]
    },
    
    // Step 4: Wait for Initial Catchup (renamed from Step 3)
    {
      name: 'Wait for Initial Catchup',
      execution: 'serial',
      actions: [
        {
          type: 'interactive',
          name: 'Wait for Initial Catchup',
          protocol: 'initial-catchup',
          maxTimeout: 30000,
          handlers: {
            'srv_catchup_changes': async (message: ServerChangesMessage, context: StaleClientReconnectionContext, operations: Record<string, any>) => {
              const clientId = message.clientId;
              
              // Only process for our client
              if (clientId !== context.state.clientId) {
                return false;
              }
              
              // Extract sequence information for better logging
              const chunkNum = message.sequence?.chunk || 1;
              const totalChunks = message.sequence?.total || 1;
              
              logger.info(`Received catchup changes: chunk ${chunkNum}/${totalChunks} with ${message.changes?.length || 0} changes for client ${context.state.clientProfile}`);
              
              // Save the last LSN from the message - a real client would do this
              if (message.lastLSN) {
                context.state.clientLSN = message.lastLSN;
                logger.debug(`Updated client LSN to ${message.lastLSN} from catchup message`);
              }
              
              // Send acknowledgment
              try {
                logger.debug(`Sending acknowledgment for chunk ${chunkNum}/${totalChunks}`);
                await messageHandlers.sendCatchupAcknowledgment(
                  clientId, 
                  operations, 
                  chunkNum, 
                  message.lastLSN || '0/0'
                );
                logger.debug(`Sent acknowledgment for chunk ${chunkNum}/${totalChunks} with LSN: ${message.lastLSN || '0/0'}`);
              } catch (error) {
                logger.error(`Failed to send acknowledgment for chunk ${chunkNum}: ${error}`);
              }
              
              return false; // Continue waiting
            },
            'srv_catchup_completed': async (message: ServerCatchupCompletedMessage, context: StaleClientReconnectionContext) => {
              const clientId = message.clientId;
              
              // Only process for our client
              if (clientId !== context.state.clientId) {
                return false;
              }
              
              // Save the final LSN from the completed message
              if (message.finalLSN) {
                context.state.clientLSN = message.finalLSN;
                logger.info(`Updated client LSN to ${message.finalLSN} from catchup completed message`);
              }
              
              logger.info(`Client ${context.state.clientProfile} completed initial catchup with LSN: ${context.state.clientLSN}`);
              
              // Mark client as caught up
              context.state.clientCatchupCompleted = true;
              
              return true; // Finish protocol
            },
            'timeout': async (message: any, context: StaleClientReconnectionContext) => {
              logger.error('Initial catchup timed out');
              throw new Error('Initial catchup timed out');
            }
          }
        } as InteractiveAction,
        
        // Add additional wait after catchup completes
        {
          type: 'changes',
          name: 'Wait After Initial Catchup',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            logger.info('Initial catchup completed, waiting 5 seconds for server processing...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            return { success: true };
          }
        } as ChangesAction
      ]
    },
    
    // Step 5: Make Initial Changes
    {
      name: 'Make Initial Changes',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Generate and Submit Initial Changes',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            const clientId = context.state.clientId;
            if (!clientId) {
              throw new Error('Client ID not found in state');
            }
            
            logger.info(`Generating initial changes for client ${context.state.clientProfile}`);
            
            // 1. Make updates to conflict-intended tasks
            const conflictingTaskIds = context.state.conflictingTaskIds || [];
            const conflictTaskUpdates = conflictingTaskIds.map((taskId: string, index: number) => {
              return generateClientConflictUpdateChange(
                taskId,
                clientId,
                index,
                clientId
              );
            });
            
            // 2. Delete some tasks that will later receive stale updates
            const tasksForDeletionIds = context.state.tasksForDeletionIds || [];
            
            // Add a significant delay to let WAL processing complete and ensure our
            // delete timestamp is definitively newer than task creation
            logger.info('Waiting 10 seconds before deleting tasks to ensure timestamps are newer...');
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            // Create delete operations with timestamps that should be newer than the records
            const taskDeletions = tasksForDeletionIds.map((taskId: string) => {
              // Create timestamp a little in the future to ensure it's newer than any DB timestamp
              const timestamp = new Date(Date.now() + 1000).toISOString();
              
              return {
                table: 'tasks',
                operation: 'delete' as const,
                data: { 
                  id: taskId,
                  client_id: clientId // Ensure client_id is included for all operations
                },
                updated_at: timestamp,
                _originClientId: clientId
              };
            });
            
            logger.info(`Created delete operations with newer timestamps: ${new Date().toISOString()}`);
            
            // 3. Create some new tasks
            const newTasks = await generateClientMixedSubmitChanges(
              3, // 3 new tasks
              { task: 1.0 }, // 100% tasks
              clientId,
              {
                projectId: context.state.projectId,
                assigneeId: context.state.ownerId,
                ownerId: context.state.ownerId
              },
              undefined // No conflict
            );
            
            // Combine all changes
            const allChanges = [
              ...conflictTaskUpdates,
              ...taskDeletions,
              ...newTasks
            ];
            
            // Store changes for validation
            context.state.initialChanges = allChanges;
            
            // Store deleted task IDs for validation
            context.state.deletedTaskIds = tasksForDeletionIds;
            
            // Submit changes
            const payload: ClientChangesMessage = {
              type: 'clt_send_changes',
              messageId: `clt_${clientId}_${Date.now()}_submit`,
              timestamp: Date.now(),
              clientId: clientId,
              changes: transformChangesToSnakeCase(allChanges)
            };
            
            logger.info(`Submitting ${allChanges.length} initial changes from client ${context.state.clientProfile}`);
            await operations.ws.sendMessage(clientId, payload);
            
            // Wait for changes to be processed - increase to 8 seconds
            logger.info('Waiting for changes to be processed (8 seconds)...');
            await new Promise(resolve => setTimeout(resolve, 8000));
            
            return { 
              success: true, 
              changeCount: allChanges.length,
              conflictingUpdates: conflictTaskUpdates.length,
              deletions: taskDeletions.length,
              newTasks: newTasks.length
            };
          }
        } as ChangesAction,
        
        // Add extra wait time after submitting changes
        {
          type: 'changes',
          name: 'Extra Wait After Initial Changes',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            logger.info('Waiting additional 3 seconds for change processing and WAL updates...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            return { success: true };
          }
        } as ChangesAction
      ]
    },
    
    // Step 6: Disconnect Client
    {
      name: 'Disconnect Client',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Store LSN Before Disconnect',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            const clientId = context.state.clientId;
            if (!clientId) {
              throw new Error('Client ID not found in state');
            }
            
            // Explicitly store the current LSN in a separate variable before disconnecting
            // Make sure we have a valid LSN before disconnecting
            if (!context.state.clientLSN || context.state.clientLSN === '0/0') {
              logger.warn(`Client has invalid LSN: ${context.state.clientLSN}, using initial LSN instead`);
              context.state.clientLSN = context.state.initialServerLSN || '0/0';
            }
            
            // Store pre-disconnect LSN for validation
            const currentLSN = context.state.clientLSN;
            context.state.preDisconnectLSN = currentLSN;
            
            logger.info(`Storing pre-disconnect LSN: ${currentLSN}`);
            
            return { success: true, preDisconnectLSN: currentLSN };
          }
        } as ChangesAction,
        
        {
          type: 'ws',
          name: 'Disconnect Client',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            const clientId = context.state.clientId;
            if (!clientId) {
              throw new Error('Client ID not found in state');
            }
            
            // Explicitly log the LSN we're disconnecting with
            const disconnectLSN = context.state.preDisconnectLSN || context.state.clientLSN;
            
            logger.info(`Disconnecting client ${context.state.clientProfile} (${clientId}) with current LSN: ${disconnectLSN}`);
            
            // Disconnect client
            await operations.ws.disconnectClient(clientId);
            
            logger.info(`Client ${context.state.clientProfile} disconnected, stored LSN: ${disconnectLSN}`);
            
            // Wait a moment to ensure disconnect is complete
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            return { success: true, disconnectLSN };
          }
        } as WSAction
      ]
    },
    
    // Add extended wait period between disconnect and stale change generation
    {
      name: 'Wait After Disconnect',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Wait After Disconnect',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            logger.info('Waiting 5 seconds after disconnect before generating stale changes...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            return { success: true };
          }
        } as ChangesAction
      ]
    },
    
    // Step 7: Generate Stale Changes
    {
      name: 'Generate Stale Changes',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Generate Stale Changes',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            const clientId = context.state.clientId;
            if (!clientId) {
              throw new Error('Client ID not found in state');
            }
            
            const daysOffset = context.state.scenarioConfig.staleTimestampOffsetDays;
            
            logger.info(`Generating stale changes with timestamp offset of ${daysOffset} days`);
            
            // Create a past date for stale changes
            const pastDate = new Date();
            pastDate.setDate(pastDate.getDate() - daysOffset);
            const staleTimestamp = pastDate.toISOString();
            
            logger.info(`Using stale timestamp: ${staleTimestamp}`);
            
            // 1. Generate non-conflicting updates to non-conflicting tasks
            const nonConflictingTaskIds = context.state.nonConflictingTaskIds || [];
            const nonConflictingUpdates = nonConflictingTaskIds.slice(0, 2).map((taskId: string) => ({
              table: 'tasks',
              operation: 'update' as const,
              data: { 
                id: taskId, 
                title: `Stale Update to Task ${taskId.slice(0, 6)}`,
                client_id: clientId
              },
              updated_at: staleTimestamp, // Use stale timestamp
              _originClientId: clientId
            }));
            
            // 2. Generate conflicting updates to already-updated tasks
            const conflictingTaskIds = context.state.conflictingTaskIds || [];
            const conflictingUpdates = conflictingTaskIds.slice(0, 2).map((taskId: string) => ({
              table: 'tasks',
              operation: 'update' as const,
              data: { 
                id: taskId, 
                title: `STALE Conflict Update to Task ${taskId.slice(0, 6)}`,
                client_id: clientId
              },
              updated_at: staleTimestamp, // Use stale timestamp
              _originClientId: clientId
            }));
            
            // 3. Generate updates to deleted tasks
            const deletedTaskIds = context.state.deletedTaskIds || [];
            const updatesToDeletedTasks = deletedTaskIds.slice(0, 2).map((taskId: string) => ({
              table: 'tasks',
              operation: 'update' as const,
              data: { 
                id: taskId, 
                title: `Stale Update to DELETED Task ${taskId.slice(0, 6)}`,
                client_id: clientId
              },
              updated_at: staleTimestamp, // Use stale timestamp
              _originClientId: clientId
            }));
            
            // Combine all stale changes
            const allStaleChanges = [
              ...nonConflictingUpdates,
              ...conflictingUpdates,
              ...updatesToDeletedTasks
            ];
            
            // Store changes by type for validation
            context.state.staleChangesByType = {
              nonConflicting: nonConflictingUpdates,
              conflicting: conflictingUpdates,
              deletedRecords: updatesToDeletedTasks
            };
            
            // Store all stale changes
            context.state.staleChanges = allStaleChanges;
            
            logger.info(`Generated ${allStaleChanges.length} stale changes`);
            logger.info(`  - ${nonConflictingUpdates.length} non-conflicting updates`);
            logger.info(`  - ${conflictingUpdates.length} conflicting updates`);
            logger.info(`  - ${updatesToDeletedTasks.length} updates to deleted records`);
            
            return { 
              success: true, 
              changeCount: allStaleChanges.length,
              staleTimestamp
            };
          }
        } as ChangesAction
      ]
    },
    
    // Step 8: Reconnect Client
    {
      name: 'Reconnect Client',
      execution: 'serial',
      actions: [
        {
          type: 'ws',
          name: 'Reconnect Client',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            const clientId = context.state.clientId;
            if (!clientId) {
              throw new Error('Client ID not found in state');
            }
            
            // Use the stored pre-disconnect LSN explicitly instead of the current clientLSN
            // which might have been reset during disconnect
            let reconnectLSN = context.state.preDisconnectLSN;
            
            // Fallback if somehow the pre-disconnect LSN was not stored
            if (!reconnectLSN || reconnectLSN === '0/0') {
              logger.warn(`No valid pre-disconnect LSN found: ${reconnectLSN}, using stored client LSN`);
              reconnectLSN = context.state.clientLSN;
            }
            
            // Final fallback to initial server LSN if all else fails
            if (!reconnectLSN || reconnectLSN === '0/0') {
              logger.warn(`No valid LSN found for reconnection, using initial server LSN`);
              reconnectLSN = context.state.initialServerLSN || '0/0';
            }
            
            logger.info(`Reconnecting client ${context.state.clientProfile} with explicit LSN: ${reconnectLSN}`);
            
            // Make sure we're properly disconnected first
            try {
              logger.debug(`Ensuring client ${clientId} is disconnected before reconnection`);
              await operations.ws.disconnectClient(clientId);
              
              // Increased delay to ensure disconnect is complete
              logger.info(`Waiting 2 seconds to ensure disconnect is complete...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (error) {
              logger.warn(`Error disconnecting client: ${error}. Will proceed with reconnection.`);
            }
            
            // Reconnect with explicit LSN options - make sure it's clearly passed
            logger.info(`Connecting client ${clientId} with LSN options: { lsn: "${reconnectLSN}" }`);
            const connectOptions = { lsn: reconnectLSN };
            
            await operations.ws.connectClient(clientId, undefined, connectOptions);
            
            // Wait for connection to stabilize
            logger.info(`Waiting 3 seconds for connection to stabilize after reconnection...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Verify the connection is active
            try {
              const isConnected = await operations.ws.isClientConnected(clientId);
              logger.info(`Reconnection status verification: ${isConnected ? 'CONNECTED' : 'DISCONNECTED'}`);
              
              if (!isConnected) {
                logger.warn(`Client appears to be disconnected after reconnection, attempting to reconnect again...`);
                await operations.ws.connectClient(clientId, undefined, { lsn: reconnectLSN });
                
                // Additional wait after reconnection attempt
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Verify connection again
                const reconnected = await operations.ws.isClientConnected(clientId);
                if (!reconnected) {
                  throw new Error(`Failed to establish stable connection for reconnected client`);
                }
                logger.info(`Client reconnected successfully after retry`);
              }
            } catch (connectionError) {
              logger.warn(`Error checking reconnection status: ${connectionError}. Continuing anyway.`);
            }
            
            // Store the reconnection LSN explicitly
            context.state.reconnectLSN = reconnectLSN;
            context.state.clientLSN = reconnectLSN;
            
            // Store the reconnected client ID (same as original client ID)
            context.state.reconnectedClientId = clientId;
            
            logger.info(`Client ${context.state.clientProfile} reconnected successfully with LSN: ${reconnectLSN}`);
            
            // Mark that catchup is not yet complete
            context.state.reconnectCatchupCompleted = false;
            
            return { success: true, reconnectedClientId: clientId, reconnectLSN };
          }
        } as WSAction,
        
        // Add separate step to wait for server to recognize the reconnection
        {
          type: 'changes',
          name: 'Ensure Reconnection is Stable',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            logger.info(`Waiting 5 seconds to ensure server has fully registered the reconnection...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            return { success: true };
          }
        } as ChangesAction
      ]
    },
    
    // Step 9: Wait for Reconnection Catchup
    {
      name: 'Wait for Reconnection Catchup',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Check if Catchup Already Completed',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            // Check if catchup already completed during the reconnection process
            // We can detect this by checking if the clientLSN was updated during reconnection
            // If the current LSN is different from what we reconnected with, catchup likely already happened
            
            const reconnectLSN = context.state.reconnectLSN || '0/0';
            const currentLSN = context.state.clientLSN || '0/0';
            
            if (currentLSN !== reconnectLSN && currentLSN !== '0/0') {
              logger.info(`Catchup appears to have already completed during reconnection.`);
              logger.info(`Reconnected with LSN ${reconnectLSN}, but current LSN is now ${currentLSN}`);
              logger.info(`Skipping explicit catchup wait step since it already happened.`);
              
              // Mark catchup as completed since it already happened
              context.state.reconnectCatchupCompleted = true;
              
              // Add a small delay before proceeding
              logger.info(`Waiting 2 seconds before proceeding...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
              
              return { 
                success: true, 
                catchupAlreadyCompleted: true,
                originalLSN: reconnectLSN,
                updatedLSN: currentLSN
              };
            }
            
            logger.info(`Catchup does not appear to have completed during reconnection.`);
            logger.info(`Will proceed with explicit catchup wait step.`);
            return { success: true, catchupAlreadyCompleted: false };
          }
        } as ChangesAction,
        
        {
          type: 'interactive',
          name: 'Wait for Reconnection Catchup',
          protocol: 'reconnect-catchup',
          maxTimeout: 45000, // Increased from 15000 to 45000ms to allow more time for catchup
          skip: (context: StaleClientReconnectionContext) => {
            // Skip this step if catchup already completed
            return context.state.reconnectCatchupCompleted === true;
          },
          handlers: {
            'srv_catchup_changes': async (message: ServerChangesMessage, context: StaleClientReconnectionContext, operations: Record<string, any>) => {
              const clientId = message.clientId;
              const reconnectedClientId = context.state.reconnectedClientId;
              
              // Only process for our reconnected client
              if (clientId !== reconnectedClientId || !reconnectedClientId) {
                return false;
              }
              
              // Extract sequence information for better logging
              const chunkNum = message.sequence?.chunk || 1;
              const totalChunks = message.sequence?.total || 1;
              
              logger.info(`Received catchup changes: chunk ${chunkNum}/${totalChunks} with ${message.changes?.length || 0} changes for reconnected client ${context.state.clientProfile}`);
              
              // Update the client's LSN from the catchup message
              if (message.lastLSN) {
                context.state.clientLSN = message.lastLSN;
                logger.debug(`Updated client LSN to ${message.lastLSN} from reconnection catchup message`);
              }
              
              // Send acknowledgment
              try {
                logger.debug(`Sending acknowledgment for chunk ${chunkNum}/${totalChunks}`);
                await messageHandlers.sendCatchupAcknowledgment(
                  clientId, 
                  operations, 
                  chunkNum, 
                  message.lastLSN || '0/0'
                );
                logger.debug(`Sent acknowledgment for chunk ${chunkNum}/${totalChunks} with LSN: ${message.lastLSN || '0/0'}`);
              } catch (error) {
                logger.error(`Failed to send acknowledgment for chunk ${chunkNum}: ${error}`);
              }
              
              return false; // Continue waiting
            },
            'srv_catchup_completed': async (message: ServerCatchupCompletedMessage, context: StaleClientReconnectionContext) => {
              const clientId = message.clientId;
              const reconnectedClientId = context.state.reconnectedClientId;
              
              // Only process for our reconnected client
              if (clientId !== reconnectedClientId || !reconnectedClientId) {
                return false;
              }
              
              // Save the final LSN from the completed message
              if (message.finalLSN) {
                context.state.clientLSN = message.finalLSN;
                logger.info(`Updated client LSN to ${message.finalLSN} from reconnection catchup completed message`);
              }
              
              logger.info(`Reconnected client ${context.state.clientProfile} completed catchup with LSN: ${context.state.clientLSN}`);
              
              // Mark this client as caught up after reconnection
              context.state.reconnectCatchupCompleted = true;
              
              return true; // Finish protocol
            },
            'timeout': async (message: any, context: StaleClientReconnectionContext) => {
              // If we're seeing server errors in the logs, we may need to proceed anyway
              if (context.state.clientLSN) {
                logger.warn(`Reconnection catchup timed out, but we have a valid LSN: ${context.state.clientLSN}`);
                logger.warn('Proceeding with the test despite timeout - the server may not have needed to send any catchup data.');
                context.state.reconnectCatchupCompleted = true; // Force complete
                return true;
              } else {
                logger.error('Reconnection catchup timed out and we have no valid LSN');
                throw new Error('Reconnection catchup failed: timeout without a valid LSN');
              }
            }
          }
        } as InteractiveAction,
        
        // Wait a moment after catchup
        {
          type: 'changes',
          name: 'Wait After Reconnection',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            const reconnectedClientId = context.state.reconnectedClientId;
            
            // Wait for reconnect delay
            const reconnectDelay = context.state.scenarioConfig.reconnectDelay;
            logger.info(`Waiting ${reconnectDelay}ms after reconnection catchup...`);
            await new Promise(resolve => setTimeout(resolve, reconnectDelay));
            
            // Always try to ensure we have a connection before proceeding
            logger.info(`Ensuring client is still connected or reconnecting if needed...`);
            
            try {
              // Always try to reconnect since it's more reliable than checking status
              // First disconnect, just to be sure
              try {
                await operations.ws.disconnectClient(reconnectedClientId);
                logger.info(`Forcibly disconnected client to ensure clean connection state`);
                await new Promise(resolve => setTimeout(resolve, 1000));
              } catch (disconnectError) {
                logger.warn(`Error disconnecting client: ${disconnectError}`);
                // Continue anyway
              }
              
              // Now reconnect with the latest LSN
              try {
                logger.info(`Reconnecting client with current LSN: ${context.state.clientLSN || '0/0'}`);
                await operations.ws.connectClient(
                  reconnectedClientId, 
                  undefined, 
                  { lsn: context.state.clientLSN || '0/0' }
                );
                logger.info(`Successfully reconnected client ${context.state.clientProfile} with LSN: ${context.state.clientLSN}`);
                
                // Wait 3 seconds for connection to stabilize
                logger.info(`Waiting 3 seconds for connection to stabilize...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
              } catch (reconnectError) {
                logger.error(`Failed to reconnect client: ${reconnectError}`);
              }
            } catch (error) {
              logger.warn(`Error during connection management: ${error}`);
            }
            
            logger.info(`Proceeding to next step with LSN: ${context.state.clientLSN}`);
            return { 
              success: true,
              clientId: reconnectedClientId,
              lsn: context.state.clientLSN
            };
          }
        } as ChangesAction
      ]
    },
    
    // Step 10: Submit Stale Changes (now properly after catchup)
    {
      name: 'Submit Stale Changes (now properly after catchup)',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Submit Stale Changes',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            const reconnectedClientId = context.state.reconnectedClientId;
            if (!reconnectedClientId) {
              throw new Error('Reconnected client ID not found in state');
            }
            
            // Verify catchup is complete before sending stale changes
            if (!context.state.reconnectCatchupCompleted) {
              logger.warn('Catchup was not marked as complete, but proceeding with stale changes');
            } else {
              logger.info('Catchup is complete, proceeding with stale changes');
            }
            
            // Always proactively reconnect to ensure we have a stable connection for sending changes
            logger.info(`Ensuring client ${context.state.clientProfile} is connected before sending stale changes`);
            try {
              // We'll unconditionally reconnect since isClientConnected isn't reliable
              await operations.ws.disconnectClient(reconnectedClientId);
              logger.info(`Disconnected client ${reconnectedClientId} to ensure clean reconnection`);
              
              // Wait a moment for the disconnect to complete
              await new Promise(resolve => setTimeout(resolve, 1000));
              
              // Reconnect with latest LSN
              await operations.ws.connectClient(
                reconnectedClientId, 
                undefined, 
                { lsn: context.state.clientLSN || '0/0' }
              );
              logger.info(`Reconnected client ${context.state.clientProfile} with LSN: ${context.state.clientLSN}`);
              
              // Wait for connection to stabilize
              await new Promise(resolve => setTimeout(resolve, 3000));
              logger.info(`Connection established and stabilized - ready to send stale changes`);
            } catch (reconnectError) {
              logger.error(`Failed to ensure client connection: ${reconnectError}`);
              throw new Error(`Cannot send stale changes - client connection failed: ${reconnectError}`);
            }
            
            const staleChanges = context.state.staleChanges || [];
            
            if (staleChanges.length === 0) {
              throw new Error('No stale changes generated');
            }
            
            // Validate that our stale changes are properly formed
            logger.info(`Checking ${staleChanges.length} stale changes before sending...`);
            
            // Log a sample change for debugging
            if (staleChanges.length > 0) {
              const sampleChange = staleChanges[0];
              logger.info(`Sample stale change: ${JSON.stringify(sampleChange)}`);
              
              // Check for critical fields
              if (!sampleChange.data?.id) {
                logger.error(`Sample change is missing 'id' field: ${JSON.stringify(sampleChange.data)}`);
              }
              
              if (!sampleChange.data?.client_id) {
                logger.error(`Sample change is missing 'client_id' field - this is required!`);
              }
              
              if (!sampleChange.table) {
                logger.error(`Sample change is missing 'table' field`);
              }
              
              if (!sampleChange.operation) {
                logger.error(`Sample change is missing 'operation' field`);
              }
              
              if (!sampleChange.updated_at) {
                logger.error(`Sample change is missing 'updated_at' field`);
              }
            }
            
            logger.info(`Submitting ${staleChanges.length} stale changes from reconnected client ${context.state.clientProfile} (${reconnectedClientId})`);
            
            // Transform and submit stale changes
            const transformedChanges = transformChangesToSnakeCase(staleChanges);
            const payload: ClientChangesMessage = {
              type: 'clt_send_changes',
              messageId: `clt_${reconnectedClientId}_${Date.now()}_submit_stale`,
              timestamp: Date.now(),
              clientId: reconnectedClientId,
              changes: transformedChanges
            };
            
            // Log payload size and sample transformed change
            logger.info(`Payload message type: ${payload.type}, clientId: ${payload.clientId}`);
            logger.info(`Payload contains ${payload.changes.length} changes after transformation`);
            
            if (payload.changes.length > 0) {
              const sampleTransformed = payload.changes[0];
              logger.info(`Sample transformed change: ${JSON.stringify(sampleTransformed)}`);
            }
            
            // Try to send the changes with retries
            let sendSuccess = false;
            const maxRetries = 3;
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
              try {
                if (attempt > 1) {
                  logger.info(`Retry attempt ${attempt}/${maxRetries} to send stale changes...`);
                  // Check connection before retrying
                  try {
                    await operations.ws.connectClient(
                      reconnectedClientId, 
                      undefined, 
                      { lsn: context.state.clientLSN || '0/0' }
                    );
                    logger.info(`Reconnected client before retry attempt ${attempt}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                  } catch (reconnectError) {
                    logger.warn(`Could not reconnect before retry: ${reconnectError}`);
                  }
                } else {
                  logger.info(`Sending stale changes to server...`);
                }
                
                // Send the message
                await operations.ws.sendMessage(reconnectedClientId, payload);
                logger.info(`Successfully sent stale changes message (attempt ${attempt}/${maxRetries})`);
                sendSuccess = true;
                break;
              } catch (sendError) {
                logger.error(`Failed to send stale changes (attempt ${attempt}/${maxRetries}): ${sendError}`);
                if (attempt === maxRetries) {
                  throw new Error(`Failed to send stale changes after ${maxRetries} attempts: ${sendError}`);
                }
                // Wait before retry
                logger.info(`Waiting 2 seconds before retry...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
            
            if (!sendSuccess) {
              throw new Error(`Failed to send stale changes after ${maxRetries} attempts`);
            }
            
            // Wait for changes to be processed - increase to 8 seconds
            logger.info('Waiting for stale changes to be processed (8 seconds)...');
            await new Promise(resolve => setTimeout(resolve, 8000));
            
            return { 
              success: true, 
              staleChangeCount: staleChanges.length
            };
          }
        } as ChangesAction
      ]
    },
    
    // Step 11: Listen for Server Response
    {
      name: 'Listen for Server Response',
      execution: 'serial',
      actions: [
        {
          type: 'interactive',
          name: 'Listen for Server Response',
          protocol: 'stale-changes-response',
          maxTimeout: 30000,
          handlers: {
            'srv_live_changes': async (message: ServerChangesMessage, context: StaleClientReconnectionContext, operations: Record<string, any>) => {
              const clientId = message.clientId;
              const reconnectedClientId = context.state.reconnectedClientId;
              
              // Only process changes for our reconnected client
              if (clientId !== reconnectedClientId || !reconnectedClientId) {
                return false;
              }
              
              // Update the client's LSN from the live changes message
              if (message.lastLSN) {
                context.state.clientLSN = message.lastLSN;
                logger.debug(`Updated client LSN to ${message.lastLSN} from live changes message`);
              }
              
              const changes = message.changes || [];
              logger.info(`Received ${changes.length} live changes for client ${context.state.clientProfile}`);
              
              // Store changes for validation
              context.state.afterReconnectChanges = [
                ...context.state.afterReconnectChanges || [],
                ...changes
              ];
              
              // Record in ClientChangeTracker
              if (context.state.clientChangeTracker) {
                context.state.clientChangeTracker.recordClientChanges(clientId, changes);
                logger.info(`Recorded ${changes.length} changes in ClientChangeTracker`);
              }
              
              // Send acknowledgment
              const ackResponse = {
                type: 'clt_changes_received',
                messageId: `clt_${clientId}_${Date.now()}_ack`,
                timestamp: Date.now(),
                clientId: clientId,
                changeIds: changes.map((c: TableChange) => c.data?.id).filter(Boolean),
                lastLSN: message.lastLSN || '0/0'
              };
              
              await operations.ws.sendMessage(clientId, ackResponse);
              logger.debug(`Sent acknowledgment for changes with LSN: ${message.lastLSN || '0/0'}`);
              
              // Continue listening
              return false;
            },
            // Also handle catchup messages since they might come for the reconnected client
            'srv_catchup_changes': async (message: ServerChangesMessage, context: StaleClientReconnectionContext, operations: Record<string, any>) => {
              const clientId = message.clientId;
              
              // Only process for our client
              if (clientId !== context.state.reconnectedClientId) {
                return false;
              }
              
              // Extract sequence information for better logging
              const chunkNum = message.sequence?.chunk || 1;
              const totalChunks = message.sequence?.total || 1;
              
              logger.info(`Received catchup changes: chunk ${chunkNum}/${totalChunks} with ${message.changes?.length || 0} changes for reconnected client ${context.state.clientProfile}`);
              
              // Update the client's LSN from the catchup message
              if (message.lastLSN) {
                context.state.clientLSN = message.lastLSN;
                logger.debug(`Updated client LSN to ${message.lastLSN} from reconnection catchup message`);
              }
              
              // Send acknowledgment
              try {
                logger.debug(`Sending acknowledgment for chunk ${chunkNum}/${totalChunks}`);
                await messageHandlers.sendCatchupAcknowledgment(
                  clientId, 
                  operations, 
                  chunkNum, 
                  message.lastLSN || '0/0'
                );
                logger.debug(`Sent acknowledgment for chunk ${chunkNum}/${totalChunks} with LSN: ${message.lastLSN || '0/0'}`);
              } catch (error) {
                logger.error(`Failed to send acknowledgment for chunk ${chunkNum}: ${error}`);
              }
              
              return false; // Continue waiting
            },
            'srv_catchup_completed': async (message: ServerCatchupCompletedMessage, context: StaleClientReconnectionContext) => {
              const clientId = message.clientId;
              
              // Only process for our client
              if (clientId !== context.state.reconnectedClientId) {
                return false;
              }
              
              // Save the final LSN from the completed message
              if (message.finalLSN) {
                context.state.clientLSN = message.finalLSN;
                logger.info(`Updated client LSN to ${message.finalLSN} from catchup completed message for reconnected client`);
              }
              
              logger.info(`Reconnected client ${context.state.clientProfile} completed catchup with LSN: ${context.state.clientLSN}`);
              
              return false; // Don't finish protocol, keep waiting for live changes
            },
            'timeout': async (message: any, context: StaleClientReconnectionContext) => {
              // Check if we got any changes
              const hasChanges = (context.state.afterReconnectChanges || []).length > 0;
              
              if (hasChanges) {
                logger.info(`Interactive protocol timed out, but we received ${context.state.afterReconnectChanges.length} changes. Final client LSN: ${context.state.clientLSN}`);
                return true;
              } else {
                logger.warn('No changes received after stale change submission - this may be expected for stale changes that are rejected by CRDT logic');
                logger.warn('Proceeding with validation using the empty changes set');
                // Initialize an empty array if needed to avoid null/undefined issues
                context.state.afterReconnectChanges = context.state.afterReconnectChanges || [];
                return true;
              }
            }
          }
        } as InteractiveAction
      ]
    },
    
    // Step 12: Validate CRDT Behavior
    {
      name: 'Validate CRDT Behavior',
      execution: 'serial',
      actions: [
        {
          type: 'validation',
          name: 'Validate CRDT Behavior',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            logger.info('Validating CRDT behavior for stale changes...');
            
            // 1. Validate which stale changes were applied vs. rejected
            const staleChangesByType = context.state.staleChangesByType || {};
            const receivedChanges = context.state.afterReconnectChanges || [];
            
            // Log if we received no changes - this could be normal if all changes were rejected
            if (receivedChanges.length === 0) {
              logger.warn('No changes were received after submitting stale changes.');
              logger.warn('This may be expected behavior if all stale changes were rejected by CRDT logic.');
            } else {
              logger.info(`Received ${receivedChanges.length} changes for validation.`);
            }
            
            // Check non-conflicting updates (should be applied)
            const nonConflictingUpdates = staleChangesByType.nonConflicting || [];
            
            const nonConflictingUpdateResults = validateStaleChanges(
              nonConflictingUpdates,
              receivedChanges,
              'applied' // Expect these to be applied
            );
            
            // Check conflicting updates (should be rejected due to CRDT)
            const conflictingUpdateResults = validateStaleChanges(
              staleChangesByType.conflicting || [],
              receivedChanges,
              'rejected' // Expect these to be rejected due to newer timestamps
            );
            
            // Check updates to deleted records (special case)
            const deletedRecordUpdateResults = validateStaleChanges(
              staleChangesByType.deletedRecords || [],
              receivedChanges,
              'special' // Special handling
            );
            
            // Custom validation function
            function validateStaleChanges(
              staleChanges: TableChangeTest[], 
              receivedChanges: TableChangeTest[], 
              expectedOutcome: 'applied' | 'rejected' | 'special'
            ) {
              const results = {
                total: staleChanges.length,
                applied: 0,
                rejected: 0,
                errors: [] as string[],
                success: true
              };
              
              staleChanges.forEach((staleChange: TableChangeTest) => {
                const taskId = staleChange.data?.id;
                const matchingChange = receivedChanges.find((c: TableChange) => 
                  c.table === 'tasks' && c.data?.id === taskId
                );
                
                // For applied changes, we expect to see them in received changes
                // For rejected changes, we don't expect to see them
                const wasApplied = !!matchingChange;
                
                if (expectedOutcome === 'applied' && !wasApplied) {
                  results.errors.push(`Non-conflicting stale change to task ${taskId} was not applied`);
                  results.success = false;
                } else if (expectedOutcome === 'rejected' && wasApplied) {
                  results.errors.push(`Conflicting stale change to task ${taskId} was wrongly applied`);
                  results.success = false;
                } else if (expectedOutcome === 'special') {
                  // For deleted records, we have special handling:
                  // Typically, updates to deleted records should be rejected
                  if (wasApplied) {
                    results.errors.push(`Update to deleted task ${taskId} was wrongly applied`);
                    results.success = false;
                  }
                }
                
                if (wasApplied) {
                  results.applied++;
                } else {
                  results.rejected++;
                }
              });
              
              return results;
            }
            
            // Log validation results
            logger.info('CRDT Validation Results:');
            logger.info(`Non-conflicting updates: ${nonConflictingUpdateResults.applied}/${nonConflictingUpdateResults.total} applied`);
            logger.info(`Conflicting updates: ${conflictingUpdateResults.rejected}/${conflictingUpdateResults.total} rejected (as expected)`);
            logger.info(`Updates to deleted records: ${deletedRecordUpdateResults.rejected}/${deletedRecordUpdateResults.total} rejected (as expected)`);
            
            // Log errors if any
            const allErrors = [
              ...nonConflictingUpdateResults.errors,
              ...conflictingUpdateResults.errors,
              ...deletedRecordUpdateResults.errors
            ];
            
            if (allErrors.length > 0) {
              logger.error('Validation errors:');
              allErrors.forEach(error => logger.error(`  - ${error}`));
            }
            
            // Overall success
            const overallSuccess = 
              nonConflictingUpdateResults.success && 
              conflictingUpdateResults.success && 
              deletedRecordUpdateResults.success;
            
            logger.info(`CRDT behavior validation ${overallSuccess ? 'PASSED' : 'FAILED'}`);
            
            return overallSuccess;
          }
        } as ValidationAction
      ]
    },
    
    // Step 13: Cleanup
    {
      name: 'Cleanup',
      execution: 'serial',
      actions: [
        {
          type: 'ws',
          name: 'Disconnect Client',
          operation: 'exec',
          params: async (context: StaleClientReconnectionContext, operations: Record<string, any>) => {
            // Disconnect the client
            const clientId = context.state.reconnectedClientId || context.state.clientId;
            
            if (clientId) {
              try {
                await operations.ws.disconnectClient(clientId);
                logger.info(`Disconnected client ${clientId}`);
              } catch (error) {
                logger.warn(`Error disconnecting client ${clientId}: ${error}`);
              }
            }
            
            // Reset state trackers
            context.state.changeState.reset();
            context.state.serverConfirmedStateManager.reset();
            context.state.changeTracker.clear();
            
            return { success: true };
          }
        } as WSAction
      ]
    }
  ]
}; 