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
  Action, 
  StepDefinition, 
  ApiAction, 
  ChangesAction, 
  WSAction, 
  ValidationAction,
  InteractiveAction,
  CompositeAction,
  OperationContext 
} from '../core/scenario-runner.ts';
import { messageDispatcher } from '../core/message-dispatcher.ts';
import type {
  ServerChangesMessage,
  ServerCatchupCompletedMessage,
  TableChange,
  ClientChangesMessage // Added for client submission
} from '@repo/sync-types';

// Import core sync modules from entity-changes
import { DataSource } from 'typeorm';
import { serverEntities, Task, User, Project } from '@repo/dataforge/server-entities'; // Added Task, User, Project
import { initialize } from '../core/entity-changes/change-applier.ts';
import { generateAndApplyMixedChanges } from '../core/entity-changes/batch-changes.ts';
import { ChangeTracker } from '../core/entity-changes/change-tracker.ts';
import { TableChangeTest } from '../core/entity-changes/types.ts';
import { 
  validateChanges, 
  ValidationOptions,
  lookupExtraChangesDetails,
  SyncValidationResult
} from '../core/entity-changes/validation.ts';
import { ChangeStateManager } from '../core/entity-changes/change-state.ts';
import { entityToChange } from '../core/entity-changes/change-builder.ts'; // Added for converting entities
import { createTask, createUser, createProject } from '../core/entity-changes/entity-factories.ts'; // Added createProject
import {
    transformChangesToSnakeCase
} from '../core/client-actions.ts'; // Import the new helper functions
import { 
  validateClientChangesWithConflicts, 
  calculateExpectedReceiveCounts,
  generateValidationSummary
} from '../core/entity-changes/client-change-validation.ts';
import { ClientChangeTracker } from '../core/entity-changes/client-change-tracker.ts';
import { ClientChangeStateManager } from '../core/entity-changes/client-change-state.ts';
import { 
  generateClientMixedSubmitChanges,
  generateClientConflictUpdateChange
} from '../core/entity-changes/client-submit-changes.ts';

// Import the new sync test helpers
import {
  createTestDataSource,
  initializeTestDatabase,
  createBaseEntities,
  createTestTasks,
  initializeSyncStateTrackers,
  messageHandlers,
  logMatchInfo as logChangeMatchInfo,
  validationHelpers
} from '../core/sync-test-helpers.ts';

// Define a more specific context type for this scenario
interface ClientSubmitSyncContext extends OperationContext {
  results?: {
    initialLsnResult?: { 
      success?: boolean;
      lsn?: string;
    };
  };
  // Use a more general type for the state
  state: OperationContext['state'] & {
    initialServerLSN?: string;
    clients: string[];
    clientProfiles: Record<string, number>;
    clientSubmittedChanges: Record<string, TableChangeTest[]>;
    clientReceivedChanges: Record<string, TableChangeTest[]>;
    clientConflictChanges: Record<string, TableChangeTest | null>;
    clientCatchupCompleted: Record<string, boolean>;
    clientChangesCompleted: Record<string, boolean>;
    expectedReceivedCounts: Record<string, number>;
    clientChangeTracker: ClientChangeTracker;
    scenarioConfig: {
      clientCount: number;
      changesPerClient: number;
      changeDistribution: Record<string, number>;
      conflictConfig: Record<string, any>;
    };
  };
}

// Logger for this module
const logger = createLogger('sync.client-submit');

// Create database connection using the helper
const dataSource = createTestDataSource();

// Add a property to TableChangeTest to allow storing origin client ID
declare module '../core/entity-changes/types.ts' {
  interface TableChangeTest {
    _originClientId?: string;
  }
}

/**
 * Client Submit Sync Test Scenario
 * 
 * Tests the ability of multiple clients to concurrently submit changes
 * and validates that changes are propagated correctly without self-echoing.
 * Includes a CRDT conflict test case.
 */
