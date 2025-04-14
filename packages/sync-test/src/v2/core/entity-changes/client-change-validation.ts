/**
 * Client Change Validation Module
 * 
 * Provides validation utilities specific to client-side changes, including:
 * - Conflict resolution validation
 * - Client change tracking validation
 * - Client-specific change validation rules
 */

import { createLogger } from '../logger.ts';
import { TableChangeTest } from './types.ts';
import { ClientChangeTracker } from './client-change-tracker.ts';
import { validateChanges, validateSyncChanges, SyncValidationResult, DetailedValidationResult } from './validation.ts';
import { TableChange } from '@repo/sync-types';

const logger = createLogger('client-change-validation');

/**
 * Calculate expected receive counts accounting for conflict winners
 * Uses actual conflict resolution data from the test execution
 * 
 * @param context The scenario context containing clients and conflict winners
 * @returns An object mapping client IDs to their expected receive counts
 */
export function calculateExpectedReceiveCounts(context: any): Record<string, number> {
  const clients = context.state.clients || [];
  const clientCount = clients.length;
  const changesPerClient = context.state.scenarioConfig?.changesPerClient || 0;
  const expectedCounts: Record<string, number> = {};
  
  // First check if we have data about conflict winners
  if (!context.state.conflictWinners || Object.keys(context.state.conflictWinners).length === 0) {
    logger.warn('No conflict winners found. Using base expected counts calculation.');
    
    // Use basic calculation if no conflict winners
    for (const clientId of clients) {
      expectedCounts[clientId] = (clientCount - 1) * changesPerClient;
    }
    return expectedCounts;
  }
  
  logger.info('Calculating expected receive counts using actual conflict resolution data');
  
  // Start with the maximum possible changes (all changes from all other clients)
  const baseExpectedCount = (clientCount - 1) * changesPerClient;
  
  // Get all conflict tasks that had winners
  const conflictTaskIds = Object.keys(context.state.conflictWinners);
  
  // Track which client actually submitted changes for which conflict task
  // We can get this from the clientSubmittedChanges in the context
  const clientToConflictTaskMap: Record<string, string[]> = {};
  
  // For each client, find the conflict tasks they attempted to update
  for (const clientId of clients) {
    const submittedChanges = context.state.clientSubmittedChanges[clientId] || [];
    const conflictTasksUpdated = submittedChanges
      .filter((change: TableChangeTest) => 
        change.operation === 'update' && 
        change.table === 'tasks' &&
        conflictTaskIds.includes(change.data?.id)
      )
      .map((change: TableChangeTest) => change.data.id);
    
    clientToConflictTaskMap[clientId] = conflictTasksUpdated;
  }
  
  // For each conflict task, determine how many clients attempted to update it
  const conflictTaskToClientCountMap: Record<string, number> = {};
  conflictTaskIds.forEach(taskId => {
    const clientsUpdatingTask = clients.filter((clientId: string) => 
      clientToConflictTaskMap[clientId]?.includes(taskId)
    );
    conflictTaskToClientCountMap[taskId] = clientsUpdatingTask.length;
  });
  
  // Calculate expected counts for each client
  for (const clientId of clients) {
    // 1. Start with base count (changes from all other clients)
    let adjustedCount = baseExpectedCount;
    
    // 2. Find conflict tasks this client won
    const wonTaskIds = conflictTaskIds.filter(taskId => 
      context.state.conflictWinners[taskId] === clientId
    );
    const wonCount = wonTaskIds.length;
    
    // 3. Find duplicate conflict tasks (tasks updated by multiple clients)
    // We need to count duplicates this client would have received
    let duplicateCount = 0;
    
    // For each conflict task that had multiple clients updating it
    for (const taskId of conflictTaskIds) {
      // Skip tasks won by this client (already counted in wonCount)
      if (context.state.conflictWinners[taskId] === clientId) continue;
      
      // Skip tasks not updated by this client (they'd receive all updates)
      if (!clientToConflictTaskMap[clientId]?.includes(taskId)) continue;
      
      // If multiple clients updated this task, count duplicates
      const clientCount = conflictTaskToClientCountMap[taskId];
      
      // This was overcounting duplicates - a client only misses updates if it's their own conflict
      // and they lost, not because of general deduplication
      if (clientCount > 1) {
        // The duplicate count should be less aggressive 
        // Only count a duplicate if we have strong evidence of deduplication
        const clientsUpdatingTask = clients.filter((cid: string) => 
          clientToConflictTaskMap[cid]?.includes(taskId) && cid !== clientId
        );
        
        // Only count as a duplicate if multiple other clients updated this task
        // and this client also updated it but lost
        if (clientsUpdatingTask.length > 1) {
          duplicateCount += 1; // Only count 1 duplicate per task, not clientCount-1
        }
      }
    }
    
    // 4. Calculate total missed updates
    const missedUpdates = wonCount + duplicateCount;
    
    // 5. Calculate final expected count
    adjustedCount -= missedUpdates;
    expectedCounts[clientId] = adjustedCount;
    
    const profileId = context.state.clientProfiles[clientId];
    logger.info(`[Client ${profileId}] Expected received count: ${adjustedCount} (base: ${baseExpectedCount}, won conflicts: ${wonCount}, duplicates: ${duplicateCount}, missed updates: ${missedUpdates})`);
  }
  
  return expectedCounts;
}

