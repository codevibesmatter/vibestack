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

// Import core sync modules from v2 entity-changes
import { DataSource, Logger } from 'typeorm';
import { serverEntities } from '@repo/dataforge/server-entities';
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
import { ChangeStateManager, IntentionalDuplicate } from '../core/entity-changes/change-state.ts';

// Logger for this module
const logger = createLogger('sync.live-sync');

/**
 * Silent logger implementation for TypeORM
 * Prevents database logs from flooding the console output during tests
 */
class SilentLogger implements Logger {
  logQuery() {}
  logQueryError() {}
  logQuerySlow() {}
  logSchemaBuild() {}
  logMigration() {}
  log() {}
}

/**
 * Database connection configuration
 * Creates a DataSource instance for all database operations in this scenario
 */
const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: serverEntities,
  synchronize: false,
  logging: false,
  logger: new SilentLogger()
});

// Define additional types for tracking
interface ExtendedTableChange extends TableChange {
  lsn: string;
}

/**
 * Helper functions for the streamlined live sync scenario
 * These functions encapsulate common operations and utilities
 * used throughout the scenario steps
 */
const scenarioHelpers = {
  /**
   * Registers default message handlers for the dispatcher
   * These will be overridden by interactive steps when needed
   */
  registerMessageHandlers(): void {
    // First clear any existing handlers to ensure clean start
    messageDispatcher.removeAllHandlers('srv_live_changes');
    messageDispatcher.removeAllHandlers('srv_catchup_changes');
    messageDispatcher.removeAllHandlers('srv_catchup_completed');
    
    // Then register default no-op handlers
    messageDispatcher.registerHandler('srv_live_changes', () => false);
    messageDispatcher.registerHandler('srv_catchup_changes', () => false);
    messageDispatcher.registerHandler('srv_catchup_completed', () => false);
    
    logger.info('Registered clean message handlers for interactive steps');
  },
  
  /**
   * Creates a consistent batch ID format for tracking changes
   * @returns A unique batch identifier with timestamp
   */
  createBatchId(): string {
    return `sync-test-${Date.now()}`;
  },
  
  /**
   * Updates the last seen LSN in the change tracker
   * @param context Operation context containing the change tracker
   * @param lsn The LSN value to set
   */
  updateLSN(context: OperationContext, lsn: string): void {
    context.state.changeTracker.setLastLSN(lsn);
  },
  
  /**
   * Extracts the latest LSN from a batch of changes and updates the tracker
   * @param context Operation context containing the change tracker
   * @param changes Array of table changes that may contain LSN information
   */
  extractAndUpdateLSN(context: OperationContext, changes: TableChangeTest[]): void {
    // Skip if no changes have LSN
    if (!changes.some(c => (c as ExtendedTableChange).lsn)) {
      return;
    }
    
    // Find the latest LSN from the changes
    const lsnChanges = changes.filter(c => (c as ExtendedTableChange).lsn) as ExtendedTableChange[];
    if (lsnChanges.length === 0) {
      return;
    }
    
    // Sort by LSN descending to get the latest
    lsnChanges.sort((a, b) => b.lsn.localeCompare(a.lsn));
    const latestLSN = lsnChanges[0].lsn;
    this.updateLSN(context, latestLSN);
    context.logger.debug(`Updated LSN from changes to: ${latestLSN}`);
  },
  
  /**
   * Sends a client message to the server through the WebSocket connection
   * @param clientId The client identifier
   * @param operations Available operations from the scenario runner
   * @param message The message payload to send
   */
  async sendClientMessage(clientId: string, operations: Record<string, any>, message: Record<string, any>): Promise<void> {
    await operations.ws.sendMessage(clientId, {
      clientId,
      timestamp: Date.now(),
      ...message
    });
  },
  
  /**
   * Sends a change acknowledgment message to confirm receipt of changes
   * @param clientId The client identifier
   * @param operations Available operations from the scenario runner
   */
  async sendChangeAcknowledgment(clientId: string, operations: Record<string, any>): Promise<void> {
    await this.sendClientMessage(clientId, operations, {
      type: 'clt_changes_ack'
    });
  },
  
  /**
   * Sends a catchup acknowledgment message to confirm receipt of catchup data
   * @param clientId The client identifier
   * @param operations Available operations from the scenario runner
   * @param chunk The chunk number being acknowledged
   * @param lsn The last seen LSN value
   */
  async sendCatchupAcknowledgment(clientId: string, operations: Record<string, any>, chunk: number = 1, lsn: string = '0/0'): Promise<void> {
    await this.sendClientMessage(clientId, operations, {
      type: 'clt_catchup_received',
      messageId: `catchup_ack_${Date.now()}`,
      chunk,
      lsn
    });
  }
};