export const ClientSubmitSyncScenario: Scenario = {
  name: 'Client Submit Sync Test',
  description: 'Tests clients submitting unique and conflicting changes to the server',
  config: {
    timeout: 90000, // Test timeout in milliseconds
    changeCount: 5,  // Required by TestConfig type, but we use changesPerClient instead
    customProperties: {
      clientCount: 2,     // Number of clients to create and test with
      changesPerClient: 5 // Number of changes each client will generate and submit
    }
  },
  
  hooks: {
    /**
     * Initializes the scenario environment
     */
    beforeScenario: async (context: OperationContext) => {
      // Simplify config extraction
      const clientCount = context.config.customProperties?.clientCount || 2;
      const changesPerClient = context.config.customProperties?.changesPerClient || 5;
      
      // Use predefined defaults from modules for other configs
      const conflictConfig = {
        enabled: true,
        entity: 'tasks',
        field: 'title',
        numberOfConflictTasks: 3,
        conflictBatchSize: 2,
        conflictDistribution: {
          type: 'overlap',
          overlapCount: 1
        }
      };
      
      // Standard change distribution
      const changeDistribution = { task: 0.5, comment: 0.3, project: 0.2 };
      
      // Store the simplified config
      context.state.scenarioConfig = {
        clientCount,
        changesPerClient,
        changeDistribution,
        conflictConfig
      };

      // Initialize batch tracking
      context.state.batchTracking = {
        batches: [],
        currentBatch: {
          number: 0,
          startTime: Date.now(),
          changes: {}
        }
      };

      // Initialize conflict task tracking
      context.state.conflictTasks = [];
      context.state.conflictWinners = {};

      context.logger.info(`Starting Client Submit Sync test with ${clientCount} clients, ${changesPerClient} changes/client.`);
      context.logger.info(`Conflict generation: Enabled`);
      
      // Ensure client count is at least 2 for conflict testing
      if (clientCount < 2) {
        throw new Error('ClientSubmitSyncScenario requires at least 2 clients for conflict testing.');
      }

      // Register clean message handlers using the helper function
      messageHandlers.registerCleanHandlers();
      
      // Create a fresh ClientChangeTracker using the helper function
      context.state.clientChangeTracker = messageHandlers.initializeClientChangeTracker();
      context.logger.info('Created fresh ClientChangeTracker for this test run');
      
      // Initialize state tracking structures per client
      context.state.clientSubmittedChanges = {};
      context.state.clientConflictChanges = {};
      context.state.clientReceivedChanges = {};
      context.state.clientCatchupCompleted = {};
      context.state.clientProfiles = {};
      context.state.clientChangesCompleted = {};
      context.state.expectedReceivedCounts = {};
      context.state.clientChangesPossiblyComplete = {};
      
      // State for the conflict record
      context.state.conflictRecordId = null;
      context.state.conflictRecordOwnerId = null;
      context.state.defaultProjectId = null;
      context.state.existingUserIdForClientGen = null;

      // Initialize state trackers using the helper
      const stateTrackers = initializeSyncStateTrackers({ inactivityTimeout: 15000 });
      context.state.changeState = stateTrackers.changeState;
      context.state.serverConfirmedStateManager = stateTrackers.serverConfirmedStateManager;
      context.state.changeTracker = stateTrackers.changeTracker;
      context.state.catchupActivityTracker = stateTrackers.catchupActivityTracker;

      // Track overall DB changes applied (will be populated during validation)
      context.state.finalDatabaseChanges = [];
      context.state.databaseValidationSkipped = !context.config.customProperties?.validateDatabase;
      context.state.clientTrackingStartTime = {};
    }
  },
  
  steps: [
    // Step 1: Initialize Environment & Create Conflict Record
    {
      name: 'Initialize Environment and Conflict Record',
      execution: 'serial',
      actions: [
        // Initialize database using the helper function
        {
          type: 'changes',
          name: 'Initialize Database',
          operation: 'exec',
          params: async (context: OperationContext) => {
            return { success: await initializeTestDatabase(dataSource) };
          }
        } as ChangesAction,
        
        // Initialize server replication FIRST
        {
          type: 'api',
          name: 'Initialize Server Replication',
          endpoint: '/api/replication/init',
          method: 'POST',
        } as ApiAction,
        
        // Get Initial Server LSN AFTER initialization
        {
          type: 'api',
          name: 'Get Initial Server LSN',
          endpoint: '/api/replication/lsn',
          method: 'GET',
          storeResultAs: 'initialLsnResult'
        } as ApiAction,
        
        // Log the initial LSN - correctly process response structure
        {
          type: 'changes',
          name: 'Log Initial Server LSN',
          operation: 'exec',
          params: async (context: ClientSubmitSyncContext) => {
            const apiResult = context.results?.initialLsnResult;
            // The endpoint returns { success: true, lsn: "0/16FDD318" }
            const initialServerLSN = apiResult?.lsn || '0/0';
            context.state.initialServerLSN = initialServerLSN;
            context.logger.info(`Initial Server LSN (from API): ${initialServerLSN}`);
            if (initialServerLSN === '0/0') {
              context.logger.warn('Failed to retrieve initial LSN from API response.', apiResult);
            }
            return { success: true, lsn: initialServerLSN };
          }
        } as ChangesAction,
        
        // Create base entities using the helper function
        {
          type: 'changes',
          name: 'Create Base Entities',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const { ownerId, projectId } = await createBaseEntities(operations);
            
            // Store IDs in state for later use
            context.state.conflictRecordOwnerId = ownerId;
            context.state.existingUserIdForClientGen = ownerId;
            context.state.defaultProjectId = projectId;
            
            context.logger.info(`Created test user (${ownerId}) and project (${projectId})`);
            return { success: true, ownerId, projectId };
          }
        } as ChangesAction,
        
        // Create conflict task records using the helper function
        {
          type: 'changes',
          name: 'Create Conflict Task Records',
          operation: 'exec',
          params: async (context: ClientSubmitSyncContext, operations: Record<string, any>) => {
            const conflictConfig = context.state.scenarioConfig?.conflictConfig;
            const changesPerClient = context.state.scenarioConfig?.changesPerClient || 5;
            
            // Calculate how many conflict tasks we need based on batch size
            // For a batch approach of "4 normal + 1 conflict", we need (changes/5) conflict tasks per client
            const batchSize = 5; // 4 regular + 1 conflict
            const conflictTasksPerClient = Math.ceil(changesPerClient / batchSize);
            const clientCount = context.state.scenarioConfig?.clientCount || 2;
            
            // We need enough conflict tasks to support all clients
            // Each client needs conflictTasksPerClient tasks, but they can share some tasks
            const numberOfConflictTasks = Math.max(
              conflictConfig?.numberOfConflictTasks || 3,
              Math.ceil(clientCount * conflictTasksPerClient * 0.7) // Assume some task sharing (70%)
            );
            
            context.logger.info(`Creating ${numberOfConflictTasks} conflict tasks to support ${clientCount} clients with ${changesPerClient} changes each`);
            context.logger.info(`Each client will have ~${conflictTasksPerClient} conflict changes in batches of ${batchSize}`);
            
            const ownerId = context.state.conflictRecordOwnerId;
            const projectId = context.state.defaultProjectId;
            
            if (!ownerId || !projectId) {
              throw new Error('Owner ID or Project ID not found in state.');
            }
            
            // Use the helper function to create conflict tasks
            const conflictTasks = await createTestTasks(
              ownerId, 
              projectId, 
              numberOfConflictTasks, 
              operations,
              { namePrefix: 'Conflict Task' }
            );
            
            // Store the conflict tasks in state
            context.state.conflictTasks = conflictTasks;
            
            return { success: true, taskIds: conflictTasks.map(t => t.id) };
          }
        } as ChangesAction,
        
        // Wait for WAL processing
        {
          type: 'changes',
          name: 'Wait for WAL Processing',
          operation: 'exec',
          params: async (context: OperationContext) => {
            context.logger.info('Waiting 10 seconds for WAL processing...');
            await new Promise(resolve => setTimeout(resolve, 10000));
            return { success: true };
          }
        } as ChangesAction
      ]
    },

    // Step 2: Set Up Clients (Identical to live-sync)
    {
        name: 'Set Up Clients',
        execution: 'serial',
        actions: [
            {
            type: 'ws',
            name: 'Create and Setup WebSocket Clients',
            operation: 'exec',
            params: async (context: OperationContext, operations: Record<string, any>) => {
                const clientCount = context.config.customProperties?.clientCount || 2;
                const latestLSN = context.state.initialServerLSN || '0/0'; // Use the latest LSN from API
                context.logger.info(`Creating ${clientCount} WebSocket clients with initial LSN: ${latestLSN}`);
                const clients: string[] = [];
                for (let i = 0; i < clientCount; i++) {
                    const profileId = i + 1;
                    // Create client with the latest LSN to avoid lengthy catchup
                    const clientId = await operations.ws.createClient(profileId, latestLSN);
                    clients.push(clientId);
                    context.state.clientProfiles[clientId] = profileId;
                    // Initialize state holders for this client
                    context.state.clientSubmittedChanges[clientId] = [];
                    context.state.clientReceivedChanges[clientId] = [];
                    context.state.clientConflictChanges[clientId] = null;
                    context.state.clientCatchupCompleted[clientId] = false; 
                    context.state.clientChangesCompleted[clientId] = false;
                    await operations.ws.setupClient(clientId);
                    context.logger.info(`Created and set up client ${profileId} (${clientId}) with LSN: ${latestLSN}`);
                }
                context.state.clients = clients; // Store the array of client IDs
                context.logger.info(`All ${clientCount} clients created and set up.`);
                return { success: true, clients };
            }
            } as WSAction
        ]
    },

    // Step 3: Wait For Catchup Sync
    {
      name: 'Wait For Catchup Sync',
      execution: 'serial', // Ensure all clients catch up before proceeding
      actions: [
        {
          type: 'interactive',
          name: 'Wait for Catchup Sync',
          protocol: 'catchup-sync',
          maxTimeout: 60000, // 60 seconds
          handlers: {
            'srv_catchup_changes': async (message: ServerChangesMessage, context: OperationContext, operations: Record<string, any>) => {
              const clientId = message.clientId || context.state.clients[0]; // Assuming message has clientId
              const profileId = context.state.clientProfiles[clientId] || '?';
              const chunkNum = message.sequence?.chunk || 1;
              context.logger.info(`Received catchup changes chunk ${chunkNum} for client ${profileId}`);
              // Catchup changes are ignored for validation in this test
              
              // Send the catchup acknowledgment using the helper function
              await messageHandlers.sendCatchupAcknowledgment(clientId, operations, chunkNum, message.lastLSN || '0/0'); 
              context.logger.debug(`Sent clt_catchup_received for chunk ${chunkNum} (Client ${profileId})`);

              return false; // Continue waiting
            },
            'srv_catchup_completed': async (message: ServerCatchupCompletedMessage, context: OperationContext) => {
              const clientId = message.clientId;
              const profileId = context.state.clientProfiles[clientId] || '?';
              context.state.clientCatchupCompleted[clientId] = true; // Mark client as caught up
              context.logger.info(`Client ${profileId} completed catchup sync.`);
              // Check if all clients are done
              const allCompleted = context.state.clients.every((cId: string) => context.state.clientCatchupCompleted[cId]);
              if (allCompleted) {
                context.logger.info(`All ${context.state.clients.length} clients completed catchup.`);
                return true; // Finish the protocol
              }
              return false; // Not all clients finished yet
            },
            'timeout': async (message: any, context: OperationContext) => {
               context.logger.error(`Catchup sync timed out!`);
               throw new Error('Catchup sync timed out.'); // Fail the test
            }
          }
        } as InteractiveAction
      ]
    },
    
    // Step 5: Generate Client Changes (Serial)
    {
        name: 'Generate Client Changes',
        execution: 'serial',
        actions: [
            {
                type: 'changes', // Using changes action for context access
                name: 'Prepare Changes and Expected Counts',
                operation: 'exec',
                params: async (context: OperationContext, operations: Record<string, any>) => {
                    const clients = context.state.clients || [];
                    const { clientCount, changesPerClient } = context.state.scenarioConfig;
                    
                    // Calculate expected received count (non-echoed)
                    // Each client receives changes from all other clients
                    const expectedReceivedCount = (clientCount - 1) * changesPerClient;
                    context.logger.info(`Calculating changes for ${clientCount} clients (${changesPerClient} each). Expecting ${expectedReceivedCount} non-echoed changes per client.`);

                    context.state.clientSubmittedChanges = {}; // Ensure clean state
                    context.state.expectedReceivedCounts = {};
                    
                    // Define batch size for a more realistic mix (4 normal + 1 conflict)
                    const batchSize = 5;
                    const conflictTasks = context.state.conflictTasks || [];
                    const conflictTaskCount = conflictTasks.length;
                    
                    if (conflictTaskCount === 0) {
                        context.logger.warn('No conflict tasks found. Will generate regular changes only.');
                    } else {
                        context.logger.info(`Using ${conflictTaskCount} conflict tasks for generating realistic batches of changes.`);
                    }

                    // Generate changes for each client
                    for (let i = 0; i < clients.length; i++) {
                        const clientId = clients[i];
                        const profileId = context.state.clientProfiles[clientId];
                        
                        // Prepare to store all changes for this client
                        let allClientChanges: TableChangeTest[] = [];
                        
                        // Calculate how many full batches we need and any remaining changes
                        const fullBatchCount = Math.floor(changesPerClient / batchSize);
                        const remainingChanges = changesPerClient % batchSize;
                        
                        context.logger.info(`[Client ${profileId}] Generating ${fullBatchCount} full batches and ${remainingChanges} remaining changes.`);
                        
                        // Generate full batches (4 regular + 1 conflict)
                        for (let batchIdx = 0; batchIdx < fullBatchCount; batchIdx++) {
                            // Select a conflict task (rotate through available tasks)
                            const conflictTaskIndex = (i + batchIdx) % conflictTaskCount;
                            const conflictTask = conflictTasks[conflictTaskIndex];
                            
                            // Configure conflict options for this batch
                            const conflictOptions = {
                                recordId: conflictTask?.id,
                                entity: 'tasks',
                                field: 'title',
                                index: i // Client index for determining conflict winner
                            };
                            
                            // First generate 4 regular changes
                            const regularChanges = await generateClientMixedSubmitChanges(
                                batchSize - 1, // 4 regular changes
                                undefined, // Use default distribution from module
                                clientId,
                                {
                                    projectId: context.state.defaultProjectId,
                                    assigneeId: context.state.conflictRecordOwnerId,
                                    ownerId: context.state.conflictRecordOwnerId,
                                },
                                undefined // No conflict for regular changes
                            );
                            
                            // Then generate 1 conflict change
                            const conflictChange = generateClientConflictUpdateChange(
                                conflictOptions.recordId,
                                clientId,
                                conflictOptions.index,
                                clientId
                            );
                            
                            // Combine regular and conflict changes
                            const batchChanges = [...regularChanges, conflictChange];
                            context.logger.info(`[Client ${profileId}] Batch ${batchIdx+1}: Generated ${batchChanges.length} changes (${regularChanges.length} regular, 1 conflict on task ${conflictTaskIndex+1}).`);
                            
                            // Add to client's changes
                            allClientChanges = [...allClientChanges, ...batchChanges];
                        }
                        
                        // If we have remaining changes (less than a full batch), add them as regular changes
                        if (remainingChanges > 0) {
                            const regularChanges = await generateClientMixedSubmitChanges(
                                remainingChanges,
                                undefined,
                                clientId,
                                {
                                    projectId: context.state.defaultProjectId,
                                    assigneeId: context.state.conflictRecordOwnerId,
                                    ownerId: context.state.conflictRecordOwnerId,
                                },
                                undefined // No conflict for these remaining changes
                            );
                            
                            context.logger.info(`[Client ${profileId}] Adding ${remainingChanges} remaining regular changes.`);
                            allClientChanges = [...allClientChanges, ...regularChanges];
                        }

                        // Store generated changes and expected count
                        context.state.clientSubmittedChanges[clientId] = allClientChanges;
                        context.state.expectedReceivedCounts[clientId] = expectedReceivedCount;
                        context.logger.info(`[Client ${profileId}] Generated ${allClientChanges.length} total changes. Stored.`);
                    }
                    
                    // Track all conflict task IDs for validation
                    context.state.allConflictTaskIds = conflictTasks.map((task: Task) => task.id);

                    // Determine actual conflict winners based on timestamps
                    // We need to do this per conflict task
                    context.state.conflictWinners = {};
                    
                    // For each conflict task, determine the winner
                    for (const conflictTask of conflictTasks) {
                        const conflictTaskId = conflictTask.id;
                        let actualWinnerClientId: string | null = null;
                        let latestTimestamp = '';
                        
                        // Check all clients for updates to this conflict task
                        for (const clientId of clients) {
                            const submittedChanges = context.state.clientSubmittedChanges[clientId] || [];
                            const conflictChange = submittedChanges.find((change: TableChangeTest) => 
                                change.operation === 'update' && change.data?.id === conflictTaskId
                            );

                            if (conflictChange && conflictChange.updated_at) {
                                if (conflictChange.updated_at > latestTimestamp) {
                                    latestTimestamp = conflictChange.updated_at;
                                    actualWinnerClientId = clientId;
                                }
                            }
                        }
                        
                        if (actualWinnerClientId) {
                            context.state.conflictWinners[conflictTaskId] = actualWinnerClientId;
                            const winnerProfileId = context.state.clientProfiles[actualWinnerClientId];
                            context.logger.info(`Determined conflict winner for task ${conflictTaskId}: Client ${winnerProfileId} (${actualWinnerClientId}) with timestamp ${latestTimestamp}`);
                        }
                    }
                    
                    // For backwards compatibility, also store the first winner
                    if (conflictTasks.length > 0) {
                        const firstConflictTaskId = conflictTasks[0].id;
                        context.state.actualConflictWinnerClientId = context.state.conflictWinners[firstConflictTaskId];
                    }

                    return { success: true };
                }
            } as ChangesAction
        ]
    },

    // Step 6: Send Client Changes (Parallel)
    {
      name: 'Send Client Changes',
      execution: 'parallel', // Run the single action in parallel mode (params will handle concurrent sends)
      actions: [
        // Use a single ChangesAction; its params will loop and send concurrently
        {
            type: 'changes', // Use ChangesAction to easily access context/operations
            name: 'Send Pre-Generated Changes for All Clients',
            operation: 'exec',
            params: async (context: OperationContext, operations: Record<string, any>) => {
                const clients = context.state.clients || [];
                context.logger.info(`Initiating parallel change submission for ${clients.length} clients.`);
                const sendPromises: Promise<any>[] = [];

                clients.forEach((clientId: string) => {
                    const profileId = context.state.clientProfiles[clientId];
                    const changesToSubmit = context.state.clientSubmittedChanges[clientId] || [];

                    if (changesToSubmit.length === 0) {
                        context.logger.warn(`[Client ${profileId}] No pre-generated changes found to submit. Skipping send.`);
                        // Resolve immediately if no changes
                        sendPromises.push(Promise.resolve({ clientId, success: true, sent: 0 }));
                            } else {
                        const payload: ClientChangesMessage = {
                            type: 'clt_send_changes',
                            messageId: `clt_${clientId}_${Date.now()}_submit`,
                            timestamp: Date.now(),
                            clientId: clientId, // Top-level clientId
                            changes: transformChangesToSnakeCase(changesToSubmit)
                        };

                        // <<< Logging >>>
                        if (payload.changes.length > 0) {
                            const sampleChange = payload.changes[0]; 
                            context.logger.info(`[Client ${profileId}] PRE-SEND check: Change 0 data: ${JSON.stringify(sampleChange.data)}`);
                            if (sampleChange.data && sampleChange.data.client_id) {
                                context.logger.info(`[Client ${profileId}] PRE-SEND check: client_id field FOUND: ${sampleChange.data.client_id}`);
                            } else {
                                context.logger.error(`[Client ${profileId}] PRE-SEND check: client_id field MISSING in data!`);
                            }
                        }
                        // <<< End Logging >>>

                        // Add the sendMessage promise to the array
                        sendPromises.push(
                            operations.ws.sendMessage(clientId, payload)
                                .then(() => {
                                    context.logger.info(`[Client ${profileId}] Submitted ${changesToSubmit.length} changes.`);
                                    return { clientId, success: true, sent: changesToSubmit.length };
                                })
                                .catch((err: any) => {
                                     context.logger.error(`[Client ${profileId}] FAILED to submit changes: ${err}`);
                                     return { clientId, success: false, error: String(err) };
                                })
                        );
                    }
                });

                // Wait for all send operations to complete
                const results = await Promise.all(sendPromises);
                const failedSends = results.filter(r => !r.success);

                if (failedSends.length > 0) {
                    throw new Error(`${failedSends.length} client(s) failed to send changes.`);
                }

                context.logger.info(`All ${clients.length} clients have initiated change submission.`);
                return { success: true, results };
            }
        } as ChangesAction
      ]
    },

    // Step 7: Handle Live Sync (Serial Interactive Action for All Clients)
    {
      name: 'Handle Live Sync for All Clients',
      execution: 'serial', // Single InteractiveAction manages all clients
      actions: [
        // NO LONGER COMPOSITE - Single Interactive Action
        {
            type: 'interactive',
            name: 'Listen for All Client Changes',
            protocol: 'client-submit-listener-all', // Single protocol name
            maxTimeout: 60000, // INCREASED timeout to allow more server processing time
            handlers: {
                'srv_live_changes': async (message: ServerChangesMessage, context: OperationContext, ops: Record<string, any>) => {
                    const targetClientId = message.clientId; 
                    if (!targetClientId || !context.state.clients.includes(targetClientId)) {
                         context.logger.warn(`Received srv_live_changes for unknown or irrelevant client: ${targetClientId}`);
                         // ACK unknown client to prevent potential server retries
                         await ops.ws.sendMessage(targetClientId || 'unknown_client', {
                            type: 'clt_changes_received',
                            messageId: `clt_${targetClientId}_${Date.now()}_ack_unknown`,
                            timestamp: Date.now(),
                            clientId: targetClientId,
                            changeIds: message.changes?.map((c: TableChange) => c.data?.id).filter(Boolean) || [],
                            lastLSN: message.lastLSN || '0/0'
                         });
                         return false; // Continue listening
                    }

                    const profileId = context.state.clientProfiles[targetClientId];
                    // Get the ClientChangeTracker instance
                    const clientTracker = context.state.clientChangeTracker;

                    if (!context.state.clientCatchupCompleted[targetClientId]) {
                        context.logger.warn(`[Client ${profileId}] Received srv_live_changes before catchup completed. Ignoring for tracking.`);
                        // Still ACK receipt
                        await ops.ws.sendMessage(targetClientId, {
                            type: 'clt_changes_received',
                            messageId: `clt_${targetClientId}_${Date.now()}_ack_premature`,
                            timestamp: Date.now(),
                            clientId: targetClientId,
                            changeIds: message.changes.map((c: TableChange) => c.data?.id).filter(Boolean),
                            lastLSN: message.lastLSN || '0/0'
                        });
                        return false;
                    }

                    // Process received changes
                    let nonEchoedChanges: TableChangeTest[] = [];
                    let conflictUpdatesForThisClient: TableChangeTest[] = [];
                    const changes = message.changes || [];
                    
                    // Get conflict task IDs for identifying conflict updates
                    const conflictTaskIds = context.state.allConflictTaskIds || [];
                    const conflictConfig = context.state.scenarioConfig?.conflictConfig;
                    const expectedWinnerClientId = context.state.actualConflictWinnerClientId;
                    
                    // Process each change
                    changes.forEach((change: TableChangeTest) => {
                        const originatingClientId = change.data?.client_id;
                        
                        // Skip self-echoed changes
                        if (originatingClientId === targetClientId) {
                            context.logger.debug(`[Client ${profileId}] Received self-echoed change: ${change.table} ${change.data?.id}`);
                            return;
                        }
                        
                        // Add to non-echoed changes
                            nonEchoedChanges.push(change);
                        
                        // Check if this is a conflict update (update to a known conflict task)
                        if (conflictConfig?.enabled &&
                            change.operation === 'update' &&
                            change.table === 'tasks' &&
                            conflictTaskIds.includes(change.data?.id)) {
                            
                            // Detect conflict by checking if it has a title field update
                            if (change.data?.title) {
                                // Store client ID in the change itself for easier access
                                change._originClientId = originatingClientId;
                                conflictUpdatesForThisClient.push(change);
                                
                                // Log details about the conflict update
                                const taskId = change.data.id;
                                const expectedWinnerClientId = context.state.conflictWinners[taskId];
                                const isFromWinner = originatingClientId === expectedWinnerClientId;
                                context.logger.info(`[Client ${profileId}] Identified conflict update to task ${taskId} title="${change.data.title}" from client ${originatingClientId} (${isFromWinner ? 'WINNER' : 'loser'})`);
                            }
                        }
                    });

                    // 1. Record all non-echoed changes in the ClientChangeTracker
                    if (nonEchoedChanges.length > 0) {
                        if (clientTracker) {
                            // Record only in ClientChangeTracker which we use for validation
                            clientTracker.recordClientChanges(targetClientId, nonEchoedChanges);
                            context.logger.info(`[Client ${profileId}] Recorded ${nonEchoedChanges.length} non-echoed changes in ClientChangeTracker.`);
                            
                            // Also record in ChangeStateManager so we have a backup copy for validation
                        context.state.changeState.recordClientChanges(targetClientId, nonEchoedChanges);

                            // Only store in central manager if not previously recorded (avoid duplicates)
                            // This is used primarily for match logging
                        const previousCentralCount = context.state.serverConfirmedStateManager.getDatabaseChanges().length;
                        context.state.serverConfirmedStateManager.recordDatabaseChanges(nonEchoedChanges);
                        const newCentralCount = context.state.serverConfirmedStateManager.getDatabaseChanges().length;
                        context.logger.info(`Added ${nonEchoedChanges.length} changes to ServerConfirmedStateManager. Count: ${previousCentralCount} -> ${newCentralCount}`);
                        } else {
                            context.logger.error(`[Client ${profileId}] ClientChangeTracker not found in state! Cannot record changes.`);
                        }
                        
                        // Log match info for this batch against current ground truth
                        logChangeMatchInfo(context, targetClientId, nonEchoedChanges);
                    }
                    
                    // 2. Specifically track conflict updates in the ClientChangeTracker
                    if (clientTracker && conflictUpdatesForThisClient.length > 0) {
                        clientTracker.recordConflictUpdates(targetClientId, conflictUpdatesForThisClient);
                        context.logger.info(`[Client ${profileId}] Recorded ${conflictUpdatesForThisClient.length} conflict updates in ClientChangeTracker.`);
                        
                        // Additional logging for debugging
                        const conflictDetailsForLog = conflictUpdatesForThisClient.map(update => ({
                            taskId: update.data?.id,
                            title: update.data?.title,
                            fromClientId: update._originClientId || update.data?.client_id,
                            isWinner: update._originClientId === expectedWinnerClientId
                        }));
                        
                        context.logger.info(`[Client ${profileId}] Conflict updates details: ${JSON.stringify(conflictDetailsForLog)}`);
                    }

                    // Send Acknowledgment
                    await ops.ws.sendMessage(targetClientId, {
                        type: 'clt_changes_received',
                        messageId: `clt_${targetClientId}_${Date.now()}_ack`,
                        timestamp: Date.now(),
                        clientId: targetClientId,
                        changeIds: changes.map((c: TableChange) => c.data?.id).filter(Boolean),
                        lastLSN: message.lastLSN || '0/0'
                    });

                    // --- Revised Completion Check based on External Expectation ---
                    const allClients = context.state.clients || [];
                    let allCompleteBasedOnExternalExpectation = true; // Assume true initially
                    
                    allClients.forEach((cid: string) => {
                      if (!context.state.clientCatchupCompleted[cid]) {
                        allCompleteBasedOnExternalExpectation = false; // If any client hasn't caught up, we're not done
                        return; // No need to check progress for this client yet
                      }

                      // Use ClientChangeTracker instead of ChangeStateManager for counts
                      const receivedCount = clientTracker.getClientChanges(cid).length; // Get actual count from ClientChangeTracker
                      const expectedCount = context.state.expectedReceivedCounts[cid]; // Get OUR calculated expectation

                      // Check if this client has received at least the number of changes we expect
                      if (receivedCount < expectedCount) {
                        allCompleteBasedOnExternalExpectation = false;
                        const profile = context.state.clientProfiles[cid];
                        // Optional: Log progress more verbosely if needed
                        // context.logger.debug(`[Client ${profile}] Progress: ${receivedCount}/${expectedCount}`);
                      } else {
                          // Optional: Log when a client reaches its expectation
                          // const profile = context.state.clientProfiles[cid];
                          // context.logger.info(`[Client ${profile}] Reached expected count: ${receivedCount}/${expectedCount}.`);
                      }
                    });

                    // Check if ChangeStateManager thinks the batch is complete (inactivity)
                    const batchComplete = context.state.changeState.isBatchComplete();

                    if (allCompleteBasedOnExternalExpectation) {
                        context.logger.info(`All ${allClients.length} clients have completed receiving expected changes based on external count. Completing listener.`);
                        return true; // Finish the protocol
                    } else if (batchComplete) {
                        context.logger.warn(`ChangeStateManager detected inactivity (batch complete), but not all clients met external expectation. Completing listener.`);
                        // Log incomplete clients based on EXTERNAL expectation
                        allClients.forEach((cid: string) => {
                            if (context.state.clientCatchupCompleted[cid]) {
                                const receivedCount = context.state.changeState.getClientChanges(cid).length;
                                const expectedCount = context.state.expectedReceivedCounts[cid];
                                if (receivedCount < expectedCount) {
                                     const profile = context.state.clientProfiles[cid];
                                     context.logger.warn(`  - Client ${profile} (${cid}) did not reach external expectation (${receivedCount}/${expectedCount})`);
                                }
                            }
                        });
                        return true; // Finish due to inactivity
                    } else {
                        return false; // Continue listening
                    }
                    // --- End Revised Completion Check ---
                },
                'timeout': async (message: any, context: OperationContext) => {
                    context.logger.error(`Listener protocol maxTimeout reached!`);
                    // --- Revised Timeout Check based on External Expectation ---
                    const allClients = context.state.clients || [];
                    const incompleteClients = allClients.filter((cid: string) => {
                         if (!context.state.clientCatchupCompleted[cid]) return false; // Ignore if never caught up
                         const receivedCount = context.state.changeState.getClientChanges(cid).length;
                         const expectedCount = context.state.expectedReceivedCounts[cid];
                         return receivedCount < expectedCount; // Incomplete if received < expected
                    });

                    if (incompleteClients.length > 0) {
                        const incompleteProfiles = incompleteClients.map((cid: string) => context.state.clientProfiles[cid]);
                        context.logger.error(`Timeout occurred. Clients not meeting external expectation: ${incompleteProfiles.join(', ')}`);
                        incompleteClients.forEach((cid: string) => {
                             const receivedCount = context.state.changeState.getClientChanges(cid).length;
                             const expectedCount = context.state.expectedReceivedCounts[cid];
                             context.logger.error(`  - Client ${context.state.clientProfiles[cid]}: Received ${receivedCount} / Expected ${expectedCount}`);
                        });
                        throw new Error(`Listener timed out waiting for changes for ${incompleteClients.length} client(s).`);
                    } else {
                         context.logger.warn(`Listener timed out, but all clients met external expectation. Proceeding cautiously.`);
                         return true; 
                    }
                    // --- End Revised Timeout Check ---
                }
            }
        } as InteractiveAction
      ]
    },

    // ADDED: Explicit delay to allow server processing after listener completes
    {
      name: 'Wait for Server Processing',
      execution: 'serial',
      actions: [
        {
          type: 'changes', // Using 'changes' action type to execute arbitrary async code
          name: 'Wait 5 seconds',
          operation: 'exec',
          params: async (context: OperationContext) => {
            const delaySeconds = 5;
            context.logger.info(`Waiting ${delaySeconds} seconds for server-side WAL/change processing to settle...`);
            await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
            
            // Reset the ClientChangeTracker to get accurate counts for validation
            if (context.state.clientChangeTracker) {
              context.logger.info('Resetting ClientChangeTracker before validation to get accurate counts');
              // Create a new ClientChangeTracker with clean state
              context.state.clientChangeTracker = new ClientChangeTracker();
              
              // Manually add the changes we've seen in this run from the ChangeStateManager
              context.state.clients.forEach((clientId: string) => {
                const changesForThisClient = context.state.changeState.getClientChanges(clientId);
                if (changesForThisClient.length > 0) {
                  context.state.clientChangeTracker.recordClientChanges(clientId, changesForThisClient);
                  context.logger.info(`Re-recorded ${changesForThisClient.length} changes for client ${context.state.clientProfiles[clientId]}`);
                }
                
                // Also re-record any conflict updates
                const allChanges = context.state.changeState.getClientChanges(clientId);
                const conflictTaskIds = context.state.allConflictTaskIds || [];
                
                // Find conflict updates in the changes
                const conflictUpdates = allChanges.filter((change: TableChangeTest) => 
                  change.operation === 'update' && 
                  change.table === 'tasks' && 
                  conflictTaskIds.includes(change.data?.id) && 
                  change.data?.title && 
                  change.data?.client_id !== clientId // Not from this client
                );
                
                if (conflictUpdates.length > 0) {
                  context.state.clientChangeTracker.recordConflictUpdates(clientId, conflictUpdates);
                  context.logger.info(`Re-recorded ${conflictUpdates.length} conflict updates for client ${context.state.clientProfiles[clientId]}`);
                }
              });
              
              // Register the updated tracker with the message dispatcher
              messageDispatcher.setOptions({ clientChangeTracker: context.state.clientChangeTracker });
            }
            
            context.logger.info('Wait finished. Proceeding to validation.');
            return { success: true };
          }
        } as ChangesAction
      ]
    },

    // Step 8: Validate Received Changes
    {
        name: 'Validate Received Changes',
        execution: 'serial',
        actions: [
            {
                type: 'validation',
                name: 'Perform Unified Client Change Validation',
                operation: 'exec',
                params: async (context: ClientSubmitSyncContext, operations: Record<string, any>) => {
                    context.logger.info('Performing comprehensive validation of client changes with conflict resolution...');
                    
                    // Log validation configuration
                    const conflictConfig = context.state.scenarioConfig?.conflictConfig;
                    const expectedWinnerClientId = context.state.actualConflictWinnerClientId;
                    const winnerProfileId = expectedWinnerClientId ? context.state.clientProfiles[expectedWinnerClientId] : 'None';
                    
                    context.logger.info(`Validation Config: Conflicts ${conflictConfig?.enabled ? 'Enabled' : 'Disabled'}`);
                    if (conflictConfig?.enabled) {
                        context.logger.info(`Expected Conflict Winner: Client ${winnerProfileId} (${expectedWinnerClientId || 'Not determined'})`);
                    }
                    
                    // Calculate expected counts if not already done
                    if (conflictConfig?.enabled && context.state.conflictWinners) {
                        // Use the function from client-change-validation module directly
                        const expectedCounts = calculateExpectedReceiveCounts(context);
                        // Store in context for validation
                        context.state.expectedReceivedCounts = expectedCounts;
                    }
                    
                    const clientIds = context.state.clients || [];
                    const clientTracker = context.state.clientChangeTracker;
                    
                    // Check for preconditions
                    if (!clientTracker) {
                        context.logger.error('ClientChangeTracker instance not found in context state.');
                        return false;
                    }
                    
                    // Log the data we have for debugging
                    context.logger.info(`ClientChangeTracker contains data for ${clientIds.length} clients`);
                    for (const cid of clientIds) {
                        const profileId = context.state.clientProfiles[cid] || '?';
                        const changes = clientTracker.getClientChanges(cid);
                        const conflicts = clientTracker.getConflictUpdates(cid);
                        context.logger.info(`  Client ${profileId}: ${changes.length} changes, ${conflicts.length} conflict updates`);
                    }
                    
                    let overallSuccess = true;
                    const validationResults: Record<string, any> = {};
                    
                    // Validate each client using validateClientChangesWithConflicts
                    for (const clientId of clientIds) {
                        const profileId = context.state.clientProfiles[clientId];
                        context.logger.info(`\n--- Validating Client ${profileId} (${clientId}) ---`);
                        
                        try {
                            // Get expected changes count
                            const expectedChanges = context.state.expectedReceivedCounts[clientId] || 0;
                            
                            // Set up configuration for validation
                            const validationOptions = {
                                expectedChanges,
                                conflictConfig: conflictConfig?.enabled ? {
                                    enabled: true,
                                    expectedWinningClient: expectedWinnerClientId
                                } : { enabled: false }
                            };
                            
                            // Use the validateClientChangesWithConflicts function directly
                            const validationResult = await validateClientChangesWithConflicts(
                                clientId,
                                clientTracker,
                                validationOptions
                            );
                            
                            // Store the result as validation output
                            validationResults[clientId] = {
                                ...validationResult,
                                profileId,
                                errors: validationResult.details.errors
                            };
                            
                            // Update overall success
                            if (!validationResult.success) {
                                overallSuccess = false;
                            }
                            
                            // Log validation result
                            if (validationResult.success) {
                                context.logger.info(`✅ Validation PASSED for Client ${profileId}`);
                            } else {
                                context.logger.error(`❌ Validation FAILED for Client ${profileId}. Details:`);
                                validationResult.details.errors.forEach((err: string) => 
                                    context.logger.error(`  - ${err}`)
                                );
                            }
                        } catch (error: any) {
                            overallSuccess = false;
                            validationResults[clientId] = { 
                                success: false, 
                                clientId,
                                profileId,
                                error: error.message,
                                errors: [`Exception: ${error.message}`]
                            };
                            context.logger.error(`Error during validation for Client ${profileId}: ${error.message}`);
                        }
                    }
                    
                    // Generate the validation summary table directly
                    generateValidationSummary(context, validationResults);
                    
                    return overallSuccess;
                }
            } as ValidationAction
        ]
    },

    // Step 10: Cleanup
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
                            const profileId = context.state.clientProfiles[clientId] || '?';
                            context.logger.info(`Disconnected client ${profileId}`);
                        }
                        
              // Reset state managers and change tracker
                        context.state.changeState.reset();
              context.state.serverConfirmedStateManager.reset();
                        context.state.changeTracker.clear();
                        
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