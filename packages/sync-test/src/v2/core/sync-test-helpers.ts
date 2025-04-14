/**
 * Sync Test Helpers
 * 
 * Common utilities and helpers for sync testing scenarios.
 * These functions handle message registration, client tracking, environment setup,
 * and validation functionality shared across multiple sync test scenarios.
 */

import { DataSource, Logger } from 'typeorm';
import { serverEntities, Task, User, Project } from '@repo/dataforge/server-entities';
import { createLogger } from './logger.ts';
import { messageDispatcher } from './message-dispatcher.ts';
import { ClientChangeTracker } from './entity-changes/client-change-tracker.ts';
import { ChangeStateManager } from './entity-changes/change-state.ts';
import { ChangeTracker } from './entity-changes/change-tracker.ts';
import { entityToChange } from './entity-changes/change-builder.ts';
import { createTask, createUser, createProject } from './entity-changes/entity-factories.ts';
import { initialize } from './entity-changes/change-applier.ts';
import { 
  validateClientChangesWithConflicts,
  calculateExpectedReceiveCounts
} from './entity-changes/client-change-validation.ts';
import type { ServerChangesMessage, TableChange } from '@repo/sync-types';
import type { TableChangeTest } from './entity-changes/types.ts';
import type { OperationContext } from './scenario-runner.ts';

// Logger for this module
const logger = createLogger('sync.test-helpers');

/**
 * Silent logger implementation for TypeORM
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
 * Creates and returns a standard database connection for testing
 */
export function createTestDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: serverEntities,
    synchronize: false,
    logging: false,
    logger: new SilentLogger()
  });
}

/**
 * Initializes the database connection for testing
 */
export async function initializeTestDatabase(dataSource: DataSource): Promise<boolean> {
  logger.info('Initializing database for sync test...');
  const initialized = await initialize(dataSource);
  
  if (!initialized) {
    logger.error('Database initialization failed');
    throw new Error('Database initialization failed');
  }
  
  logger.info('Database initialized successfully');
  return true;
}

/**
 * Creates base entities needed for testing (owner user and default project)
 */
export async function createBaseEntities(
  operations: Record<string, any>
): Promise<{ ownerId: string; projectId: string }> {
  // Create owner user
  logger.info('Creating test user...');
  const owner = await createUser();
  await operations.changes.applyChanges([entityToChange(owner, 'insert')]);
  logger.info(`Created test user: ${owner.id}`);
  
  // Create default project
  logger.info('Creating test project...');
  const project = await createProject({ owner: { id: owner.id } as User });
  await operations.changes.applyChanges([entityToChange(project, 'insert')]);
  logger.info(`Created test project with ID: ${project.id} owned by ${owner.id}`);
  
  return {
    ownerId: owner.id,
    projectId: project.id
  };
}

/**
 * Creates test task entities for tests including conflict scenarios
 */
export async function createTestTasks(
  ownerId: string,
  projectId: string,
  count: number,
  operations: Record<string, any>,
  options: { namePrefix?: string } = {}
): Promise<Task[]> {
  const namePrefix = options.namePrefix || 'Test Task';
  logger.info(`Creating ${count} task entities for testing...`);
  
  const tasks: Task[] = [];
  for (let i = 0; i < count; i++) {
    const task = await createTask(
      { assignee: { id: ownerId } as User, project: { id: projectId } as Project },
      { title: `${namePrefix} ${i + 1}` }
    );
    task.assigneeId = ownerId;
    task.projectId = projectId;
    
    const change = entityToChange(task, 'insert');
    await operations.changes.applyChanges([change]);
    tasks.push(task);
    logger.info(`Created task ${i + 1}/${count} with ID: ${task.id}`);
  }
  
  return tasks;
}

/**
 * Initialize state managers for any sync test
 */
export function initializeSyncStateTrackers(options: { inactivityTimeout?: number } = {}): Record<string, any> {
  const inactivityTimeout = options.inactivityTimeout || 15000;
  
  // Create change trackers and state managers
  const changeTracker = new ChangeTracker({ 
    trackLSN: true, 
    maxHistorySize: 1000 
  });
  
  const changeState = new ChangeStateManager({
    inactivityTimeout
  });
  
  const serverConfirmedStateManager = new ChangeStateManager({
    inactivityTimeout
  });
  
  // Initialize activity tracker
  const catchupActivityTracker = {
    lastActivity: Date.now(),
    inactivityTimeout,
    resetActivity: function() {
      this.lastActivity = Date.now();
    }
  };
  
  return {
    changeTracker,
    changeState,
    serverConfirmedStateManager,
    catchupActivityTracker
  };
}

/**
 * Message handling utilities
 */
