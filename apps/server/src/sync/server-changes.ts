import type { 
  TableChange,
  ServerMessage,
  ServerChangesMessage,
  ServerStateChangeMessage,
  ServerLSNUpdateMessage,
  ServerSyncCompletedMessage,
  ServerCatchupCompletedMessage
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

  let changeCount = 0; // Track total changes sent for reporting
  let finalLSN = clientLSN; // This will track the final LSN after changes
  
  try {
    // SyncDO has already determined that client needs catchup sync
    // We can immediately start fetching changes
    syncLogger.info('Retrieving changes from history', {
      clientLSN,
      serverLSN
    }, MODULE_NAME);
    
    try {
      const client = getDBClient(context);
      await client.connect();
      
      try {
        // Set a timeout for the query to avoid WebSocket connection timeout
        // - 20 second query timeout is shorter than typical WebSocket timeout of 30s
        // - This prevents the database from holding a transaction open too long
        await client.query('SET statement_timeout = 20000'); // 20 seconds timeout
        
        // Paginate through the changes to avoid memory issues
        const pageSize = 500;
        let lastSeenLSN = clientLSN; // Start from client LSN
        let hasMoreChanges = true;
        let allChanges: TableChange[] = [];
        
        // Track query start time
        const queryStartTime = Date.now();
        
        while (hasMoreChanges) {
          // Check elapsed time and break if getting close to WebSocket timeout
          // - 25 second timeout is a safety margin before WebSocket typically closes at 30s
          // - This allows time to process any changes already retrieved before connection closes
          if (Date.now() - queryStartTime > 25000) { // 25 seconds
            syncLogger.warn('Query taking too long, stopping pagination to avoid WebSocket timeout', {
              clientId,
              timeElapsed: Date.now() - queryStartTime,
              changesRetrieved: allChanges.length
            }, MODULE_NAME);
            break;
          }
          
          // Query changes from history table using proper LSN comparison
          // Using keyset pagination for better performance than OFFSET on large datasets
          const queryStart = Date.now();
          const result = await client.query(`
            SELECT lsn, table_name, operation, data, timestamp 
            FROM change_history 
            WHERE 
              lsn::pg_lsn > $1::pg_lsn AND 
              lsn::pg_lsn <= $2::pg_lsn
            ORDER BY lsn::pg_lsn ASC
            LIMIT $3
          `, [lastSeenLSN, serverLSN, pageSize]);
          const queryDuration = Date.now() - queryStart;
          
          // Log query performance
          syncLogger.debug('Retrieved changes from history', {
            lastSeenLSN,
            serverLSN,
            limit: pageSize,
            resultCount: result.rows.length,
            queryDuration
          }, MODULE_NAME);
          
          // Convert to TableChange format
          const changes: TableChange[] = result.rows.map(row => ({
            table: row.table_name,
            operation: row.operation,
            data: row.data,
            lsn: row.lsn,
            updated_at: row.timestamp || new Date().toISOString()
          }));
          
          // Add to our collection
          allChanges = allChanges.concat(changes);
          
          // Update paging logic - if we got fewer rows than pageSize, we're done
          hasMoreChanges = changes.length === pageSize;
          
          // Update the last seen LSN if we have rows - use for next page query
          if (changes.length > 0) {
            lastSeenLSN = changes[changes.length - 1].lsn || lastSeenLSN;
            finalLSN = compareLSN(lastSeenLSN, finalLSN) > 0 ? lastSeenLSN : finalLSN;
          }
        }
        
        // If we found changes, process and send them
        if (allChanges.length > 0) {
          // Sort by LSN (this should already be sorted, but just to be sure)
          allChanges.sort((a, b) => {
            return compareLSN(a.lsn || '0/0', b.lsn || '0/0');
          });
          
          // Deduplicate changes to avoid processing duplicates
          const deduplicatedChanges = deduplicateChanges(allChanges);
          
          // Log deduplication results
          syncLogger.info('Deduplicated historical changes', {
            clientId,
            originalCount: allChanges.length,
            deduplicatedCount: deduplicatedChanges.length,
            reduction: allChanges.length - deduplicatedChanges.length
          }, MODULE_NAME);
          
          // Order changes based on domain hierarchy
          const orderedChanges = baseOrderChangesByDomain(deduplicatedChanges);
          
          // Send changes with flow control - wait for acknowledgment after each chunk
          await sendCatchupChanges(
            orderedChanges, 
            finalLSN, 
            clientId, 
            messageHandler
          );
          
          // Update the change count for final reporting
          changeCount = orderedChanges.length;
          
          // Log at debug level instead of info to reduce noise
          syncLogger.debug('Sent historical changes to client', {
            clientId,
            changeCount,
            finalLSN
          }, MODULE_NAME);
        } else {
          syncLogger.debug('No historical changes found', {
            clientId,
            clientLSN,
            serverLSN
          }, MODULE_NAME);
        }
      } finally {
        await client.end();
      }
    } catch (historyError) {
      // Log the error but continue with sync process
      syncLogger.error('Failed to retrieve historical changes', {
        clientId,
        error: historyError instanceof Error ? historyError.message : String(historyError)
      }, MODULE_NAME);
    }
    
    // No need to check for new changes during sync - that will be handled by the
    // live sync process after catchup completes
    
    // Complete the sync
    const syncCompletedMsg = createCatchupSyncCompletion(
      clientId,
      clientLSN,
      finalLSN,
      changeCount
    );
    
    await messageHandler.send(syncCompletedMsg);
    
    syncLogger.info('Catchup sync completed', {
      clientId,
      clientLSN,
      finalLSN,
      changeCount
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
    if (changes.length > 1) {
      orderedChanges = deduplicateChanges(changes);
      syncLogger.debug('Deduplicated changes', {
        before: changes.length,
        after: orderedChanges.length
      }, MODULE_TAG);
    }
    
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

    for (let i = 0; i < chunks; i++) {
      const start = i * DEFAULT_CHUNK_SIZE;
      const end = Math.min(start + DEFAULT_CHUNK_SIZE, orderedChanges.length);
      const chunkChanges = orderedChanges.slice(start, end);

      const message: ServerChangesMessage = {
        type: 'srv_live_changes',
        messageId: `srv_${Date.now()}_${i}`,
        timestamp: Date.now(),
        clientId,
        changes: chunkChanges,
        lastLSN: i === chunks - 1 ? currentLSN : chunkChanges[chunkChanges.length - 1].lsn!,
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
      lsn: currentLSN,
      changeCount: orderedChanges.length,
      duration: Date.now() - startTime
    }, MODULE_TAG);
    
    return { success: true, lsn: currentLSN };
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