/**
 * Validates client changes with conflict resolution
 */
export async function validateClientChangesWithConflicts(
  clientId: string,
  clientTracker: ClientChangeTracker,
  options: {
    expectedChanges?: number;
    conflictConfig?: {
      enabled: boolean;
      expectedWinningClient?: string;
    };
  } = {}
): Promise<ClientValidationResult> {
  logger.info(`Validating changes for client ${clientId} with conflict resolution`);

  const clientChanges = clientTracker.getClientChanges(clientId);
  const conflictUpdates = clientTracker.getConflictUpdates(clientId);
  const seenUpdates = clientTracker.getSeenUpdates();

  // First validate the general changes using the base validation
  const baseValidation = await validateChanges(clientChanges);

  // Then validate conflict-specific aspects
  const conflictValidation = validateConflictResolution(
    clientId,
    clientChanges,
    conflictUpdates,
    seenUpdates,
    options.conflictConfig
  );

  // Combine results
  const success = baseValidation.success && conflictValidation.success;
  
  // Extract errors based on validation result type
  const baseErrors: string[] = [];
  if ('errors' in baseValidation) {
    // DetailedValidationResult
    baseErrors.push(...baseValidation.errors.map(err => 
      `${err.entityType} ${err.entityId}: ${err.errors.join(', ')}`
    ));
  } else {
    // SyncValidationResult
    if (baseValidation.details.missingChanges.length > 0) {
      baseErrors.push(`Missing ${baseValidation.details.missingChanges.length} changes`);
    }
    if (baseValidation.details.extraChanges.length > 0) {
      baseErrors.push(`Extra ${baseValidation.details.extraChanges.length} changes`);
    }
  }

  const errors = [
    ...baseErrors,
    ...(conflictValidation.errors || [])
  ];

  return {
    success,
    clientId,
    summary: {
      totalChanges: clientChanges.length,
      conflictUpdates: conflictUpdates.length,
      seenUpdates: seenUpdates.size
    },
    details: {
      baseValidation,
      conflictValidation,
      errors
    }
  };
}

/**
 * Validates conflict resolution for a client
 */
