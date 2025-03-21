import type { 
  TableChange,
  SrvMessageType,
  ServerChangesMessage,
  ServerStateChangeMessage,
  ServerLSNUpdateMessage
} from '@repo/sync-types';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import type { WebSocketHandler } from './types';
import { SERVER_TABLE_HIERARCHY } from '@repo/dataforge/server-entities';
import { getDBClient } from '../lib/db';
import type { WALChange, ChunkOptions, ChunkResult } from '../types/wal';

// Constants for chunking
const DEFAULT_CHUNK_SIZE = 100;

type TableName = keyof typeof SERVER_TABLE_HIERARCHY;

const MODULE_NAME = 'server-changes';

/**
 * Compare two LSNs
 * @returns -1 if lsn1 < lsn2, 0 if equal, 1 if lsn1 > lsn2
 */
export function compareLSN(lsn1: string, lsn2: string): number {
  const [major1, minor1] = lsn1.split('/').map(Number);
  const [major2, minor2] = lsn2.split('/').map(Number);
  
  if (major1 < major2) return -1;
  if (major1 > major2) return 1;
  if (minor1 < minor2) return -1;
  if (minor1 > minor2) return 1;
  return 0;
}

/**
 * Deduplicate changes by keeping only the latest change for each record
 * Uses last-write-wins based on updated_at timestamp
 */
export function deduplicateChanges(changes: TableChange[]): TableChange[] {
  const latestChanges = new Map<string, TableChange>();

  for (const change of changes) {
    // Skip if no id in the change data
    if (!change.data?.id) {
      continue;
    }

    const key = `${change.table}:${change.data.id}`;
    const existing = latestChanges.get(key);
    
    // Keep change if no existing one, or if this one is newer
    if (!existing || new Date(change.updated_at) >= new Date(existing.updated_at)) {
      latestChanges.set(key, change);
    }
  }

  // Convert back to array and sort by LSN for consistency
  return Array.from(latestChanges.values())
    .sort((a, b) => compareLSN(a.lsn!, b.lsn!));
}

/**
 * Send changes to client using the message handler with chunking support
 */