/**
 * Streamlined Live Sync Test Scenario
 * 
 * A simplified version of the live sync test that leverages improved server-side sync
 * and uses the new batch changes system. This scenario tests the full live synchronization
 * flow including:
 * - Initial database setup
 * - Client connection and catchup sync
 * - Generating and applying changes
 * - Tracking and validating change propagation
 * - Proper cleanup of resources
 */
export const LiveSyncScenario: Scenario = {
  name: 'Live Sync Test',
  description: 'Tests the live sync capability with improved server communication',
  config: {
    timeout: 60000,
    changeCount: 5,
    customProperties: {
      clientCount: 1
    }
  },
  
  hooks: {
    /**
     * Initializes the scenario environment before execution
     * Sets up necessary state managers and trackers for the test
     */
    beforeScenario: async (context) => {
      context.logger.info(`Starting streamlined live sync test with ${context.config.customProperties?.clientCount || 1} clients and ${context.config.changeCount} changes`);
      
      // Register message handlers for interactive steps
      scenarioHelpers.registerMessageHandlers();
      
      // Initialize enhanced change tracker with LSN tracking
      context.state.changeTracker = new ChangeTracker({
        trackLSN: true,
        maxHistorySize: 1000
      });
      
      // Initialize a change state manager with inactivity timeout
      const inactivityTimeout = 15000; // 15 seconds
      context.state.changeState = new ChangeStateManager({
        inactivityTimeout
      });
      
      // Initialize the catchup activity tracker
      context.state.catchupActivityTracker = {
        lastActivity: Date.now(),
        inactivityTimeout: 15000, // 15 seconds of inactivity before timing out
        resetActivity: function() {
          this.lastActivity = Date.now();
        }
      };
      
      context.logger.info('Initialized catchup activity tracker with 15s inactivity timeout');
      
      // Track catchup status PER CLIENT (instead of a single global flag)
      context.state.clientCatchupCompleted = {};
      
      // Store the shared batch ID for the test run
      context.state.batchId = scenarioHelpers.createBatchId();
      
      // Track mapping of clientId to profileId for simplified logging
      context.state.clientProfiles = {};
      
      // Track which clients have received all changes
      context.state.clientChangesCompleted = {};
      
      // Track when clients started tracking changes
      context.state.clientTrackingStartTime = {};
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
              // Initialize database connection using entity-changes
              const initialized = await initialize(dataSource);
              
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
              // Store initial LSN in the change tracker only
              scenarioHelpers.updateLSN(context, response.lsn);
              context.logger.info(`Retrieved initial replication LSN: ${response.lsn}`);
            }
            return response;
          }
        } as ApiAction,
        // Add delay to allow processing of any pending WAL entries
        {
          type: 'changes',
          name: 'Wait for WAL Processing',
          operation: 'exec',
          params: async (context: OperationContext) => {
            context.logger.info('Waiting 3 seconds for any previous WAL entries to be processed...');
            
            // Wait 3 seconds
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            context.logger.info('Wait completed. Any previous WAL entries should be processed by now.');
            return { success: true };
          }
        } as ChangesAction
      ]
    },
    
    // Step 2: Set Up Clients (moved after replication init and delay)
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
                
                // Store the profileId mapping for this clientId
                context.state.clientProfiles[clientId] = profileId;
                
                // Set up the client (connect to server)
                await operations.ws.setupClient(clientId);
                context.logger.info(`Created and set up client with profile ${profileId}`);
              }
              
              // Store clients in context for later use
              context.state.clients = clients;
              
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
          maxTimeout: 60000, // Increased from 45000 to 60 seconds to allow more time for catchup
          
          handlers: {
            /**
             * Handles server changes during catchup phase
             * These are historical changes from previous runs
             * @param message The server changes message
             * @param context The operation context
             * @param operations Available operations from the scenario runner
             */
            'srv_catchup_changes': async (message: ServerChangesMessage, context: OperationContext, operations: Record<string, any>) => {
              const clientId = message.clientId || context.state.clients[0];
              const profileId = context.state.clientProfiles[clientId] || '?';
              
              // Safely reset activity timer since we've received changes
              if (context.state.catchupActivityTracker) {
                context.state.catchupActivityTracker.resetActivity();
              }
              
              // Extract sequence information for better logging
              const chunkNum = message.sequence?.chunk || 1;
              const totalChunks = message.sequence?.total || 1;
              
              context.logger.info(`\x1b[32mReceived catchup changes: chunk ${chunkNum}/${totalChunks} with ${message.changes?.length || 0} changes for client ${profileId}\x1b[0m`);
              
              // We intentionally don't track catchup changes
              // These are historical changes from previous runs that clients need to get current
              // DO NOT record these changes to any state manager or tracker
              
              // Update the last LSN in the change tracker if available
              if (message.lastLSN) {
                scenarioHelpers.updateLSN(context, message.lastLSN);
              }
              
              // Acknowledge receipt of the catchup chunk
              await scenarioHelpers.sendCatchupAcknowledgment(
                clientId, 
                operations, 
                chunkNum, 
                message.lastLSN || '0/0'
              );
              
              return false; // Keep waiting for more messages
            },
            
            /**
             * Handles catchup completion notification from server
             * @param message The catchup completed message
             * @param context The operation context
             */
            'srv_catchup_completed': async (message: ServerCatchupCompletedMessage, context: OperationContext) => {
              const clientId = message.clientId;
              const profileId = context.state.clientProfiles[clientId] || '?';
              
              // Safely reset activity timer since we've received a completion message
              if (context.state.catchupActivityTracker) {
                context.state.catchupActivityTracker.resetActivity();
              }
              
              // Mark this client as completed catchup
              context.state.clientCatchupCompleted[clientId] = true;
              
              // Track when this client started tracking real changes
              context.state.clientTrackingStartTime[clientId] = Date.now();
              
              context.logger.info(`\x1b[32mCatchup sync completed for client ${profileId}\x1b[0m`);
              
              // Check if all clients have completed catchup
              const allClientsCompleted = context.state.clients.every(
                (cId: string) => context.state.clientCatchupCompleted[cId]
              );
              
              if (allClientsCompleted) {
                context.logger.info(`\x1b[32mAll clients (${context.state.clients.length}) have completed catchup\x1b[0m`);
                
                // Add additional delay to ensure all clients are truly ready
                // before proceeding to next step - 500ms should be enough
                context.logger.info(`\x1b[32mWaiting 500ms to ensure all clients are fully processed before proceeding...\x1b[0m`);
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Only now signal completion to proceed to next step
                return true;
              } else {
                const completedCount = Object.keys(context.state.clientCatchupCompleted).length;
                context.logger.info(`\x1b[32m${completedCount}/${context.state.clients.length} clients have completed catchup\x1b[0m`);
                
                // Don't complete until all clients are done
                return false;
              }
            },
            
            /**
             * Handle timeout event - check if there's been recent activity before failing
             * @param message The timeout message
             * @param context The operation context
             */
            'timeout': async (message: any, context: OperationContext) => {
              const completedCount = Object.keys(context.state.clientCatchupCompleted).length;
              const totalClients = context.state.clients.length;
              
              // Safely check for recent activity
              if (context.state.catchupActivityTracker) {
                const timeSinceLastActivity = Date.now() - context.state.catchupActivityTracker.lastActivity;
                const hasRecentActivity = timeSinceLastActivity < context.state.catchupActivityTracker.inactivityTimeout;
                
                if (hasRecentActivity) {
                  context.logger.info(`Extending catchup timeout - active within the last ${timeSinceLastActivity}ms (threshold: ${context.state.catchupActivityTracker.inactivityTimeout}ms)`);
                  return false; // Continue waiting, there's been recent activity
                }
                
                context.logger.error(`\x1b[31mCatchup sync timed out after ${timeSinceLastActivity}ms of inactivity. Only ${completedCount}/${totalClients} clients completed catchup.\x1b[0m`);
              } else {
                context.logger.error(`\x1b[31mCatchup sync timed out. Activity tracker not initialized. Only ${completedCount}/${totalClients} clients completed catchup.\x1b[0m`);
              }
              
              // List clients that didn't complete catchup
              const incompleteClients = context.state.clients.filter(
                (cId: string) => !context.state.clientCatchupCompleted[cId]
              );
              
              if (incompleteClients.length > 0) {
                const profiles = incompleteClients.map((cId: string) => 
                  context.state.clientProfiles[cId] || 'unknown'
                ).join(', ');
                
                context.logger.error(`\x1b[31mClients failed to complete catchup: ${profiles}\x1b[0m`);
              }
              
              // Throw an error to fail the test - use a safe error message
              const inactivityTime = context.state.catchupActivityTracker ? 
                `${Date.now() - context.state.catchupActivityTracker.lastActivity}ms of inactivity` : 
                'timeout';
              throw new Error(`Catchup sync timed out after ${inactivityTime}. Test failed.`);
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
          maxTimeout: 60000, // 60 seconds timeout
          
          initialAction: {
            type: 'ws',
            name: 'Initialize Live Change Tracking',
            operation: 'exec',
            params: async (context: OperationContext) => {
              context.logger.info(`\x1b[32mSetting up change tracking before generating changes\x1b[0m`);
              return { success: true };
            }
          },
          
          handlers: {
            /**
             * Handles live changes received from the server
             * Records, processes and acknowledges changes while monitoring progress
             * @param message The server changes message
             * @param context The operation context
             * @param operations Available operations from the scenario runner
             */
            'srv_live_changes': async (message: ServerChangesMessage, context: OperationContext, operations: Record<string, any>) => {
              const clientId = message.clientId;
              const profileId = context.state.clientProfiles[clientId] || '?';
              const changes = message.changes || [];
              
              // If we have changes to process
              if (changes.length === 0) {
                // Empty batch - send acknowledgment and continue
                await scenarioHelpers.sendChangeAcknowledgment(clientId, operations);
                return handleCompletionChecks(context);
              }
              
              // Only track changes if this specific client has completed catchup
              if (context.state.clientCatchupCompleted[clientId]) {
                // Record this batch in the state manager
                context.state.changeState.recordClientChanges(clientId, changes);
                
                // Get batch statistics from the state manager
                const batchStats = context.state.changeState.getBatchStatistics();
                const progress = context.state.changeState.getClientProgress(clientId);
                
                // New line using sequence info from the message if available
                const batchNum = message.sequence ? `${message.sequence.chunk}/${message.sequence.total}` : `#${batchStats.totalBatches || '?'}`;
                context.logger.info(`\x1b[32mBatch ${batchNum}: received ${changes.length} live changes for client ${profileId} (total: ${progress.received}/${progress.expected}, ${progress.percentage.toFixed(1)}%)\x1b[0m`);
                
                // Extract and update LSN if available
                scenarioHelpers.extractAndUpdateLSN(context, changes);
                
                // Display change summary as a direct log for better formatting in the console
                const summaryText = context.state.changeState.getChangeSummaryText(changes);
                // Only output summary for larger batches (more than 5 changes)
                if (changes.length > 5) {
                  context.logger.info(`\x1b[32m${summaryText}\x1b[0m`);
                }
                
                // Only check for matches with our database changes if our DB changes were applied
                // AND we've already completed catchup for this client
                if (context.state.databaseChangesApplied) {
                  logMatchInformation(context, clientId, changes);
                }
              } else {
                // These are changes received BEFORE catchup is complete for this client
                // Do not track them - these are historical changes from previous runs 
                context.logger.info(`\x1b[33mIgnoring ${changes.length} changes for client ${profileId} - still in catchup phase\x1b[0m`);
              }
              
              // Always send acknowledgment
              await scenarioHelpers.sendChangeAcknowledgment(clientId, operations);
              
              // Only check client completion if DB changes are applied and this client has completed catchup
              if (context.state.databaseChangesApplied && context.state.clientCatchupCompleted[clientId]) {
                const progress = context.state.changeState.getClientProgress(clientId);
                
                if (progress.complete) {
                  // Mark this client as having received all changes
                  context.state.clientChangesCompleted[clientId] = true;
                  
                  context.logger.info(`\x1b[32mClient ${profileId} has received 100% of expected changes.\x1b[0m`);
                  
                  // Check if all clients have received all changes
                  const allClientsComplete = context.state.clients.every(
                    (cId: string) => 
                      // Only include clients that have completed catchup in our check
                      // A client must either:
                      // 1. Have received all its changes, OR
                      // 2. Not have completed catchup yet (we don't expect changes from it)
                      context.state.clientChangesCompleted[cId] || !context.state.clientCatchupCompleted[cId]
                  );
                  
                  if (allClientsComplete) {
                    context.logger.info(`\x1b[32mAll clients have received 100% of expected changes. Protocol complete.\x1b[0m`);
                    return true; // Signal completion to the protocol handler
                  }
                  
                  // Don't complete the protocol yet - wait for other clients to finish
                  return false;
                }
              }
              
              return handleCompletionChecks(context);
              
              /**
               * Helper function to handle various completion checks
               * Extracted to reduce nesting and improve readability
               */
              function handleCompletionChecks(context: OperationContext) {
                // Check if sync is explicitly marked as complete
                if (context.state.changeState.isSyncComplete()) {
                  context.logger.info(`\x1b[32mSync process is complete according to state manager\x1b[0m`);
                  return true;
                }
                
                // Don't complete until database changes have been applied
                if (!context.state.databaseChangesApplied) {
                  return false;
                }
                
                // Check if the batch is complete due to inactivity using the state manager
                if (context.state.changeState.isBatchComplete()) {
                  context.logger.info(`Protocol timeout reached due to inactivity`);
                  
                  // Log which clients have not yet finished
                  const incompleteClients = context.state.clients.filter(
                    (cId: string) => context.state.clientCatchupCompleted[cId] && !context.state.clientChangesCompleted[cId]
                  );
                  
                  if (incompleteClients.length > 0) {
                    const profiles = incompleteClients.map((cId: string) => context.state.clientProfiles[cId]).join(', ');
                    context.logger.warn(`Clients not yet complete: ${profiles}`);
                  }
                  
                  return true;
                }
                
                return false; // Continue waiting for changes
              }
              
              /**
               * Logs information about matches between database and client changes
               * Enhanced with timing info to only check relevant changes
               */
              function logMatchInformation(context: OperationContext, clientId: string, changes: TableChangeTest[]) {
                const dbChanges = context.state.changeState.getDatabaseChanges();
                
                // Determine if there are any matches between these changes and our database changes
                // This is an enhanced version that's aware of client tracking start time
                const { matches, matchPercentage } = context.state.changeState.findMatches(dbChanges, changes);
                
                const matchMessage = `Matches with our applied changes: ${matches.length}/${changes.length} (${matchPercentage.toFixed(1)}%)`;
                
                // Use different colors for 0% match vs. some matches
                if (matches.length === 0) {
                  context.logger.warn(`${matchMessage} - changes may be from prior test runs`);
                } else {
                  context.logger.info(`\x1b[32m${matchMessage}\x1b[0m`);
                }
              }
            },
            
            /**
             * Handles timeout events in the sync protocol
             * Checks if sync is complete or if inactivity thresholds were reached
             * @param message The timeout message
             * @param context The operation context
             */
            'timeout': async (message: any, context: OperationContext) => {
              // Check if sync is marked as complete
              if (context.state.changeState.isSyncComplete()) {
                context.logger.info(`Protocol timeout reached - sync process is complete`);
                return true;
              }
              
              // Use the state manager to check for inactivity
              if (context.state.changeState.isBatchComplete()) {
                context.logger.info(`Protocol timeout reached due to inactivity`);
                return true;
              }
              
              // Otherwise, extend the timeout if we're still receiving changes
              context.logger.info(`Extending timeout - waiting for more changes`);
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
                scenarioHelpers.updateLSN(context, preLSN);
                context.logger.info(`Current LSN before applying changes: ${preLSN}`);
              } catch (e) {
                context.logger.warn(`Could not get pre-change LSN: ${e}`);
              }
              
              // Use the shared batch ID for the test run
              const batchId = context.state.batchId;
              
              // Generate and apply changes using the updated batch changes system
              const result = await generateAndApplyMixedChanges(
                changeCount, 
                { 
                  mode: 'mixed',
                  batchId
                },
                context.state.changeTracker // Pass the change tracker to avoid update conflicts
              );
              
              // Log info about generated changes instead of validating
              context.logger.info(`Generated ${result.changes.length} changes for testing`);
              
              // Record changes in tracking systems
              recordChangesInTrackers(context, result, batchId);
              
              // Get and update LSN after applying changes
              await updatePostChangesLSN(context, operations);
              
              // Mark database changes as applied
              context.state.databaseChangesApplied = true;
              
              // Get a summary from the change tracker
              const trackerSummary = context.state.changeTracker.getSummary();
              
              return { 
                success: true, 
                changeCount: result.changes.length,
                duplicates: trackerSummary.intentionalDuplicates,
                batchId
              };
            } catch (error) {
              context.logger.error(`Error generating and applying changes: ${error}`);
              return { 
                success: false, 
                error: error instanceof Error ? error.message : String(error)
              };
            }
            
            /**
             * Records changes in all tracking systems
             * @param context The operation context
             * @param result The result of generated changes
             * @param batchId The batch ID
             */
            function recordChangesInTrackers(context: OperationContext, result: any, batchId: string) {
              // Store the changes (result.changes) and pairs (result.insertUpdatePairs)
              context.state.databaseChanges = result.changes || []; // Store only the changes array
              context.state.intentionalDuplicatePairs = result.insertUpdatePairs || []; // Keep the pairs separately if needed elsewhere
              
              // Record the database changes (excluding duplicates initially)
              context.state.changeTracker.recordAppliedChanges(result.changes, batchId);
              context.state.changeState.recordDatabaseChanges(result.changes, batchId);
              
              // Record intentional duplicate PAIRS in the state manager after mapping
              if (result.insertUpdatePairs && result.insertUpdatePairs.length > 0) {
                // Map the pairs to the expected { original, duplicate } structure
                const duplicatesToRecord: IntentionalDuplicate[] = result.insertUpdatePairs.map(
                  (pair: { insertChange: TableChangeTest, updateChange: TableChangeTest }) => ({
                    original: pair.insertChange,
                    duplicate: pair.updateChange
                  })
                );
                
                // Pass the correctly structured array
                context.state.changeState.recordIntentionalDuplicates(duplicatesToRecord);
                context.logger.info(`Recorded ${duplicatesToRecord.length} intentional duplicates (mapped to {original, duplicate}) in ChangeStateManager`);
              } else {
                context.logger.info('No intentional duplicates found in the result to record.');
              }
            }
            
            /**
             * Gets the current LSN after changes and updates tracking
             * @param context The operation context
             * @param operations Available operations from the scenario runner
             */
            async function updatePostChangesLSN(context: OperationContext, operations: Record<string, any>) {
              try {
                const postLSN = await operations.changes.getCurrentLSN();
                scenarioHelpers.updateLSN(context, postLSN);
                context.logger.info(`Current LSN after applying changes: ${postLSN}`);
                
                // Log LSN ranges tracked (summary only)
                const lsnRanges = context.state.changeTracker.getLSNRanges();
                if (lsnRanges.length > 0) {
                  context.logger.info(`Tracked ${lsnRanges.length} LSN ranges`);
                }
              } catch (e) {
                context.logger.warn(`Could not get post-change LSN: ${e}`);
              }
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
            context.logger.info(`Validating synchronized changes for all clients`);
            
            try {
              // Add delay to ensure all clients have received their changes
              // This helps avoid race conditions where changes arrive after the protocol completes
              const clientsWithCatchup = context.state.clients.filter(
                (cId: string) => context.state.clientCatchupCompleted[cId]
              );
              
              const clientsAwaitingChanges = clientsWithCatchup.filter(
                (cId: string) => !context.state.clientChangesCompleted[cId]
              );
              
              if (clientsAwaitingChanges.length > 0) {
                const profileIds = clientsAwaitingChanges.map(
                  (cId: string) => context.state.clientProfiles[cId]
                ).join(', ');
                
                context.logger.info(`Waiting 2 seconds for ${clientsAwaitingChanges.length} clients (${profileIds}) to finish receiving changes...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Log the clients that completed during wait
                const completedDuringWait = clientsAwaitingChanges.filter(
                  (cId: string) => context.state.clientChangesCompleted[cId]
                );
                
                if (completedDuringWait.length > 0) {
                  const completedIds = completedDuringWait.map(
                    (cId: string) => context.state.clientProfiles[cId]
                  ).join(', ');
                  context.logger.info(`${completedDuringWait.length} clients completed during wait: ${completedIds}`);
                }
              }
              
              // Get database changes from the state manager
              const dbChanges = context.state.changeState.getDatabaseChanges();
              const intentionalDuplicates = context.state.changeState.getIntentionalDuplicates();
              
              // Initialize results for all clients
              const clientResults: Record<string, any> = {};
              let overallSuccess = true;
              
              // Run validation for each client
              context.logger.info(`Starting validation for ${context.state.clients.length} clients:`);
              
              for (const clientId of context.state.clients) {
                const profileId = context.state.clientProfiles[clientId] || '?';
                
                try {
                  // Get this client's changes for validation
                  const clientChanges = context.state.changeState.getClientChanges(clientId);
                  
                  // Skip validation if client didn't complete catchup
                  if (!context.state.clientCatchupCompleted[clientId]) {
                    clientResults[clientId] = { 
                      profileId,
                      success: false,
                      skipReason: 'Did not complete catchup phase',
                      received: 0,
                      expected: dbChanges.length - intentionalDuplicates.length
                    };
                    overallSuccess = false;
                    continue;
                  }
                  
                  if (clientChanges.length === 0) {
                    clientResults[clientId] = { 
                      profileId,
                      success: false,
                      skipReason: 'No changes received',
                      received: 0,
                      expected: dbChanges.length - intentionalDuplicates.length
                    };
                    overallSuccess = false;
                    continue;
                  }
                  
                  // Run validation for this client (log at debug level since we'll provide a better summary)
                  context.logger.debug(`Validating client ${profileId}: ${clientChanges.length} changes against ${dbChanges.length} database changes`);
                  
                  const validationResult = await validateChanges(
                    dbChanges,
                    clientChanges,
                    {
                      intentionalDuplicates,
                      allowExtraChanges: true
                    }
                  );
                  
                  const syncResult = validationResult as SyncValidationResult;
                  
                  // Handle null parentId for comments if they appear as extra changes
                  if (syncResult.details && syncResult.details.extraChanges.length > 0) {
                    const commentChangesWithNullParentId = syncResult.details.extraChanges.filter(change => 
                      change.table === 'comments' && 
                      (change.data?.parentId === null || change.data?.parent_id === null)
                    );
                    
                    if (commentChangesWithNullParentId.length === syncResult.details.extraChanges.length) {
                      syncResult.success = true;
                    }
                  }
                  
                  // Store result for this client
                  clientResults[clientId] = {
                    profileId,
                    success: syncResult.success,
                    missingChanges: syncResult.details?.missingChanges.length || 0,
                    extraChanges: syncResult.details?.extraChanges.length || 0,
                    intentionalDuplicates: syncResult.details?.intentionalDuplicates.length || 0,
                    deduplicationSuccess: typeof syncResult.summary.total === 'object' ? 
                      syncResult.summary.total.deduplicationSuccess : false,
                    expected: typeof syncResult.summary.total === 'object' ? 
                      syncResult.summary.total.expected : 0,
                    received: typeof syncResult.summary.total === 'object' ? 
                      syncResult.summary.total.received : 0
                  };
                  
                  // Update overall success
                  if (!syncResult.success) {
                    overallSuccess = false;
                  }
                } catch (error) {
                  context.logger.error(`Error validating client ${profileId}: ${error}`);
                  clientResults[clientId] = { 
                    profileId,
                    success: false,
                    error: String(error) 
                  };
                  overallSuccess = false;
                }
              }
              
              // Generate table-like summary for better readability
              const successfulClients = Object.values(clientResults).filter((r: any) => r.success).length;
              const totalClients = context.state.clients.length;
              const successSymbol = overallSuccess ? '✅' : (successfulClients > 0 ? '⚠️' : '❌');
              
              // Create header for client validation table
              context.logger.info('\nValidation Results:');
              context.logger.info('┌────────┬──────────┬──────────┬──────────┬────────┬──────────┬────────┐');
              context.logger.info('│ Client │ Status   │ Changes  │ Missing  │ Extra  │ Dupes    │ Dedup  │');
              context.logger.info('├────────┼──────────┼──────────┼──────────┼────────┼──────────┼────────┤');
              
              // Add each client's results to the table
              for (const clientId of context.state.clients) {
                const result = clientResults[clientId];
                const profileId = result.profileId;
                
                // Skip reason or standard validation results
                if (result.skipReason) {
                  context.logger.info(
                    `│ ${profileId.toString().padEnd(6)} │ SKIPPED  │` +
                    ` ${result.skipReason.substring(0, 8).padEnd(8)} │` +
                    ` ${'0'.padEnd(8)} │` +
                    ` ${'0'.padEnd(6)} │` +
                    ` ${'0'.padEnd(8)} │` +
                    ` No      │`
                  );
                } else if (result.error) {
                  context.logger.info(
                    `│ ${profileId.toString().padEnd(6)} │ ERROR    │` +
                    ` ${'0/0'.padEnd(8)} │` +
                    ` ${'0'.padEnd(8)} │` +
                    ` ${'0'.padEnd(6)} │` +
                    ` ${'0'.padEnd(8)} │` +
                    ` No      │`
                  );
                } else {
                  const statusSymbol = result.success ? '✅' : '❌';
                  const receivedChanges = `${result.received}/${result.expected}`;
                  
                  context.logger.info(
                    `│ ${profileId.toString().padEnd(6)} │ ${statusSymbol}        │` +
                    ` ${receivedChanges.padEnd(8)} │` + 
                    ` ${result.missingChanges.toString().padEnd(8)} │` +
                    ` ${result.extraChanges.toString().padEnd(6)} │` +
                    ` ${result.intentionalDuplicates.toString().padEnd(8)} │` +
                    ` ${result.deduplicationSuccess ? 'Yes' : 'No '}     │`
                  );
                }
              }
              
              // Close table
              context.logger.info('└────────┴──────────┴──────────┴──────────┴────────┴──────────┴────────┘');
              
              // Show overall summary
              context.logger.info(`\n${successSymbol} Overall validation: ${successfulClients}/${totalClients} clients successfully synchronized`);
              context.logger.info(`Database changes: ${dbChanges.length} (${intentionalDuplicates.length} intentional duplicates)`);
              
              // Note about special cases handling
              if (Object.values(clientResults).some((r: any) => r.extraChanges > 0)) {
                context.logger.info('Note: Extra changes with null parent_id in comments table were accepted as valid');
                
                // Collect all client validations that had extra changes
                const clientsWithExtraChanges = Object.values(clientResults).filter((r: any) => r.extraChanges > 0);
                const totalExtraChanges = clientsWithExtraChanges.reduce((sum, r: any) => sum + r.extraChanges, 0);
                
                // If there's a pattern worth reporting, show it
                if (clientsWithExtraChanges.length > 1) {
                  const clientCount = clientsWithExtraChanges.length;
                  const averageExtraChanges = totalExtraChanges / clientCount;
                  
                  if (averageExtraChanges === clientsWithExtraChanges[0].extraChanges) {
                    // Consistent pattern found
                    context.logger.info(`Pattern: ${clientCount} clients each received exactly ${averageExtraChanges} extra changes`);
                  }
                }
              }
              
              return {
                success: overallSuccess,
                clientResults,
                totalClients,
                successfulClients,
                databaseChanges: dbChanges.length,
                intentionalDuplicates: intentionalDuplicates.length
              };
            } catch (error) {
              context.logger.error(`Error in validation process: ${error}`);
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
                const profileId = context.state.clientProfiles[clientId] || '?';
                context.logger.info(`Disconnected client ${profileId}`);
              }
              
              // Reset state manager and change tracker state
              context.state.changeState.reset();
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