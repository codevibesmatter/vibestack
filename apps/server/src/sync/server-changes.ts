import type { 
  TableChange,
  SrvMessageType,
  ServerChangesMessage,
  ServerStateChangeMessage,
  ServerLSNUpdateMessage,
  ServerSyncCompletedMessage
} from '@repo/sync-types';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import type { WebSocketHandler } from './types';
import { SERVER_TABLE_HIERARCHY } from '@repo/dataforge/server-entities';
import { getDBClient } from '../lib/db';
import { compareLSN, deduplicateChanges, orderChangesByDomain as baseOrderChangesByDomain } from '../lib/sync-common';

// Constants for chunking
const DEFAULT_CHUNK_SIZE = 100;

type TableName = keyof typeof SERVER_TABLE_HIERARCHY;

const MODULE_NAME = 'server-changes';

/**
 * Send changes to client using the message handler with chunking support
 */
export async function sendChanges(
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
      type: 'srv_send_changes',
      messageId: `srv_${Date.now()}_${i}`,
      timestamp: Date.now(),
      clientId,
      changes: chunkChanges,
      lastLSN: i === chunks - 1 ? lastLSN : chunkChanges[chunkChanges.length - 1].lsn!,
      sequence: { chunk: i + 1, total: chunks }
    };

    try {
      await messageHandler.send(message);
      success.push(true);
      
      syncLogger.info('Sent changes chunk', {
        clientId,
        chunk: i + 1,
        total: chunks,
        count: chunkChanges.length,
        lastLSN: message.lastLSN,
        tables: [...new Set(chunkChanges.map(c => c.table))].length
      }, MODULE_NAME);
    } catch (err) {
      success.push(false);
      syncLogger.error('Chunk send failed', {
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
 * Get current server LSN from the Replication DO
 */
async function getCurrentServerLSN(context: MinimalContext): Promise<string> {
  try {
    // Use the environment to get the Replication DO
    const env = context.env;
    const id = env.REPLICATION.idFromName('system');
    const replicationDO = env.REPLICATION.get(id);
    
    // Call the LSN endpoint on the Replication DO using the standard API path
    const response = await replicationDO.fetch('http://internal/api/replication/lsn');
    
    if (!response.ok) {
      throw new Error(`Failed to fetch LSN: ${response.status}`);
    }
    
    const data = await response.json() as { lsn: string };
    return data.lsn || '0/0';
  } catch (error) {
    syncLogger.error('Error fetching current LSN', {
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    
    // Fallback to a default value
    return '0/0';
  }
}

/**
 * Perform catchup sync for a client
 * This uses changes from the change_history table
 */
export async function performCatchupSync(
  context: MinimalContext,
  clientId: string,
  startLSN: string,
  messageHandler: WebSocketHandler
): Promise<void> {
  syncLogger.info('Catchup sync started', {
    clientId,
    startLSN
  }, MODULE_NAME);

  let changeCount = 0; // Track total changes sent for reporting
  
  try {
    // Get current server LSN from the Replication DO
    const serverLSN = await getCurrentServerLSN(context);
    let finalLSN = startLSN; // This will track the final LSN after changes
    
    // If client is behind, use the change_history table to get changes
    if (compareLSN(startLSN, serverLSN) < 0) {
      syncLogger.info('Client is behind server, retrieving changes from history', {
        clientLSN: startLSN,
        serverLSN
      }, MODULE_NAME);
      
      try {
        const client = getDBClient(context);
        await client.connect();
        
        try {
          // Paginate through the changes to avoid memory issues
          const pageSize = 500;
          let offset = 0;
          let hasMoreChanges = true;
          let allChanges: TableChange[] = [];
          
          while (hasMoreChanges) {
            // Query changes from history table using proper LSN comparison
            // Be careful with casting - pg_lsn() expects text input
            const result = await client.query(`
              SELECT lsn, table_name, operation, data 
              FROM change_history 
              WHERE lsn::pg_lsn > $1::pg_lsn AND lsn::pg_lsn <= $2::pg_lsn
              ORDER BY lsn::pg_lsn ASC
              LIMIT $3 OFFSET $4
            `, [startLSN, serverLSN, pageSize, offset]);
            
            // Log query performance
            syncLogger.debug('Retrieved changes from history', {
              startLSN,
              serverLSN,
              limit: pageSize,
              offset,
              resultCount: result.rows.length
            }, MODULE_NAME);
            
            // Convert to TableChange format
            const changes: TableChange[] = result.rows.map(row => ({
              table: row.table_name,
              operation: row.operation,
              data: row.data,
              lsn: row.lsn,
              updated_at: row.data?.updated_at || new Date().toISOString()
            }));
            
            // Add to our collection
            allChanges = allChanges.concat(changes);
            
            // Update paging logic
            hasMoreChanges = changes.length === pageSize;
            offset += pageSize;
            
            // Update the last seen LSN if we have rows
            if (changes.length > 0) {
              const lastChangeLSN = changes[changes.length - 1].lsn || startLSN;
              finalLSN = compareLSN(lastChangeLSN, finalLSN) > 0 ? lastChangeLSN : finalLSN;
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
            await sendChanges(orderedChanges, finalLSN, clientId, messageHandler);
            
            // Update the change count for final reporting
            changeCount = orderedChanges.length;
            
            syncLogger.info('Sent historical changes to client', {
              clientId,
              changeCount,
              finalLSN
            }, MODULE_NAME);
          } else {
            syncLogger.info('No historical changes found', {
              clientId,
              startLSN,
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
    } else {
      // Client is already up to date
      syncLogger.info('Client LSN is current with server', {
        clientLSN: startLSN,
        serverLSN
      }, MODULE_NAME);
    }
    
    // Send a sync completed message with all relevant information
    const syncCompletedMsg: ServerSyncCompletedMessage = {
      type: 'srv_sync_completed',
      messageId: `srv_${Date.now()}_completion`,
      timestamp: Date.now(),
      clientId,
      startLSN,
      finalLSN,
      changeCount,
      success: true
    };
    
    await messageHandler.send(syncCompletedMsg);
    
    syncLogger.info('Catchup sync completed', {
      clientId,
      startLSN,
      finalLSN,
      changeCount
    }, MODULE_NAME);
  } catch (error) {
    syncLogger.error('Catchup sync failed', {
      clientId,
      startLSN,
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    
    // Send a sync completed message with error information
    const syncCompletedMsg: ServerSyncCompletedMessage = {
      type: 'srv_sync_completed',
      messageId: `srv_${Date.now()}_completion`,
      timestamp: Date.now(),
      clientId,
      startLSN,
      finalLSN: startLSN,
      changeCount: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
    
    await messageHandler.send(syncCompletedMsg);
    
    syncLogger.error('Catchup sync failed, completion message sent', {
      clientId,
      startLSN,
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
  }
}

/**
 * Handle new changes from replication
 */
export async function handleNewChanges(
  changes: TableChange[],
  lastLSN: string,
  clientId: string,
  messageHandler: WebSocketHandler
): Promise<boolean> {
  try {
    // Send changes to client
    const success = await sendChanges(changes, lastLSN, clientId, messageHandler);
    
    if (success) {
      syncLogger.info('Changes sent successfully', {
        clientId,
        count: changes.length,
        lastLSN
      }, MODULE_NAME);
    } else {
      syncLogger.error('Changes send failed', {
        clientId,
        count: changes.length,
        lastLSN
      }, MODULE_NAME);
    }
    
    return success;
  } catch (err) {
    syncLogger.error('Changes handling error', {
      clientId,
      error: err instanceof Error ? err.message : String(err)
    }, MODULE_NAME);
    return false;
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
 * Process live changes for a client
 * This handles real-time notifications for clients with active connections
 * @param context The context object
 * @param clientId The client ID
 * @param changes The changes to process
 * @param messageHandler The WebSocket handler
 * @param providedLSN Optional LSN that overrides the LSN from changes
 * @returns An object with success status and the LSN used
 */
export async function performLiveSync(
  context: MinimalContext,
  clientId: string,
  changes: TableChange[],
  messageHandler: WebSocketHandler,
  providedLSN?: string
): Promise<{ success: boolean; lsn: string }> {
  const MODULE_TAG = `${MODULE_NAME}:live-sync`;
  
  // Start tracking time for performance monitoring
  const startTime = Date.now();
  
  try {
    syncLogger.info('Live sync started', { 
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
    
    // Order by domain tables hierarchy to ensure consistency
    orderedChanges = baseOrderChangesByDomain(orderedChanges);
    
    // Use provided LSN if available, otherwise extract from changes
    let currentLSN: string;
    
    if (providedLSN) {
      currentLSN = providedLSN;
      syncLogger.debug('Using provided LSN', { 
        clientId, 
        lsn: currentLSN 
      }, MODULE_TAG);
    } else {
      // Extract the LSN from the last change in the ordered list
      // Ensure it's a string by providing a default if undefined
      currentLSN = orderedChanges.length > 0 && orderedChanges[orderedChanges.length - 1].lsn
        ? String(orderedChanges[orderedChanges.length - 1].lsn)
        : '0/0';
      
      syncLogger.debug('Using LSN from changes', { 
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
    
    // Use the sendChanges function to handle the actual sending
    const sendSuccess = await sendChanges(
      orderedChanges,
      currentLSN,
      clientId,
      messageHandler
    );
    
    if (!sendSuccess) {
      syncLogger.error('Failed to send live changes', { 
        clientId,
        count: orderedChanges.length
      }, MODULE_TAG);
      return { success: false, lsn: '0/0' };
    }
    
    // Send a sync completed message to notify the client of completed live sync
    const completedMessage: ServerSyncCompletedMessage = {
      type: 'srv_sync_completed',
      messageId: `srv_${Date.now()}_completion`,
      timestamp: Date.now(),
      clientId,
      startLSN: '0/0', // For live sync, we don't have a meaningful start LSN
      finalLSN: currentLSN,
      changeCount: orderedChanges.length,
      success: true
    };
    
    try {
      await messageHandler.send(completedMessage);
      syncLogger.info('Live sync completed', {
        clientId,
        lsn: currentLSN,
        changeCount: orderedChanges.length,
        duration: Date.now() - startTime
      }, MODULE_TAG);
    } catch (error) {
      syncLogger.error('Error sending sync completed message', {
        clientId,
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_TAG);
      // We still consider this a success since the changes were delivered
    }
    
    return { success: true, lsn: currentLSN };
  } catch (error) {
    syncLogger.error('Live sync failed', {
      clientId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }, MODULE_TAG);
    return { success: false, lsn: '0/0' };
  }
} 