export const messageHandlers = {
  /**
   * Register clean message handlers for a fresh test run
   */
  registerCleanHandlers(): void {
    // Clean all handlers for a fresh start
    messageDispatcher.removeAllHandlers('srv_live_changes');
    messageDispatcher.removeAllHandlers('srv_catchup_changes');
    messageDispatcher.removeAllHandlers('srv_catchup_completed');
    
    // Register default no-op handlers
    messageDispatcher.registerHandler('srv_live_changes', () => false);
    messageDispatcher.registerHandler('srv_catchup_changes', () => false);
    messageDispatcher.registerHandler('srv_catchup_completed', () => false);
    
    logger.info('Registered clean message handlers');
  },
  
  /**
   * Initialize a ClientChangeTracker and register it with messageDispatcher
   */
  initializeClientChangeTracker(): ClientChangeTracker {
    const tracker = new ClientChangeTracker();
    messageDispatcher.setOptions({ clientChangeTracker: tracker });
    return tracker;
  },
  
  /**
   * Send a catchup acknowledgment for a specific chunk
   */
  async sendCatchupAcknowledgment(
    clientId: string, 
    operations: Record<string, any>, 
    chunkNum: number, 
    lsn: string = '0/0'
  ): Promise<void> {
    const ackPayload = {
      type: 'clt_catchup_received',
      messageId: `catchup_ack_${clientId}_${Date.now()}`,
      timestamp: Date.now(),
      clientId: clientId,
      chunk: chunkNum,
      lsn: lsn
    };
    await operations.ws.sendMessage(clientId, ackPayload);
  },
  
  /**
   * Send a changes acknowledgment
   */
  async sendChangesAcknowledgment(
    clientId: string, 
    operations: Record<string, any>, 
    message: ServerChangesMessage
  ): Promise<void> {
    await operations.ws.sendMessage(clientId, {
      type: 'clt_changes_received',
      messageId: `clt_${clientId}_${Date.now()}_ack`,
      timestamp: Date.now(),
      clientId: clientId,
      changeIds: message.changes.map((c: TableChange) => c.data?.id).filter(Boolean),
      lastLSN: message.lastLSN || '0/0'
    });
  }
};

/**
 * Log match information for received changes against the current ground truth.
 */
export function logMatchInfo(context: OperationContext, clientId: string, receivedChanges: TableChangeTest[]) {
  if (receivedChanges.length === 0) return;

  const groundTruthChanges = context.state.serverConfirmedStateManager.getDatabaseChanges();
  if (groundTruthChanges.length === 0) {
    context.logger.debug(`Cannot compare matches for client ${clientId}, ground truth is still empty.`);
    return;
  }

  let matches = 0;
  // Simple comparison based on stringified representation for logging
  const groundTruthSet = new Set(groundTruthChanges.map((c: TableChangeTest) => 
    JSON.stringify({ table: c.table, op: c.operation, id: c.data?.id }))
  );

  receivedChanges.forEach(rc => {
    const receivedKey = JSON.stringify({ table: rc.table, op: rc.operation, id: rc.data?.id });
    if (groundTruthSet.has(receivedKey)) {
      matches++;
    }
  });

  const matchPercentage = (matches / receivedChanges.length) * 100;
  const profileId = context.state.clientProfiles[clientId] || '?';
  const matchMessage = `[Client ${profileId}] Batch Match: ${matches}/${receivedChanges.length} (${matchPercentage.toFixed(1)}%) changes matched current Ground Truth (${groundTruthChanges.length} total).`;

  // Use different colors for logging clarity
  if (matches === 0) {
    context.logger.warn(`${matchMessage} - Batch changes not yet in ground truth?`);
  } else {
    context.logger.info(`\x1b[32m${matchMessage}\x1b[0m`); // Green for matches
  }
}

/**
 * Validation utilities
 */