function validateConflictResolution(
  clientId: string,
  clientChanges: TableChange[],
  conflictUpdates: TableChangeTest[],
  seenUpdates: Map<string, { clientId: string; taskId: string; batchNumber: number }>,
  config?: {
    enabled: boolean;
    expectedWinningClient?: string;
  }
): ConflictValidationResult {
  const errors: string[] = [];
  const isWinningClient = config?.expectedWinningClient === clientId;

  // If conflicts are enabled, validate conflict updates
  if (config?.enabled) {
    // Winning client should not receive their own conflict updates
    if (isWinningClient) {
      const hasOwnConflictUpdate = conflictUpdates.some(update => 
        update.data?.clientId === clientId || 
        update.data?.client_id === clientId ||
        update._originClientId === clientId
      );
      if (hasOwnConflictUpdate) {
        errors.push(`Winning client ${clientId} received their own conflict update`);
      }
    } else {
      // Losing client should receive the winning update
      const hasWinningUpdate = conflictUpdates.some(update => 
        update.data?.clientId === config.expectedWinningClient || 
        update.data?.client_id === config.expectedWinningClient ||
        update._originClientId === config.expectedWinningClient
      );
      if (!hasWinningUpdate) {
        errors.push(`Losing client ${clientId} did not receive winning update from ${config.expectedWinningClient}`);
      }
    }

    // Validate seen updates
    for (const [taskId, update] of seenUpdates.entries()) {
      if (isWinningClient && update.clientId === clientId) {
        errors.push(`Winning client ${clientId} saw their own update for task ${taskId}`);
      }
    }
  }

  return {
    success: errors.length === 0,
    errors
  };
}

/**
 * Extended validation result type for client changes
 */
export interface ClientValidationResult {
  success: boolean;
  clientId: string;
  summary: {
    totalChanges: number;
    conflictUpdates: number;
    seenUpdates: number;
  };
  details: {
    baseValidation: DetailedValidationResult | SyncValidationResult;
    conflictValidation: ConflictValidationResult;
    errors: string[];
  };
}

/**
 * Validation result for conflict resolution
 */
interface ConflictValidationResult {
  success: boolean;
  errors: string[];
}

/**
 * Generate a validation summary table in the logs
 * 
 * @param context The scenario context containing client data and validation results
 * @param validationResults The validation results from validateClientChanges
 */
export function generateValidationSummary(
  context: any,
  validationResults: Record<string, any>
): void {
  const clientIds = context.state.clients || [];
  const clientTracker = context.state.clientChangeTracker;
  const conflictEnabled = context.state.scenarioConfig?.conflictConfig?.enabled;
  const conflictWinners = context.state.conflictWinners || {};
  
  logger.info('\n=== Validation Summary ===');
  
  // Create a wider table when conflict validation is enabled
  if (conflictEnabled) {
    logger.info('┌────────┬──────────┬─────────────┬─────────────┬────────────────────────┐');
    logger.info('│ Client │ Status   │ Changes     │ Conflicts   │ Notes                  │');
    logger.info('├────────┼──────────┼─────────────┼─────────────┼────────────────────────┤');
  } else {
    logger.info('┌────────┬──────────┬─────────────┬────────────────────────┐');
    logger.info('│ Client │ Status   │ Changes     │ Notes                  │');
    logger.info('├────────┼──────────┼─────────────┼────────────────────────┤');
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
      logger.info(
        `│ ${profileId.toString().padEnd(6)} │ ${statusSymbol.padEnd(8)} │ ${changesStr.padEnd(11)} │ ${conflictStr.padEnd(11)} │ ${note.padEnd(22)} │`
      );
    } else {
      logger.info(
        `│ ${profileId.toString().padEnd(6)} │ ${statusSymbol.padEnd(8)} │ ${changesStr.padEnd(11)} │ ${note.padEnd(22)} │`
      );
    }
  });
  
  // Close table based on whether conflict validation is enabled
  if (conflictEnabled) {
    logger.info('└────────┴──────────┴─────────────┴─────────────┴────────────────────────┘');
  } else {
    logger.info('└────────┴──────────┴─────────────┴────────────────────────┘');
  }
  
  // Final summary
  const successCount = Object.values(validationResults).filter((r: any) => r.success).length;
  logger.info(`\nOverall validation result: ${successCount === clientIds.length ? '✅ PASSED' : '❌ FAILED'} (${successCount}/${clientIds.length} clients passed)`);
} 