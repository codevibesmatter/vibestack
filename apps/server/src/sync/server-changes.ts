import type { Client } from '@neondatabase/serverless';
import type { 
  TableChange,
  SrvMessageType,
  CltMessageType
} from '@repo/sync-types';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import type { MessageContext, MessageSender } from './message-handler';
import { WebSocketMessageSender } from './websocket-handler';
import { getDBClient } from '../lib/db';
import { ChangeHistory } from '@repo/typeorm/server-entities';
import { orderChangesByDomain } from './domain-ordering';

// Constants for chunking
const CHUNK_SIZE = 100; // Maximum changes per chunk

export interface ClientState {
  ws: WebSocket;
  connected: boolean;
  lastLSN?: string;
  clientId: string;
}

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
 * Fetch changes from the database
 */
async function fetchChanges(
  client: Client,
  fromLSN: string,
  toLSN?: string,
  limit: number = CHUNK_SIZE
): Promise<TableChange[]> {
  // Build query based on whether we have a toLSN
  const whereClause = toLSN 
    ? 'lsn::pg_lsn > $1::pg_lsn AND lsn::pg_lsn <= $2::pg_lsn'
    : 'lsn::pg_lsn > $1::pg_lsn';
  
  const params = toLSN ? [fromLSN, toLSN] : [fromLSN];
  
  const result = await client.query<{
    id: string;
    lsn: string;
    table_name: string;
    operation: string;
    data: Record<string, unknown>;
    updated_at: Date;
    client_id: string | null;
  }>(`
    SELECT 
      id,
      lsn,
      table_name,
      operation,
      data,
      updated_at,
      client_id
    FROM change_history
    WHERE ${whereClause}
    ORDER BY lsn::pg_lsn ASC
    LIMIT $${params.length + 1}
  `, [...params, limit]);

  return result.rows.map(row => ({
    table: row.table_name,
    operation: row.operation as 'insert' | 'update' | 'delete',
    data: row.data,
    lsn: row.lsn,
    updated_at: row.updated_at.toISOString()
  }));
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
    .sort((a, b) => compareLSN(a.lsn, b.lsn));
}

/**
 * Fetch changes for a client starting from a given LSN
 */
export async function fetchChangesForClient(
  context: MinimalContext,
  fromLSN: string,
  clientId: string
): Promise<{ changes: TableChange[]; lastLSN: string }> {
  const client = getDBClient(context);
  const changes = await fetchChanges(client, fromLSN);
  
  if (changes.length === 0) {
    return { changes: [], lastLSN: fromLSN };
  }

  const lastLSN = changes[changes.length - 1].lsn;
  const deduplicatedChanges = deduplicateChanges(changes);
  
  syncLogger.info('Fetched changes for client', {
    clientId,
    originalCount: changes.length,
    deduplicatedCount: deduplicatedChanges.length,
    fromLSN,
    lastLSN
  });

  return {
    changes: deduplicatedChanges,
    lastLSN
  };
}

/**
 * Check and send changes to a client
 */
export async function checkAndSendChanges(
  ws: WebSocket,
  changes: TableChange[],
  lastLSN: string,
  currentLSN: string,
  clientId: string
): Promise<boolean> {
  if (!ws.clientData?.clientId) {
    syncLogger.error('No client data found on WebSocket');
    return false;
  }

  const sender = new WebSocketMessageSender(ws, clientId);
  const orderedChanges = orderChangesByDomain(changes);
  
  return sendChanges(orderedChanges, lastLSN, clientId, sender);
}

/**
 * Send changes to client using the message sender with chunking support
 */
async function sendChanges(
  changes: TableChange[],
  lastLSN: string,
  clientId: string,
  sender: MessageSender
): Promise<boolean> {
  if (!changes.length) {
    return false;
  }

  // Calculate chunks
  const chunks = Math.ceil(changes.length / CHUNK_SIZE);
  const success: boolean[] = [];

  for (let i = 0; i < chunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, changes.length);
    const chunkChanges = changes.slice(start, end);

    const message = {
      type: 'srv_changes' as SrvMessageType,
      messageId: `srv_${Date.now()}_${i}`,
      timestamp: Date.now(),
      clientId,
      changes: chunkChanges,
      lastLSN: i === chunks - 1 ? lastLSN : chunkChanges[chunkChanges.length - 1].lsn,
      sequence: { chunk: i + 1, total: chunks }
    };

    try {
      await sender.send(message);
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
 * Handle new changes from replication
 */
export async function handleNewChanges(
  context: MinimalContext,
  firstLSN: string,
  lastLSN: string,
  clientId: string,
  sender: MessageSender
): Promise<boolean> {
  try {
    const client = getDBClient(context);
    const changes = await fetchChanges(client, firstLSN, lastLSN);
    
    if (changes.length === 0) {
      syncLogger.debug('No changes found in range', {
        firstLSN,
        lastLSN
      });
      return false;
    }

    // First deduplicate to get latest state of each record
    const deduplicatedChanges = deduplicateChanges(changes);
    
    syncLogger.info('Deduplicating changes', {
      clientId,
      originalCount: changes.length,
      deduplicatedCount: deduplicatedChanges.length,
      reductionPercent: Math.round((1 - deduplicatedChanges.length / changes.length) * 100),
      tables: [...new Set(changes.map(c => c.table))].join(',')
    });

    // Then order by domain hierarchy
    const orderedChanges = orderChangesByDomain(deduplicatedChanges);
    
    syncLogger.info('Ordered changes by domain', {
      clientId,
      tableOrder: orderedChanges.map(c => `${c.operation}:${c.table}`).join(',')
    });

    return await sendChanges(orderedChanges, lastLSN, clientId, sender);
  } catch (err) {
    syncLogger.error('Error handling new changes', err);
    return false;
  }
}

/**
 * Process a sync request from a client
 */
export async function processSyncRequest(
  message: { type: CltMessageType; clientId: string; lastLSN: string },
  ctx: MessageContext,
  sender: MessageSender
): Promise<void> {
  try {
    const client = getDBClient(ctx.context);
    const changes = await fetchChanges(client, message.lastLSN);
    
    if (changes.length === 0) {
      syncLogger.info('No changes found for sync request', {
        clientId: message.clientId,
        lastLSN: message.lastLSN
      });
      return;
    }

    const lastLSN = changes[changes.length - 1].lsn;
    const deduplicatedChanges = deduplicateChanges(changes);
    
    syncLogger.info('Deduplicating changes for sync request', {
      clientId: message.clientId,
      originalCount: changes.length,
      deduplicatedCount: deduplicatedChanges.length,
      reductionPercent: Math.round((1 - deduplicatedChanges.length / changes.length) * 100),
      fromLSN: message.lastLSN,
      toLSN: lastLSN,
      tables: [...new Set(changes.map(c => c.table))].join(',')
    });

    // Order changes by domain hierarchy
    const orderedChanges = orderChangesByDomain(deduplicatedChanges);
    
    syncLogger.info('Ordered changes by domain for sync request', {
      clientId: message.clientId,
      tableOrder: orderedChanges.map(c => `${c.operation}:${c.table}`).join(',')
    });
    
    await sendChanges(orderedChanges, lastLSN, message.clientId, sender);
    
    if (ctx.updateLSN) {
      ctx.updateLSN(lastLSN);
    }
  } catch (err) {
    syncLogger.error('Error processing sync request', err);
    throw err;
  }
} 