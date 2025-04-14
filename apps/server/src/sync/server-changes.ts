import type { 
  TableChange,
  ServerMessage,
  ServerChangesMessage,
  ServerStateChangeMessage,
  ServerLSNUpdateMessage,
  ServerSyncCompletedMessage,
  ServerCatchupCompletedMessage,
  ServerSyncStatsMessage
} from '@repo/sync-types';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import type { WebSocketHandler } from './types';
import { SERVER_TABLE_HIERARCHY } from '@repo/dataforge/server-entities';
import { getDBClient } from '../lib/db';
import { compareLSN, deduplicateChanges, orderChangesByDomain as baseOrderChangesByDomain } from '../lib/sync-common';
import { sql } from '../lib/db';
import type { SyncStateManager } from './state-manager';

// Constants for chunking
// 500 is a good balance between batch size and message size
// - Large enough to avoid excessive chunking for normal-sized sync operations
// - Small enough to prevent memory pressure or timeout issues
// - Matches the page size used in database queries for consistency
const DEFAULT_CHUNK_SIZE = 500;

type TableName = keyof typeof SERVER_TABLE_HIERARCHY;

const MODULE_NAME = 'server-changes';

/**
 * Helper function to process a raw batch of changes fetched from the database.
 * Applies deduplication, domain-specific ordering, and client filtering.
 * 
 * @param rawChanges The raw changes array from change_history.
 * @param clientId The ID of the client requesting the sync, to filter out their own changes.
 * @returns Processed and filtered array of TableChange.
 */
function processRawChangesBatch(
  rawChanges: TableChange[],
  clientId: string
): TableChange[] {
  if (rawChanges.length === 0) {
    return [];
  }

  // 1. Deduplicate changes
  const dedupResult = deduplicateChanges(rawChanges);
  const dedupChanges = dedupResult.changes;

  // Add debug log for deduplication details
  if (rawChanges.length !== dedupChanges.length) {
    syncLogger.debug('Deduplication applied', {
      clientId,
      before: rawChanges.length,
      after: dedupChanges.length,
      removed: rawChanges.length - dedupChanges.length,
      skippedMissingIdCount: dedupResult.skipped?.missingId?.length || 0,
      skippedOutdatedCount: dedupResult.skipped?.outdated?.length || 0,
      transformationCount: dedupResult.transformations?.count || 0
    }, MODULE_NAME);
  }

  if (dedupChanges.length === 0) {
    return [];
  }
  
  // 2. Order changes by domain hierarchy
  // Assuming orderChangesByDomain function exists and works correctly
  // If it doesn't exist, this step needs implementation or removal.
  const orderedChanges = baseOrderChangesByDomain(dedupChanges); // Using imported base function

  // 3. Filter out changes originated by the requesting client
  const filteredChanges = orderedChanges.filter(change => {
    return !change.data?.client_id || change.data.client_id !== clientId;
  });

  syncLogger.debug('Processed raw changes batch', {
    clientId,
    rawCount: rawChanges.length,
    deduplicatedCount: dedupChanges.length,
    orderedCount: orderedChanges.length, // Usually same as deduped
    filteredCount: filteredChanges.length
  }, MODULE_NAME);

  return filteredChanges;
}

/**
 * Send catchup changes to client using the message handler with chunking support and flow control
 */