export const validationHelpers = {
  /**
   * Performs comprehensive validation of client changes including conflict resolution
   */
  async validateClientChanges(
    context: any
  ): Promise<{ success: boolean, validationResults: Record<string, any> }> {
    const clientIds = context.state.clients || [];
    const clientTracker = context.state.clientChangeTracker;
    const conflictConfig = context.state.scenarioConfig?.conflictConfig;
    const expectedWinnerClientId = context.state.actualConflictWinnerClientId;
    const conflictTaskIds = context.state.conflictTasks?.map((task: Task) => task.id) || [];
    
    // Calculate expected counts if not already done
    if (conflictConfig?.enabled && context.state.conflictWinners) {
      // Use the function from client-change-validation module
      const expectedCounts = calculateExpectedReceiveCounts(context);
      // Store in context for validation
      context.state.expectedReceivedCounts = expectedCounts;
    }
    
    let overallSuccess = true;
    const validationResults: Record<string, any> = {};

    // Check for preconditions
    if (!clientTracker) {
      context.logger.error('ClientChangeTracker instance not found in context state.');
      return { success: false, validationResults: {} };
    }
    
    // Log the data we have for debugging
    context.logger.info(`ClientChangeTracker contains data for ${clientIds.length} clients`);
    for (const cid of clientIds) {
      const profileId = context.state.clientProfiles[cid] || '?';
      const changes = clientTracker.getClientChanges(cid);
      const conflicts = clientTracker.getConflictUpdates(cid);
      context.logger.info(`  Client ${profileId}: ${changes.length} changes, ${conflicts.length} conflict updates`);
    }
    
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
        
        // Use the validateClientChangesWithConflicts function for robust validation
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
    
    return { success: overallSuccess, validationResults };
  },
  
  /**
   * Generate a validation summary table in the logs
   */
  generateValidationSummary(
    context: any,
    validationResults: Record<string, any>
  ): void {
    const clientIds = context.state.clients || [];
    const clientTracker = context.state.clientChangeTracker;
    const conflictEnabled = context.state.scenarioConfig?.conflictConfig?.enabled;
    const conflictWinners = context.state.conflictWinners || {};
    
    context.logger.info('\n=== Validation Summary ===');
    
    // Create a wider table when conflict validation is enabled
    if (conflictEnabled) {
      context.logger.info('┌────────┬──────────┬─────────────┬─────────────┬────────────────────────┐');
      context.logger.info('│ Client │ Status   │ Changes     │ Conflicts   │ Notes                  │');
      context.logger.info('├────────┼──────────┼─────────────┼─────────────┼────────────────────────┤');
    } else {
      context.logger.info('┌────────┬──────────┬─────────────┬────────────────────────┐');
      context.logger.info('│ Client │ Status   │ Changes     │ Notes                  │');
      context.logger.info('├────────┼──────────┼─────────────┼────────────────────────┤');
    }
    
    clientIds.forEach((cid: string) => {
      const result = validationResults[cid] || { success: false, error: 'No validation result' };
      const profileId = result.profileId || context.state.clientProfiles[cid] || '?';
      const statusSymbol = result.success ? '✅ PASS' : '❌ FAIL';
      
      // Extract summary information from the validation result
      const changes = result.summary?.totalChanges || clientTracker.getClientChanges(cid).length;
      const conflicts = result.summary?.conflictUpdates || clientTracker.getConflictUpdates(cid).length;
      const seenUpdates = result.summary?.seenUpdates || 0;
      const expected = context.state.expectedReceivedCounts[cid] || 0;
      const changesStr = `${changes}/${expected}`;
      
      // Create conflict stats string
      const conflictStr = `${conflicts}${seenUpdates > 0 ? ` (${seenUpdates} seen)` : ''}`;
      
      // Create a brief note
      let note = '';
      if (!result.success && result.errors && result.errors.length > 0) {
        // Take the first error and truncate if needed
        note = result.errors[0].substring(0, 20) + (result.errors[0].length > 20 ? '...' : '');
      } else if (result.success && conflictEnabled) {
        // Count how many conflicts this client won
        const wonConflicts = Object.entries(conflictWinners).filter(([_, winnerId]) => winnerId === cid).length;
        if (wonConflicts > 0) {
          note = `Won ${wonConflicts} conflict${wonConflicts > 1 ? 's' : ''}`;
        }
      }
      
      // Format row based on whether conflict validation is enabled
      if (conflictEnabled) {
        context.logger.info(
          `│ ${profileId.toString().padEnd(6)} │ ${statusSymbol.padEnd(8)} │ ${changesStr.padEnd(11)} │ ${conflictStr.padEnd(11)} │ ${note.padEnd(22)} │`
        );
      } else {
        context.logger.info(
          `│ ${profileId.toString().padEnd(6)} │ ${statusSymbol.padEnd(8)} │ ${changesStr.padEnd(11)} │ ${note.padEnd(22)} │`
        );
      }
    });
    
    // Close table based on whether conflict validation is enabled
    if (conflictEnabled) {
      context.logger.info('└────────┴──────────┴─────────────┴─────────────┴────────────────────────┘');
    } else {
      context.logger.info('└────────┴──────────┴─────────────┴────────────────────────┘');
    }
    
    // Final summary
    const successCount = Object.values(validationResults).filter((r: any) => r.success).length;
    context.logger.info(`\nOverall validation result: ${successCount === clientIds.length ? '✅ PASSED' : '❌ FAILED'} (${successCount}/${clientIds.length} clients passed)`);
  }
}; 