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
 * Send catchup changes to client using the message handler with chunking support and flow control
 */
export async function sendCatchupChanges(
  changes: TableChange[],
  lastLSN: string,
  clientId: string,
  messageHandler: WebSocketHandler
): Promise<boolean> {
  if (!changes.length) {
    return false;
  }

  // Calculate chunks
  const chunks = Math.ceil(changes.length / DEFAULT_CHUNK_SIZE);
  const success: boolean[] = [];

  for (let i = 0; i < chunks; i++) {
    const start = i * DEFAULT_CHUNK_SIZE;
    const end = Math.min(start + DEFAULT_CHUNK_SIZE, changes.length);
    const chunkChanges = changes.slice(start, end);

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
      
      syncLogger.info('Sent catchup changes chunk', {
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
  return success.every(s => s);
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
 * This uses changes from the change_history table
 */
export async function performCatchupSync(
  context: MinimalContext,
  clientId: string,
  clientLSN: string,
  serverLSN: string, // Add serverLSN parameter to avoid redundant LSN fetching
  messageHandler: WebSocketHandler,
  stateManager: SyncStateManager
): Promise<void> {
  syncLogger.info('Catchup sync started', {
    clientId,
    clientLSN,
    serverLSN
  }, MODULE_NAME);

  try {
    // Use the shared fetchAndProcessChanges function with isLiveSync=false
    const result = await fetchAndProcessChanges(
      context,
      clientId,
      clientLSN,
      serverLSN,
      messageHandler,
      false // This is catchup sync, not live sync
    );
    
    // Complete the sync
    const syncCompletedMsg = createCatchupSyncCompletion(
      clientId,
      clientLSN,
      result.finalLSN,
      result.changeCount
    );
    
    await messageHandler.send(syncCompletedMsg);
    
    // Always update the client LSN to the final LSN (which may be serverLSN if no changes)
    // This ensures LSN advancement even when no changes are found
    await stateManager.updateClientLSN(clientId, result.finalLSN);
    syncLogger.info('Updated client LSN after catchup completion', {
      clientId,
      finalLSN: result.finalLSN,
      previousLSN: clientLSN,
      changeCount: result.changeCount
    }, MODULE_NAME);
    
    syncLogger.info('Catchup sync completed', {
      clientId,
      clientLSN,
      finalLSN: result.finalLSN,
      changeCount: result.changeCount,
      success: result.success
    }, MODULE_NAME);
  } catch (error) {
    syncLogger.error('Catchup sync failed', {
      clientId,
      clientLSN,
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    
    // Send a sync completed message with error information
    const syncCompletedMsg = createCatchupSyncError(
      clientId,
      clientLSN,
      error instanceof Error ? error : String(error)
    );
    
    await messageHandler.send(syncCompletedMsg);
    
    syncLogger.error('Catchup sync failed, completion message sent', {
      clientId,
      clientLSN,
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
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
    syncLogger.info('Sending live changes', { 
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
    syncLogger.info('Sending live changes', {
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
        await messageHandler.send(message);
        chunkSuccess.push(true);
        
        syncLogger.info('Sent live changes chunk', {
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

/**
 * Fetch changes from the database, process them, and send them to the client
 * This is a unified function for both live updates and catchup sync
 */
export async function fetchAndProcessChanges(
  context: MinimalContext,
  clientId: string,
  clientLSN: string,
  serverLSN: string,
  messageHandler: WebSocketHandler,
  isLiveSync: boolean = true
): Promise<{
  success: boolean;
  changeCount: number;
  finalLSN: string;
}> {
  const startTime = Date.now();
  let allChanges: TableChange[] = [];
  let historyLatestLSN = serverLSN; // Default to serverLSN but will be updated
  
  try {
    syncLogger.info(`Fetching changes for ${isLiveSync ? 'live' : 'catchup'} sync`, {
      clientId,
      clientLSN,
      serverLSN: serverLSN,
      note: 'Will use latest change_history LSN as upper bound'
    }, MODULE_NAME);
    
    // Query changes from database
    const client = getDBClient(context);
    await client.connect();
    
    try {
      // First, get the actual latest LSN from change_history table
      // This is critical to prevent LSN gaps when serverLSN is ahead of change_history
      const latestLsnResult = await client.query(`
        SELECT MAX(lsn) as latest_lsn FROM change_history
      `);
      
      if (latestLsnResult.rows.length > 0 && latestLsnResult.rows[0].latest_lsn) {
        historyLatestLSN = latestLsnResult.rows[0].latest_lsn;
        
        // Log if server LSN and history LSN differ significantly
        if (compareLSN(serverLSN, historyLatestLSN) > 0) {
          syncLogger.debug('Server LSN ahead of change_history', {
            clientId,
            serverLSN,
            historyLatestLSN,
            diff: `${serverLSN} vs ${historyLatestLSN}`
          }, MODULE_NAME);
        }
      }
      
      // Set a timeout for the query to avoid WebSocket connection timeout
      await client.query('SET statement_timeout = 20000'); // 20 seconds timeout
      
      const queryStart = Date.now();
      // Use historyLatestLSN as the upper bound instead of serverLSN
      const result = await client.query(`
        SELECT lsn, table_name, operation, data, timestamp 
        FROM change_history 
        WHERE 
          lsn::pg_lsn > $1::pg_lsn AND
          lsn::pg_lsn <= $2::pg_lsn AND
          (data->>'client_id' IS NULL OR data->>'client_id' != $3)
        ORDER BY lsn::pg_lsn ASC
        LIMIT 500
      `, [clientLSN, historyLatestLSN, clientId]);
      const queryDuration = Date.now() - queryStart;
      
      // Convert to TableChange format
      allChanges = result.rows.map(row => ({
        table: row.table_name,
        operation: row.operation,
        data: row.data,
        lsn: row.lsn,
        updated_at: row.timestamp || new Date().toISOString()
      }));
      
      syncLogger.debug('Retrieved changes from history', {
        clientId,
        clientLSN,
        historyLatestLSN,
        count: allChanges.length,
        queryDuration
      }, MODULE_NAME);
    } finally {
      await client.end();
    }
    
    // If no changes, return early with historyLatestLSN
    if (allChanges.length === 0) {
      syncLogger.info('No changes found for sync, advancing client LSN to latest history LSN', {
        clientId,
        clientLSN,
        historyLatestLSN
      }, MODULE_NAME);
      
      return {
        success: true,
        changeCount: 0,
        finalLSN: historyLatestLSN  // ADVANCE to history latest LSN when no changes to prevent gaps
      };
    }
    
    // Process changes (deduplicate and order)
    const deduplicationResult = deduplicateChanges(allChanges);
    const processedChanges = deduplicationResult.changes;
    const skippedChanges = deduplicationResult.skipped;
    
    // Track metrics for stats message
    const originalCount = allChanges.length;
    const processedCount = processedChanges.length;
    const deduplicationReduction = originalCount - processedCount;
    
    // Log deduplication results with detailed breakdown
    if (deduplicationReduction > 0) {
      syncLogger.info('Changes reduced during deduplication', {
        clientId,
        before: originalCount,
        after: processedCount,
        reduced: deduplicationReduction,
        percentage: ((deduplicationReduction / originalCount) * 100).toFixed(1) + '%',
        breakdown: {
          missingId: skippedChanges.missingId.length,
          outdated: skippedChanges.outdated.length
        },
        // Include details of skipped changes with missing IDs for debugging
        skippedWithoutIds: skippedChanges.missingId.map(c => ({
          table: c.table,
          operation: c.operation,
          lsn: c.lsn,
          data: c.data
        }))
      }, MODULE_NAME);
      
      // Log each missing ID change individually for deeper analysis
      skippedChanges.missingId.forEach(change => {
        syncLogger.warn('Skipped change missing ID', {
          clientId,
          table: change.table,
          operation: change.operation,
          lsn: change.lsn,
          dataKeys: Object.keys(change.data || {}).join(',')
        }, MODULE_NAME);
      });
      
      // Log outdated changes with details about the newer change that replaced them
      skippedChanges.outdated.forEach(outdated => {
        // Find the newer change that replaced this one
        const newerChange = processedChanges.find(p => 
          p.table === outdated.table && 
          p.data?.id === outdated.data?.id
        );
        
        if (newerChange) {
          syncLogger.info('Skipped outdated change', {
            clientId,
            table: outdated.table,
            operation: outdated.operation,
            id: outdated.data?.id,
            lsn: outdated.lsn,
            timestamp: outdated.updated_at,
            replacedBy: {
              operation: newerChange.operation,
              lsn: newerChange.lsn,
              timestamp: newerChange.updated_at
            },
            timeDiff: new Date(newerChange.updated_at).getTime() - new Date(outdated.updated_at).getTime() + 'ms'
          }, MODULE_NAME);
        } else {
          syncLogger.warn('Skipped outdated change but replacement not found', {
            clientId,
            table: outdated.table,
            operation: outdated.operation,
            id: outdated.data?.id,
            lsn: outdated.lsn
          }, MODULE_NAME);
        }
      });
    }
    
    // Filter out changes that originated from this client
    const beforeClientFilter = processedChanges.length;
    const filteredChanges = processedChanges.filter(change => {
      // Track changes that would be filtered out (for debugging)
      const fromThisClient = change.data?.client_id === clientId;
      if (fromThisClient) {
        syncLogger.debug('Filtering client\'s own change', {
          clientId,
          table: change.table,
          operation: change.operation,
          id: change.data?.id,
          changeClientId: change.data?.client_id
        }, MODULE_NAME);
      }
      // Return true to keep, false to filter out
      return !change.data?.client_id || change.data.client_id !== clientId;
    });
    
    // Log client filtering results
    const clientFilterReduction = beforeClientFilter - filteredChanges.length;
    if (clientFilterReduction > 0) {
      // Log detailed info about each filtered change
      const filteredOutChanges = processedChanges.filter(change => 
        change.data?.client_id === clientId
      );
      
      syncLogger.info('Changes filtered out (client\'s own changes)', {
        clientId,
        before: beforeClientFilter,
        after: filteredChanges.length,
        filtered: clientFilterReduction,
        percentage: ((clientFilterReduction / beforeClientFilter) * 100).toFixed(1) + '%',
        details: filteredOutChanges.map(c => ({
          table: c.table,
          operation: c.operation,
          id: c.data?.id,
          client_id: c.data?.client_id,
          lsn: c.lsn
        }))
      }, MODULE_NAME);
    }
    
    // Check for changes that might be missing but not explicitly filtered
    // Compare original query results with final filtered changes
    if (allChanges.length > filteredChanges.length) {
      // Create a set of keys for filtered changes for quick lookup
      const filteredChangeKeys = new Set(
        filteredChanges.map(c => `${c.table}:${c.operation}:${c.data?.id}`)
      );
      
      // Find changes that didn't make it through the pipeline
      const missingChanges = allChanges.filter(c => {
        const key = `${c.table}:${c.operation}:${c.data?.id}`;
        return !filteredChangeKeys.has(key);
      });
      
      // Group by reason
      const missingByReason = {
        deduplication: [] as any[],
        clientFiltered: [] as any[],
        unknown: [] as any[]
      };
      
      // Classify each missing change
      missingChanges.forEach(c => {
        const isClientFiltered = c.data?.client_id === clientId;
        
        if (isClientFiltered) {
          missingByReason.clientFiltered.push({
            table: c.table,
            operation: c.operation,
            id: c.data?.id,
            client_id: c.data?.client_id,
            lsn: c.lsn
          });
        } else {
          // Check if it's in the skipped changes (outdated)
          const isOutdated = skippedChanges?.outdated?.some(skipped => 
            skipped.table === c.table && 
            skipped.operation === c.operation && 
            skipped.data?.id === c.data?.id &&
            skipped.lsn === c.lsn
          );
          
          if (isOutdated) {
            missingByReason.deduplication.push({
              table: c.table,
              operation: c.operation,
              id: c.data?.id,
              lsn: c.lsn,
              reason: 'outdated'
            });
          } else {
            // Check if it was removed during deduplication (duplicate key)
            const isDuplicate = allChanges.filter(other => 
              other !== c && 
              other.table === c.table && 
              other.operation === c.operation && 
              other.data?.id === c.data?.id
            ).length > 0;
            
            if (isDuplicate) {
              missingByReason.deduplication.push({
                table: c.table,
                operation: c.operation,
                id: c.data?.id,
                lsn: c.lsn,
                reason: 'duplicate key'
              });
            } else {
              missingByReason.unknown.push({
                table: c.table,
                operation: c.operation,
                id: c.data?.id,
                lsn: c.lsn
              });
            }
          }
        }
      });
      
      // Log detailed breakdown of missing changes
      syncLogger.info('Missing changes breakdown', {
        clientId,
        totalMissing: missingChanges.length,
        byReason: {
          deduplication: missingByReason.deduplication.length,
          clientFiltered: missingByReason.clientFiltered.length,
          unknown: missingByReason.unknown.length
        },
        details: {
          deduplication: missingByReason.deduplication,
          clientFiltered: missingByReason.clientFiltered,
          unknown: missingByReason.unknown
        }
      }, MODULE_NAME);
    }
    
    // Track operation counts for logging
    const operationCounts = filteredChanges.reduce((acc, change) => {
      acc[change.operation] = (acc[change.operation] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const tableStats = filteredChanges.reduce((acc, change) => {
      acc[change.table] = (acc[change.table] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    // Get the LSN of the last change that will be sent
    // This is critical for ensuring correct continuation in live sync
    let lastChangeLSN = '';
    if (filteredChanges.length > 0) {
      // Find the highest LSN in the processed changes
      lastChangeLSN = filteredChanges.reduce((highest, change) => {
        // Skip changes with no LSN
        if (!change.lsn) return highest;
        // Compare LSNs and return the higher one
        return !highest || compareLSN(change.lsn, highest) > 0 ? change.lsn : highest;
      }, '');
      
      syncLogger.debug('Highest LSN in processed changes', {
        clientId,
        lsn: lastChangeLSN,
        changeCount: filteredChanges.length
      }, MODULE_NAME);
    }
    
    // Send changes to client using the appropriate method
    let sendResult: { success: boolean; lsn: string };
    
    if (isLiveSync) {
      // For live updates, use sendLiveChanges
      sendResult = await sendLiveChanges(
        context,
        clientId,
        filteredChanges,
        messageHandler,
        lastChangeLSN || historyLatestLSN  // Prefer last change LSN if available
      );
    } else {
      // For catchup sync, use sendCatchupChanges with client acknowledgment
      const success = await sendCatchupChanges(
        filteredChanges,
        lastChangeLSN || historyLatestLSN,  // Prefer last change LSN if available
        clientId,
        messageHandler
      );
      
      sendResult = {
        success,
        lsn: success ? (lastChangeLSN || clientLSN) : clientLSN
      };
    }
    
    // Extract final LSN from the result
    // If sending failed, keep client's current LSN
    // Otherwise use the last change LSN (not server LSN)
    const finalLSN = sendResult.success ? sendResult.lsn : clientLSN;
    
    // Create and send stats message
    const statsMessage: ServerSyncStatsMessage = {
      type: 'srv_sync_stats',
      messageId: `stats_${Date.now()}`,
      timestamp: Date.now(),
      clientId,
      syncType: isLiveSync ? 'live' : 'catchup',
      originalCount,
      processedCount,
      deduplicationStats: {
        beforeCount: originalCount,
        afterCount: processedCount,
        reduction: deduplicationReduction,
        reductionPercent: originalCount > 0 ?
          Math.round(((deduplicationReduction) / originalCount) * 100) : 0,
        reasons: {}
      },
      filteringStats: {
        beforeCount: originalCount,
        afterCount: processedCount,
        filtered: clientFilterReduction,
        reasons: {}
      },
      contentStats: {
        operations: operationCounts,
        tables: tableStats,
        clients: {}
      },
      performanceStats: {
        processingTimeMs: Date.now() - startTime
      }
    };
    
    if (allChanges.length > 0 && finalLSN) {
      statsMessage.lsnRange = {
        first: allChanges[0].lsn || clientLSN,
        last: finalLSN
      };
    }
    
    // Send stats message
    try {
      await messageHandler.send(statsMessage);
    } catch (statsError) {
      syncLogger.error('Failed to send stats', {
        clientId,
        error: statsError instanceof Error ? statsError.message : String(statsError)
      }, MODULE_NAME);
      // Continue even if stats sending fails
    }
    
    syncLogger.info(`${isLiveSync ? 'Live' : 'Catchup'} sync completed`, {
      clientId,
      changeCount: filteredChanges.length,
      success: sendResult.success,
      clientLSN,
      finalLSN,
      duration: Date.now() - startTime
    }, MODULE_NAME);
    
    return {
      success: sendResult.success,
      changeCount: filteredChanges.length,
      finalLSN
    };
  } catch (error) {
    syncLogger.error(`${isLiveSync ? 'Live' : 'Catchup'} sync failed`, {
      clientId,
      clientLSN,
      historyLatestLSN,  // Changed from serverLSN
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }, MODULE_NAME);
    
    return {
      success: false,
      changeCount: 0,
      finalLSN: clientLSN
    };
  }
} 