export async function sendCatchupChanges(
  changes: TableChange[],
  lastLSN: string,
  clientId: string,
  messageHandler: WebSocketHandler
): Promise<boolean> {
  syncLogger.info('Starting catchup changes send', {
    clientId,
    changeCount: changes.length,
    lastLSN
  }, MODULE_NAME);

  if (!changes.length) {
    syncLogger.info('No changes to send for catchup', { clientId }, MODULE_NAME);
    return false;
  }

  // Calculate chunks
  const chunks = Math.ceil(changes.length / DEFAULT_CHUNK_SIZE);
  const success: boolean[] = [];

  syncLogger.info('Preparing to send catchup chunks', {
    clientId,
    totalChunks: chunks,
    changesPerChunk: DEFAULT_CHUNK_SIZE
  }, MODULE_NAME);

  for (let i = 0; i < chunks; i++) {
    const start = i * DEFAULT_CHUNK_SIZE;
    const end = Math.min(start + DEFAULT_CHUNK_SIZE, changes.length);
    const chunkChanges = changes.slice(start, end);

    // Ensure all changes have proper table property set as string
    for (const change of chunkChanges) {
      if (change.table === undefined) {
        syncLogger.warn('Found change with undefined table property', { 
          clientId,
          operation: change.operation,
          id: change.data?.id
        }, MODULE_NAME);
        // Set a default value to prevent it from being dropped during serialization
        change.table = 'unknown';
      }
    }

    syncLogger.debug('Preparing catchup chunk', {
      clientId,
      chunk: i + 1,
      total: chunks,
      changesInChunk: chunkChanges.length
    }, MODULE_NAME);

    const message: ServerChangesMessage = {
      type: 'srv_catchup_changes',
      messageId: `srv_${Date.now()}_${i}`,
      timestamp: Date.now(),
      clientId,
      changes: chunkChanges,
      lastLSN: i === chunks - 1 ? lastLSN : chunkChanges[chunkChanges.length - 1].lsn!,
      sequence: { chunk: i + 1, total: chunks }
    };

    try {
      syncLogger.debug('Sending catchup chunk', {
        clientId,
        chunk: i + 1,
        total: chunks,
        messageId: message.messageId
      }, MODULE_NAME);

      await messageHandler.send(message);
      
      // Wait for client acknowledgment (flow control for catchup sync)
      syncLogger.debug('Waiting for chunk acknowledgment', {
        clientId,
        chunk: i + 1,
        total: chunks
      }, MODULE_NAME);
      
      try {
        // Wait for client to acknowledge this specific chunk
        await messageHandler.waitForMessage(
          'clt_catchup_received',
          (msg) => msg.chunk === i + 1,
          30000 // 30 second timeout
        );
        
        syncLogger.debug('Received chunk acknowledgment', {
          clientId,
          chunk: i + 1,
          total: chunks
        }, MODULE_NAME);
      } catch (ackError) {
        syncLogger.error('Failed to receive chunk acknowledgment', {
          clientId,
          chunk: i + 1,
          total: chunks,
          error: ackError instanceof Error ? ackError.message : String(ackError)
        }, MODULE_NAME);
        success.push(false);
        continue; // Skip to next chunk
      }
      
      success.push(true);
      
      syncLogger.debug('Sent catchup changes chunk', {
        clientId,
        chunk: i + 1,
        total: chunks,
        count: chunkChanges.length,
        lastLSN: message.lastLSN,
        tables: [...new Set(chunkChanges.map(c => c.table))].length
      }, MODULE_NAME);
    } catch (err) {
      success.push(false);
      syncLogger.error('Catchup chunk send failed', {
        clientId,
        chunk: i + 1,
        total: chunks,
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
    }
  }

  // Return true only if all chunks were sent successfully
  const allSuccess = success.every(s => s);
  syncLogger.info('Catchup changes send completed', {
    clientId,
    success: allSuccess,
    totalChunks: chunks,
    successfulChunks: success.filter(s => s).length
  }, MODULE_NAME);

  return allSuccess;
}

/**
 * Create a successful catchup sync completion message
 */
export function createCatchupSyncCompletion(
  clientId: string,
  startLSN: string,
  finalLSN: string,
  changeCount: number
): ServerCatchupCompletedMessage {
  return {
    type: 'srv_catchup_completed',
    messageId: `srv_${Date.now()}_completion`,
    timestamp: Date.now(),
    clientId,
    startLSN,
    finalLSN,
    changeCount,
    success: true
  };
}

/**
 * Create a failed catchup sync completion message
 */
export function createCatchupSyncError(
  clientId: string,
  startLSN: string,
  error: Error | string
): ServerCatchupCompletedMessage {
  return {
    type: 'srv_catchup_completed',
    messageId: `srv_${Date.now()}_completion`,
    timestamp: Date.now(),
    clientId,
    startLSN,
    finalLSN: startLSN,
    changeCount: 0,
    success: false,
    error: error instanceof Error ? error.message : String(error)
  };
}

/**
 * Perform catchup sync for a client
 * This fetches changes directly from the change_history table in batches.
 */
export async function performCatchupSync(
  context: MinimalContext,
  clientId: string,
  clientLSN: string,
  initialServerLSN: string, // The server LSN when the catchup request was initiated
  messageHandler: WebSocketHandler,
  stateManager: SyncStateManager
): Promise<void> {
  const functionStartTime = Date.now(); // Log function start time
  syncLogger.info('Starting catchup sync', {
    clientId,
    clientLSN,
    initialServerLSN
  }, MODULE_NAME);

  let currentLSN = clientLSN;
  let totalChangeCount = 0;
  let success = true;
  const BATCH_SIZE = 5000; // Size of batches to query from DB

  try {
    // --- Phase 1: Bulk Catch-up Loop --- 
    let phase1Complete = false;
    let phase1Iteration = 0;
    
    const phase1StartTime = Date.now();
    syncLogger.debug('[TIMING] Phase 1: Starting bulk catch-up processing', {
      clientId,
      startLSN: currentLSN,
      targetLSN: initialServerLSN,
      timestamp: phase1StartTime
    }, MODULE_NAME);
    
    while (success && !phase1Complete) {
      phase1Iteration++;
      const iterationStartTime = Date.now();
      syncLogger.debug(`[TIMING] Phase 1: Processing batch #${phase1Iteration}`, {
        clientId,
        currentLSN,
        targetLSN: initialServerLSN,
        timestamp: iterationStartTime
      }, MODULE_NAME);

      let rawBatchChanges: TableChange[] = [];
      syncLogger.debug(`[TIMING] Phase 1: Getting DB client for batch #${phase1Iteration}`, { clientId, timestamp: Date.now() });
      const batchClient = getDBClient(context);
      try { 
        const connectStartTime = Date.now();
        syncLogger.debug(`[TIMING] Phase 1: Connecting DB client for batch #${phase1Iteration}`, { clientId, timestamp: connectStartTime });
        await batchClient.connect();
        syncLogger.debug(`[TIMING] Phase 1: DB client connected for batch #${phase1Iteration} (took ${Date.now() - connectStartTime}ms)`, { clientId, timestamp: Date.now() });
        
        const queryStartTime = Date.now();
        syncLogger.debug(`[TIMING] Phase 1: Querying DB for batch #${phase1Iteration}`, { clientId, timestamp: queryStartTime });
        const batchResult = await batchClient.query<TableChange>(`
          SELECT lsn, table_name as "table", operation, data, timestamp 
          FROM change_history 
          WHERE 
            lsn::pg_lsn > $1::pg_lsn -- Fetch all changes after client LSN
            AND (data->>'client_id' IS NULL OR data->>'client_id' != $2) -- Adjusted parameter index
          ORDER BY lsn::pg_lsn ASC
          LIMIT $3 -- Adjusted parameter index
        `, [currentLSN, clientId, BATCH_SIZE]); // Removed initialServerLSN, adjusted indices
        syncLogger.debug(`[TIMING] Phase 1: DB query finished for batch #${phase1Iteration} (took ${Date.now() - queryStartTime}ms)`, { clientId, timestamp: Date.now(), rowCount: batchResult.rowCount });

        rawBatchChanges = batchResult.rows.map((row: any) => ({
          table: row.table || 'unknown',
          operation: row.operation,
          data: row.data,
          lsn: row.lsn,
          updated_at: row.timestamp || new Date().toISOString()
        }));
      } finally {
        const endClientStartTime = Date.now();
        syncLogger.debug(`[TIMING] Phase 1: Ending DB client connection for batch #${phase1Iteration}`, { clientId, timestamp: endClientStartTime });
        await batchClient.end();
        syncLogger.debug(`[TIMING] Phase 1: DB client ended for batch #${phase1Iteration} (took ${Date.now() - endClientStartTime}ms)`, { clientId, timestamp: Date.now() });
      }

      if (rawBatchChanges.length === 0) {
        syncLogger.debug('[TIMING] Phase 1: No more changes found', { clientId, iteration: phase1Iteration, timestamp: Date.now() });
        phase1Complete = true;
        break; 
      }

      const processStartTime = Date.now();
      syncLogger.debug(`[TIMING] Phase 1: Processing raw changes for batch #${phase1Iteration}`, { clientId, rawCount: rawBatchChanges.length, timestamp: processStartTime });
      const processedBatchChanges = processRawChangesBatch(rawBatchChanges, clientId);
      syncLogger.debug(`[TIMING] Phase 1: Processing raw changes finished for batch #${phase1Iteration} (took ${Date.now() - processStartTime}ms)`, { clientId, processedCount: processedBatchChanges.length, timestamp: Date.now() });

      if (processedBatchChanges.length > 0) {
        const sendStartTime = Date.now();
        syncLogger.debug(`[TIMING] Phase 1: Calling sendCatchupChanges for batch #${phase1Iteration}`, { clientId, changeCount: processedBatchChanges.length, timestamp: sendStartTime });
        const batchSuccess = await sendCatchupChanges(
          processedBatchChanges,
          processedBatchChanges[processedBatchChanges.length - 1].lsn || initialServerLSN, 
          clientId,
          messageHandler
        );
        syncLogger.debug(`[TIMING] Phase 1: sendCatchupChanges returned for batch #${phase1Iteration} (took ${Date.now() - sendStartTime}ms)`, { clientId, success: batchSuccess, timestamp: Date.now() });

        if (!batchSuccess) {
          success = false;
          syncLogger.error(`Phase 1: Failed to send changes for batch #${phase1Iteration}`, { clientId });
          break; // Exit Phase 1 loop on failure
        }
        
        // Update LSN based on the LAST PROCESSED change sent
        currentLSN = processedBatchChanges[processedBatchChanges.length - 1].lsn || currentLSN;
        totalChangeCount += processedBatchChanges.length;
      } else {
        // If all changes were filtered/deduped, update LSN based on the last RAW change fetched
        // Ensure currentLSN only moves forward
        const lastRawLSN = rawBatchChanges[rawBatchChanges.length - 1]?.lsn;
        if (lastRawLSN && compareLSN(lastRawLSN, currentLSN) > 0) {
           currentLSN = lastRawLSN;
        }
      }

      if (rawBatchChanges.length < BATCH_SIZE) {
         syncLogger.debug('[TIMING] Phase 1: Processed partial DB batch, bulk phase complete.', { clientId, iteration: phase1Iteration, timestamp: Date.now() });
         phase1Complete = true;
         // currentLSN is already updated above
         break; // Exit Phase 1 loop
      }
      syncLogger.debug(`[TIMING] Phase 1: Completed batch #${phase1Iteration} (total took ${Date.now() - iterationStartTime}ms)`, { clientId, timestamp: Date.now() });
    }
    syncLogger.debug(`[TIMING] Catchup loop finished (total took ${Date.now() - phase1StartTime}ms)`, { clientId, success, finalLSN: currentLSN, timestamp: Date.now() });
    // --- End of Catchup Loop ---

    if (!success) {
      throw new Error(`Catchup sync failed during processing at LSN ${currentLSN}`);
    }

    syncLogger.info('Catchup processing completed', {
      clientId,
      processedCount: totalChangeCount,
      finalLSN: currentLSN
    }, MODULE_NAME);

    // --- Phase 3: Completion --- 
    const completionStartTime = Date.now();
    syncLogger.info('Catchup Phase 3 (Completion) starting', {
      clientId,
      finalLSN: currentLSN
    }, MODULE_NAME);
    syncLogger.debug('[TIMING] Phase 3: Starting completion steps', { clientId, finalLSN: currentLSN, timestamp: completionStartTime });
    
    const syncCompletedMsg = createCatchupSyncCompletion(
      clientId,
      clientLSN,
      currentLSN, 
      totalChangeCount
    );
    
    // Add retry capability for catchup completion message
    const MAX_COMPLETION_RETRIES = 3;
    let completionSuccess = false;
    let retryCount = 0;
    
    while (!completionSuccess && retryCount < MAX_COMPLETION_RETRIES) {
      try {
        syncLogger.debug('[TIMING] Phase 3: Sending completion message', { 
          clientId, 
          retryCount, 
          timestamp: Date.now(),
          messageId: syncCompletedMsg.messageId
        });
        
        await messageHandler.send(syncCompletedMsg);
        
        // Mark as successful
        completionSuccess = true;
        syncLogger.debug('[TIMING] Phase 3: Completion message sent successfully', { 
          clientId, 
          retryCount,
          timestamp: Date.now(),
          messageId: syncCompletedMsg.messageId
        });
      } catch (err) {
        retryCount++;
        syncLogger.error(`[TIMING] Phase 3: Failed to send completion message (attempt ${retryCount})`, { 
          clientId, 
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now()
        });
        
        // Add small delay before retrying
        if (retryCount < MAX_COMPLETION_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
        }
      }
    }
    
    if (!completionSuccess) {
      throw new Error(`Failed to send catchup completion message after ${MAX_COMPLETION_RETRIES} attempts`);
    }
    
    // Update client state with the new LSN
    try {
      syncLogger.debug('[TIMING] Phase 3: Updating client LSN in state manager', { 
        clientId, 
        finalLSN: currentLSN
      });
      
      await stateManager.updateClientLSN(clientId, currentLSN);
      
      syncLogger.debug('[TIMING] Phase 3: Client LSN updated successfully', { 
        clientId, 
        lsn: currentLSN
      });
    } catch (err) {
      syncLogger.error('[TIMING] Phase 3: Failed to update client LSN in state manager', { 
        clientId, 
        error: err instanceof Error ? err.message : String(err)
      });
      // Non-critical error, don't throw
    }
    
    syncLogger.info('Catchup sync completed successfully', { 
      clientId, 
      startLSN: clientLSN,
      finalLSN: currentLSN,
      totalChangeCount,
      durationMs: Date.now() - functionStartTime
    });
    syncLogger.debug('[TIMING] Phase 3: Catchup sync completed successfully', { 
      clientId, 
      startLSN: clientLSN,
      finalLSN: currentLSN,
      totalChangeCount,
      durationMs: Date.now() - functionStartTime
    });

  } catch (error) {
    syncLogger.error(`[TIMING] performCatchupSync failed (total took ${Date.now() - functionStartTime}ms)`, {
      clientId,
      clientLSN,
      finalReportedLSN: currentLSN, // Log where we ended up
      initialServerLSN,
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    
    // Send failure message to client
    try {
      const failureMsg = createCatchupSyncError(
      clientId,
      clientLSN,
      error instanceof Error ? error : String(error)
    );
      await messageHandler.send(failureMsg);
    } catch (msgError) {
      syncLogger.error('Failed to send catchup failure message', {
      clientId,
        error: msgError instanceof Error ? msgError.message : String(msgError)
    }, MODULE_NAME);
    }
    
    // Rethrow the error to ensure the scenario runner sees the failure
    throw error;
  }
}

/**
 * Order changes based on table hierarchy and operation type with logging
 * Wrapper around the core orderChangesByDomain function
 */
export function orderChangesByDomain(changes: TableChange[]): TableChange[] {
  const ordered = baseOrderChangesByDomain(changes);
  
  // Count operations by type for logging
  const operationCounts = ordered.reduce((acc, change) => {
    acc[change.operation] = (acc[change.operation] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Ensure all operation types are represented in logs, even if count is 0
  const operations = {
    insert: operationCounts.insert || 0,
    update: operationCounts.update || 0,
    delete: operationCounts.delete || 0
  };

  syncLogger.debug('Changes ordered', {
    tableCount: Object.keys(ordered.reduce((acc, change) => {
      acc[change.table] = true;
      return acc;
    }, {} as Record<string, boolean>)).length,
    operations
  }, MODULE_NAME);

  return ordered;
}

/**
 * Send live changes to client without waiting for acknowledgment
 */
export async function sendLiveChanges(
  context: MinimalContext,
  clientId: string,
  changes: TableChange[],
  messageHandler: WebSocketHandler,
  providedLSN?: string
): Promise<{ success: boolean; lsn: string }> {
  const MODULE_TAG = `${MODULE_NAME}:live-changes`;
  
  // Start tracking time for performance monitoring
  const startTime = Date.now();
  
  try {
    syncLogger.debug('Sending live changes', { 
      clientId, 
      changeCount: changes.length,
      tables: [...new Set(changes.map(c => c.table))].join(','),
      providedLSN: providedLSN || 'not provided'
    }, MODULE_TAG);
    
    // Skip if no changes
    if (!changes.length) {
      syncLogger.info('No changes to send', { clientId }, MODULE_TAG);
      return { success: true, lsn: providedLSN || '0/0' };
    }
    
    // Process the changes (deduplicate and order them)
    let orderedChanges = changes;
    
    // Deduplicate in case we have overlapping changes
    // NOTE: Deduplication is now handled in process-changes.ts, keeping this commented
    // as a reference but skipping the operation to avoid double work
    /*
    if (changes.length > 1) {
      orderedChanges = deduplicateChanges(changes);
      syncLogger.debug('Deduplicated changes', {
        before: changes.length,
        after: orderedChanges.length
      }, MODULE_TAG);
    }
    */
    
    // Filter out changes that originated from this client
    const originalCount = orderedChanges.length;
    orderedChanges = orderedChanges.filter(change => {
      // Access client_id from change.data if it exists
      return !change.data?.client_id || change.data.client_id !== clientId;
    });
    
    // Log filtered changes
    if (orderedChanges.length !== originalCount) {
      syncLogger.debug('Filtered out client\'s own changes', {
        clientId,
        before: originalCount,
        after: orderedChanges.length,
        filtered: originalCount - orderedChanges.length
      }, MODULE_TAG);
    }
    
    // Order by domain tables hierarchy to ensure consistency
    orderedChanges = orderChangesByDomain(orderedChanges);
    
    // For live changes, we should always prefer the LSN from the changes when available
    let currentLSN: string;
    
    // Extract the LSN from the last change in the ordered list if available
    const changesHaveLSN = orderedChanges.length > 0 && orderedChanges[orderedChanges.length - 1].lsn;
    
    if (changesHaveLSN) {
      // Prefer the LSN from the changes for live sync
      currentLSN = String(orderedChanges[orderedChanges.length - 1].lsn);
      syncLogger.debug('Using LSN from changes', { 
        clientId, 
        lsn: currentLSN 
      }, MODULE_TAG);
    } else if (providedLSN) {
      // Fall back to provided LSN only if changes don't have LSN
      currentLSN = providedLSN;
      syncLogger.debug('Using provided LSN (changes have no LSN)', { 
        clientId, 
        lsn: currentLSN 
      }, MODULE_TAG);
    } else {
      // Last resort default
      currentLSN = '0/0';
      syncLogger.debug('No LSN available, using default', { 
        clientId, 
        lsn: currentLSN 
      }, MODULE_TAG);
    }
    
    // Send changes to the client
    syncLogger.debug('Sending live changes', {
      clientId,
      count: orderedChanges.length,
      lsn: currentLSN
    }, MODULE_TAG);
    
    // Calculate chunks
    const chunks = Math.ceil(orderedChanges.length / DEFAULT_CHUNK_SIZE);
    const chunkSuccess: boolean[] = [];

    // Keep track of the actual last LSN sent
    let lastSentLSN = currentLSN;

    for (let i = 0; i < chunks; i++) {
      const start = i * DEFAULT_CHUNK_SIZE;
      const end = Math.min(start + DEFAULT_CHUNK_SIZE, orderedChanges.length);
      const chunkChanges = orderedChanges.slice(start, end);
      
      // Ensure all changes have proper table property set as string
      for (const change of chunkChanges) {
        if (change.table === undefined) {
          syncLogger.warn('Found change with undefined table property', { 
            clientId,
            operation: change.operation,
            id: change.data?.id
          }, MODULE_TAG);
          // Set a default value to prevent it from being dropped during serialization
          change.table = 'unknown';
        }
      }
      
      // For the last chunk, use the overall last LSN
      // For intermediate chunks, use the LSN of the last change in this chunk
      const chunkLastLSN = i === chunks - 1 ? 
        currentLSN : 
        (chunkChanges[chunkChanges.length - 1].lsn || currentLSN);
      
      // If this is the last chunk, update the lastSentLSN
      if (i === chunks - 1) {
        lastSentLSN = chunkLastLSN;
      }

      const message: ServerChangesMessage = {
        type: 'srv_live_changes',
        messageId: `srv_${Date.now()}_${i}`,
        timestamp: Date.now(),
        clientId,
        changes: chunkChanges,
        lastLSN: chunkLastLSN,
        sequence: { chunk: i + 1, total: chunks }
      };

      try {
        // Log first change in detail to help debug table field issue
        if (chunkChanges.length > 0) {
          const sampleChanges = chunkChanges.slice(0, 3);
          syncLogger.debug('Detailed change inspection before sending', {
            clientId,
            sampleProperties: sampleChanges.map(c => ({ 
              table: c.table, 
              hasTable: c.table !== undefined,
              tableType: typeof c.table, 
              operation: c.operation
            })),
            hasTableProperty: sampleChanges.every(c => c.table !== undefined),
            tableValues: sampleChanges.map(c => c.table).join(','),
            changeKeys: Object.keys(sampleChanges[0]).join(',')
          }, MODULE_TAG);
        }
        
        await messageHandler.send(message);
        chunkSuccess.push(true);
        
        syncLogger.debug('Sent live changes chunk', {
          clientId,
          chunk: i + 1,
          total: chunks,
          count: chunkChanges.length,
          lastLSN: message.lastLSN
        }, MODULE_TAG);
      } catch (err) {
        chunkSuccess.push(false);
        syncLogger.error('Live chunk send failed', {
          clientId,
          chunk: i + 1,
          total: chunks,
          error: err instanceof Error ? err.message : String(err)
        }, MODULE_TAG);
      }
    }
    
    const sendSuccess = chunkSuccess.every(s => s);
    
    if (!sendSuccess) {
      syncLogger.error('Failed to send live changes', { 
        clientId,
        count: orderedChanges.length
      }, MODULE_TAG);
      return { success: false, lsn: '0/0' };
    }
    
    syncLogger.info('Live changes sent successfully', {
      clientId,
      lsn: lastSentLSN,
      changeCount: orderedChanges.length,
      duration: Date.now() - startTime
    }, MODULE_TAG);
    
    // Return the LSN of the last change actually sent, not the providedLSN
    return { success: true, lsn: lastSentLSN };
  } catch (error) {
    syncLogger.error('Live changes send failed', {
      clientId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }, MODULE_TAG);
    return { success: false, lsn: '0/0' };
  }
}

/**
 * Create a confirmation message for a client that's already in sync
 * Used when a client connects and is already up-to-date
 */
export function createLiveSyncConfirmation(
  clientId: string,
  lsn: string
): ServerSyncCompletedMessage {
  return {
    type: 'srv_sync_completed',
    messageId: `srv_${Date.now()}_completion`,
    timestamp: Date.now(),
    clientId,
    startLSN: lsn,  // Current LSN as both start and final
    finalLSN: lsn,
    changeCount: 0, // No changes were sent
    success: true
  };
}

// Remove or comment out the old fetchAndProcessChanges and fetchAndProcessBatch functions
// as their logic is now integrated into performCatchupSync or handled by sendCatchupChanges

/*
async function fetchAndProcessChanges(...) { ... }
async function fetchAndProcessBatch(...) { ... }
*/

// Helper function to summarize transformations
function summarizeTransformations(details: Array<{
  from: string;
  to: string;
  entityId: string;
  table: string;
  reason: string;
  timestamp?: string;
  lsn?: string;
}>): Array<{ from: string; to: string; count: number; tables: string[] }> {
  // Group transformations by from->to pattern
  const groups: Record<string, {
    from: string;
    to: string;
    count: number;
    tables: Set<string>;
    entities: Set<string>;
  }> = {};
  
  details.forEach(detail => {
    const key = `${detail.from}->${detail.to}`;
    if (!groups[key]) {
      groups[key] = {
        from: detail.from,
        to: detail.to,
        count: 0,
        tables: new Set<string>(),
        entities: new Set<string>()
      };
    }
    
    groups[key].count++;
    groups[key].tables.add(detail.table);
    groups[key].entities.add(`${detail.table}:${detail.entityId}`);
  });
  
  // Convert to array and sort by count (most frequent first)
  return Object.values(groups)
    .sort((a, b) => b.count - a.count)
    .map(group => ({
      from: group.from,
      to: group.to,
      count: group.count,
      tables: Array.from(group.tables),
      entities: group.entities.size
    }));
} 

/**
 * Fetches and processes the delta of changes for a live update notification.
 * Includes deduplication, ordering, and filtering.
 * Sends the processed changes using the provided handler.
 * 
 * @returns Object containing success status, number of changes sent, and the final LSN.
 */
export async function processLiveUpdateNotification(
  context: MinimalContext,
  clientId: string,
  clientLSN: string,
  serverLSN: string,
  messageHandler: WebSocketHandler
): Promise<{ success: boolean; changeCount: number; finalLSN: string; }> {
  syncLogger.info('Processing live update notification', {
    clientId,
    clientLSN,
    serverLSN
  }, MODULE_NAME);

  let finalLSN = clientLSN; // Start with client's known LSN
  let processedChangeCount = 0;
  let success = true;

  try {
    // 1. Fetch raw delta changes
    let rawDeltaChanges: TableChange[] = [];
    const deltaClient = getDBClient(context);
    try {
      await deltaClient.connect();
      const deltaResult = await deltaClient.query<TableChange>(`
        SELECT lsn, table_name as "table", operation, data, timestamp 
        FROM change_history 
        WHERE 
          lsn::pg_lsn > $1::pg_lsn AND
          lsn::pg_lsn <= $2::pg_lsn
        ORDER BY lsn::pg_lsn ASC
        LIMIT 1000 -- Reasonable limit for a live update delta
      `, [clientLSN, serverLSN]);
      
      rawDeltaChanges = deltaResult.rows.map((row: any) => ({
          table: row.table || 'unknown',
          operation: row.operation,
          data: row.data,
          lsn: row.lsn,
          updated_at: row.timestamp || new Date().toISOString()
      }));
    } finally {
      await deltaClient.end();
    }

    if (rawDeltaChanges.length === 0) {
      syncLogger.info('No new changes found for live update notification', { clientId });
      // Client is already up to date with the serverLSN provided in the notification
      finalLSN = serverLSN; 
    } else {
      // 2. Process raw changes (dedupe, order, filter)
      const processedChanges = processRawChangesBatch(rawDeltaChanges, clientId);
      processedChangeCount = processedChanges.length;
      syncLogger.info(`Fetched ${rawDeltaChanges.length} raw changes, processed to ${processedChangeCount} for live update`, { clientId });

      if (processedChangeCount > 0) {
        // 3. Determine final LSN for this batch
        finalLSN = processedChanges[processedChanges.length - 1].lsn || serverLSN;

        // 4. Send processed changes via sendLiveChanges
        // Assuming sendLiveChanges exists and is appropriate here
        syncLogger.debug(`Sending ${processedChangeCount} processed live changes`, { clientId, finalLSN });
        await sendLiveChanges(
          context, // Pass context if needed by sendLiveChanges
          clientId,
          processedChanges,
          messageHandler,
          finalLSN
        );
      } else {
        // If all changes were filtered/deduped, client is up to date with the last RAW change fetched
        finalLSN = rawDeltaChanges[rawDeltaChanges.length - 1].lsn || serverLSN;
      }
    }

  } catch (error) {
    syncLogger.error('Failed to process live update notification', {
      clientId,
      clientLSN,
      serverLSN,
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    success = false;
    finalLSN = clientLSN; // Revert to original LSN on error
  }

  return {
    success,
    changeCount: processedChangeCount,
    finalLSN
  };
} 
