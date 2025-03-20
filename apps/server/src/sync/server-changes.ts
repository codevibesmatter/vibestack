import type { 
  TableChange,
  SrvMessageType,
  ServerChangesMessage,
  ServerStateChangeMessage
} from '@repo/sync-types';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import type { WebSocketMessageHandler } from './websocket-handler';
import { SERVER_TABLE_HIERARCHY } from '@repo/dataforge/server-entities';
import { getDBClient } from '../lib/db';
import type { WALChange, ChunkOptions, ChunkResult } from '../types/wal';

// Constants for chunking
const DEFAULT_CHUNK_SIZE = 100;

type TableName = keyof typeof SERVER_TABLE_HIERARCHY;

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
  messageHandler: WebSocketMessageHandler
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
      
      syncLogger.info('Sent changes chunk to client', {
        clientId,
        chunk: i + 1,
        total: chunks,
        changeCount: chunkChanges.length,
        lastLSN: message.lastLSN,
        tables: [...new Set(chunkChanges.map(c => c.table))].join(',')
      });
    } catch (err) {
      success.push(false);
      syncLogger.error('Failed to send changes chunk', {
        clientId,
        chunk: i + 1,
        total: chunks,
        error: err instanceof Error ? err.message : String(err)
      });
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

    syncLogger.debug('Retrieved WAL chunk', {
      startLSN,
      chunkSize,
      changeCount: items.length,
      hasMore,
      nextCursor
    });

    return {
      items,
      nextCursor,
      hasMore
    };
  } catch (err) {
    syncLogger.error('Failed to get WAL chunk', {
      startLSN,
      chunkSize,
      error: err instanceof Error ? err.message : String(err)
    });
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

  syncLogger.info('Finished processing WAL in chunks', {
    startLSN,
    endLSN: currentLSN,
    totalProcessed
  });
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
  messageHandler: WebSocketMessageHandler
): Promise<void> {
  syncLogger.info('Starting catchup sync', {
    clientId,
    startLSN
  });

  await processWALInChunks(
    context,
    startLSN,
    async (items) => {
      const changes = walToTableChanges(items);
      const orderedChanges = orderChangesByDomain(changes);
      await sendChanges(orderedChanges, items[items.length - 1].lsn, clientId, messageHandler);
    }
  );

  // Send state change message
  const stateChangeMsg: ServerStateChangeMessage = {
    type: 'srv_state_change',
    messageId: `srv_${Date.now()}`,
    timestamp: Date.now(),
    clientId,
    state: 'live',
    lsn: startLSN
  };
  await messageHandler.send(stateChangeMsg);

  syncLogger.info('Completed catchup sync', {
    clientId,
    startLSN
  });
}

/**
 * Handle new changes from replication
 */
export async function handleNewChanges(
  changes: TableChange[],
  lastLSN: string,
  clientId: string,
  messageHandler: WebSocketMessageHandler
): Promise<boolean> {
  try {
    // Send changes to client
    const success = await sendChanges(changes, lastLSN, clientId, messageHandler);
    
    if (success) {
      syncLogger.info('Successfully sent changes to client', {
        clientId,
        changeCount: changes.length,
        lastLSN
      });
    } else {
      syncLogger.error('Failed to send some changes to client', {
        clientId,
        changeCount: changes.length,
        lastLSN
      });
    }
    
    return success;
  } catch (err) {
    syncLogger.error('Error handling new changes', {
      clientId,
      error: err instanceof Error ? err.message : String(err)
    });
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

  syncLogger.info('Ordered changes by domain', {
    changesByTable: ordered.reduce((acc, change) => {
      acc[change.table] = (acc[change.table] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    operationCounts: ordered.reduce((acc, change) => {
      acc[change.operation] = (acc[change.operation] || 0) + 1;
      return acc;
    }, {} as Record<string, number>)
  });

  return ordered;
} 