async function sendChanges(
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
 * Get a chunk of WAL changes with cursor-based pagination
 */
async function getWALChunk(
  context: MinimalContext,
  startLSN: string,
  options: ChunkOptions = {}
): Promise<ChunkResult<WALChange>> {
  const { chunkSize = DEFAULT_CHUNK_SIZE } = options;
  const client = getDBClient(context);

  try {
    // Query WAL changes from start LSN
    const query = `
      SELECT *
      FROM pg_logical_slot_peek_changes(
        'replication_slot',
        $1,
        $2,
        'include-xids', '1',
        'include-timestamp', '1'
      )
    `;

    const result = await client.query<WALChange>(query, [startLSN, chunkSize + 1]);

    // Check if there are more changes
    const hasMore = result.rows.length > chunkSize;
    const items = hasMore ? result.rows.slice(0, chunkSize) : result.rows;
    const nextCursor = items.length > 0 ? items[items.length - 1].lsn : null;

    syncLogger.debug('WAL chunk retrieved', {
      startLSN,
      count: items.length,
      hasMore,
      nextCursor
    }, MODULE_NAME);

    return {
      items,
      nextCursor,
      hasMore
    };
  } catch (err) {
    syncLogger.error('WAL chunk error', {
      startLSN,
      error: err instanceof Error ? err.message : String(err)
    }, MODULE_NAME);
    throw err;
  }
}

/**
 * Process WAL changes in chunks
 */
async function processWALInChunks(
  context: MinimalContext,
  startLSN: string,
  processor: (items: WALChange[]) => Promise<void>,
  options: ChunkOptions = {}
): Promise<void> {
  let currentLSN = startLSN;
  let totalProcessed = 0;

  while (true) {
    const chunk = await getWALChunk(context, currentLSN, options);
    await processor(chunk.items);
    totalProcessed += chunk.items.length;

    if (!chunk.hasMore) {
      break;
    }

    currentLSN = chunk.nextCursor!;
  }

  syncLogger.info('WAL chunks processed', {
    startLSN,
    endLSN: currentLSN,
    count: totalProcessed
  }, MODULE_NAME);
}

/**
 * Convert WAL changes to TableChange format
 */
function walToTableChanges(changes: WALChange[]): TableChange[] {
  return changes.map(change => ({
    table: change.table_name,
    operation: change.operation,
    data: change.new_data,
    lsn: change.lsn,
    updated_at: change.timestamp?.toISOString() || new Date().toISOString()
  }));
}

/**
 * Perform catchup sync for a client
 * This uses WAL changes from a specific LSN
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

  try {
    // Get current server LSN (just using local DB connection)
    const client = getDBClient(context);
    let serverLSN = startLSN;
    
    try {
      await client.connect();
      const serverLSNResult = await client.query('SELECT pg_current_wal_lsn() as lsn;');
      serverLSN = serverLSNResult.rows[0].lsn;
    } finally {
      await client.end();
    }
    
    // If client is behind, use the change_history table to get changes
    if (startLSN < serverLSN) {
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
          let lastLSN = startLSN;
          
          while (hasMoreChanges) {
            // Query changes from history table
            const result = await client.query(`
              SELECT lsn, table_name, operation, data 
              FROM change_history 
              WHERE lsn > $1 AND lsn <= $2
              ORDER BY lsn ASC
              LIMIT $3 OFFSET $4
            `, [startLSN, serverLSN, pageSize, offset]);
            
            // Convert to TableChange format
            const changes: TableChange[] = result.rows.map(row => ({
              table: row.table_name,
              operation: row.operation,
              data: row.data,
              lsn: row.lsn,
              updated_at: row.data?.updated_at || new Date().toISOString()
            }));
            
            // Update for next page
            offset += pageSize;
            hasMoreChanges = changes.length === pageSize;
            
            if (changes.length > 0) {
              allChanges = [...allChanges, ...changes];
              lastLSN = changes[changes.length - 1].lsn as string;
            } else {
              hasMoreChanges = false;
            }
          }
          
          // Process and send the changes if we have any
          if (allChanges.length > 0) {
            const orderedChanges = orderChangesByDomain(allChanges);
            await sendChanges(orderedChanges, lastLSN, clientId, messageHandler);
            
            syncLogger.info('Sent historical changes to client', {
              clientId,
              changeCount: orderedChanges.length,
              lastLSN
            }, MODULE_NAME);
            
            // Update the final LSN
            serverLSN = lastLSN;
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
    
    // Send LSN update message with the final server LSN
    const lsnUpdateMsg: ServerLSNUpdateMessage = {
      type: 'srv_lsn_update',
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId,
      lsn: serverLSN
    };
    await messageHandler.send(lsnUpdateMsg);
    
    syncLogger.info('Catchup sync completed', {
      clientId,
      startLSN,
      finalLSN: serverLSN
    }, MODULE_NAME);
  } catch (error) {
    syncLogger.error('Catchup sync failed', {
      clientId,
      startLSN,
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    
    // Still send an LSN update to avoid client being stuck
    const lsnUpdateMsg: ServerLSNUpdateMessage = {
      type: 'srv_lsn_update',
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId,
      lsn: startLSN
    };
    await messageHandler.send(lsnUpdateMsg);
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
 * Order changes based on table hierarchy and operation type
 * - Creates/Updates: Process parents before children
 * - Deletes: Process children before parents
 */
export function orderChangesByDomain(changes: TableChange[]): TableChange[] {
  const ordered = changes.sort((a, b) => {
    // Add quotes to match SERVER_TABLE_HIERARCHY keys
    const aLevel = SERVER_TABLE_HIERARCHY[`"${a.table}"` as TableName] ?? 0;
    const bLevel = SERVER_TABLE_HIERARCHY[`"${b.table}"` as TableName] ?? 0;

    // For deletes, reverse the hierarchy
    if (a.operation === 'delete' && b.operation === 'delete') {
      return bLevel - aLevel;
    }

    // For mixed operations, deletes come last
    if (a.operation === 'delete') return 1;
    if (b.operation === 'delete') return -1;

    // For creates/updates, follow hierarchy
    return aLevel - bLevel;
  });

  syncLogger.debug('Changes ordered', {
    tableCount: Object.keys(ordered.reduce((acc, change) => {
      acc[change.table] = true;
      return acc;
    }, {} as Record<string, boolean>)).length,
    operations: ordered.reduce((acc, change) => {
      acc[change.operation] = (acc[change.operation] || 0) + 1;
      return acc;
    }, {} as Record<string, number>)
  }, MODULE_NAME);

  return ordered;
} 