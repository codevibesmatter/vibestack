import type { 
  ServerMessage, 
  ServerInitStartMessage, 
  ServerInitChangesMessage, 
  ServerInitCompleteMessage,
  CltMessageType,
  TableChange
} from '@repo/sync-types';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import { sql } from '../lib/db';
import { SERVER_TABLE_HIERARCHY } from '@repo/dataforge/server-entities';
import type { QueryResultRow } from '@neondatabase/serverless';
import { getDBClient } from '../lib/db';
import type { WebSocket } from '../types/cloudflare';
import type { StateManager } from './state-manager';
import type { InitialSyncState, WebSocketHandler } from './types';
import { SERVER_DOMAIN_TABLES } from '@repo/dataforge/server-entities';

const MODULE_NAME = 'initial-sync';
const WS_CHUNK_SIZE = 2000;  // Even larger chunks for WebSocket since we batch all changes together
const DEFAULT_CHUNK_SIZE = 1000;  // Default chunk size for table queries

type TableName = keyof typeof SERVER_TABLE_HIERARCHY;

interface ChunkOptions {
  chunkSize?: number;
  cursor?: string | null;
}

interface ChunkResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ChunkProcessor {
  (records: QueryResultRow[], chunkNum: number, total: number): Promise<void>;
}

interface ProcessTableOptions {
  chunkSize: number;
  startChunk?: number;
}

/**
 * Clean table name by removing quotes if present
 */
function cleanTableName(table: string): string {
  return table.replace(/^"|"$/g, '');
}

/**
 * Convert table records to TableChange format
 */
function recordsToChanges(table: string, records: QueryResultRow[]): TableChange[] {
  return records.map(record => ({
    table: cleanTableName(table),
    operation: 'update' as const,
    data: record,
    updated_at: (record as any).updated_at?.toISOString() || new Date().toISOString()
  }));
}

/**
 * Get a chunk of records from a table with cursor-based pagination
 */
async function getTableChunk<T extends QueryResultRow>(
  context: MinimalContext,
  table: string,
  options: ChunkOptions = {}
): Promise<ChunkResult<T>> {
  const { chunkSize = DEFAULT_CHUNK_SIZE, cursor = null } = options;
  
  // Build the query with cursor
  const query = `
    SELECT *
    FROM ${table}
    ${cursor ? 'WHERE id > $1' : ''}
    ORDER BY id ASC
    LIMIT ${chunkSize + 1}
  `;

  // Only log at debug level and with minimal info
  syncLogger.debug('Fetching chunk', { table: cleanTableName(table) }, MODULE_NAME);

  // Create new client for this query
  const client = getDBClient(context);
  
  try {
    await client.connect();
    
    const result = await client.query<T>(
      query,
      cursor ? [cursor] : []
    );

    // Check if there are more records
    const hasMore = result.rows.length > chunkSize;
    const items = hasMore ? result.rows.slice(0, chunkSize) : result.rows;
    const nextCursor = items.length > 0 ? items[items.length - 1].id : null;

    // Don't log every chunk result

    return {
      items,
      nextCursor,
      hasMore
    };
  } catch (error) {
    syncLogger.error('Database query error', { table: cleanTableName(table), error: error instanceof Error ? error.message : String(error) }, MODULE_NAME);
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Process a table in chunks
 */
async function processTableInChunks(
  context: MinimalContext,
  table: string,
  processor: ChunkProcessor,
  options: ProcessTableOptions
): Promise<void> {
  // Only log at the beginning of processing a table
  syncLogger.debug('Processing table in chunks', { table, chunkSize: options.chunkSize }, MODULE_NAME);

  let cursor: string | null = null;
  let totalProcessed = 0;
  let chunkNum = 0;

  while (true) {
    chunkNum++;
    const chunk: ChunkResult<QueryResultRow> = await getTableChunk<QueryResultRow>(context, table, { ...options, cursor });
    await processor(chunk.items, chunkNum, totalProcessed + chunk.items.length);
    totalProcessed += chunk.items.length;

    if (!chunk.hasMore) {
      break;
    }

    cursor = chunk.nextCursor;
  }

  syncLogger.info('Completed table processing', { table, totalRecords: totalProcessed }, MODULE_NAME);
}

/**
 * Get current server LSN
 */
async function getServerLSN(context: MinimalContext): Promise<string> {
  const lsnResult = await sql<{ lsn: string }>(context, 'SELECT pg_current_wal_lsn() as lsn');
  return lsnResult[0].lsn;
}

/**
 * Send a message to the client over WebSocket
 * @deprecated Use messageHandler.send() instead
 */
function sendMessage(messageHandler: WebSocketHandler, message: ServerMessage): Promise<void> {
  return messageHandler.send(message);
}

/**
 * Wait for a message of a specific type with optional filter
 * @deprecated Use messageHandler.waitForMessage() instead
 */
function waitForMessage(
  messageHandler: WebSocketHandler,
  clientId: string,
  type: CltMessageType, 
  filter?: (msg: any) => boolean,
  timeoutMs: number = 30000 // Default timeout of 30 seconds
): Promise<void> {
  return messageHandler.waitForMessage(type, filter, timeoutMs);
}

/**
 * Process a table for initial sync
 */
async function processTable(
  context: MinimalContext,
  clientId: string,
  table: string,
  stateManager: StateManager,
  messageHandler: WebSocketHandler
): Promise<void> {
  // Get current sync state
  const syncState = await stateManager.getInitialSyncProgress(clientId);
  if (!syncState) throw new Error('Sync state not found');

  syncLogger.info('Processing table data', { clientId, table }, MODULE_NAME);

  // Process table in chunks
  await processTableInChunks(
    context,
    table,
    async (records, chunkNum, total) => {
      const changes = recordsToChanges(table, records);
      
      syncLogger.debug('Sending table chunk', { clientId, table, chunk: chunkNum, recordCount: changes.length }, MODULE_NAME);
      
      const initChangesMsg: ServerInitChangesMessage = {
        type: 'srv_init_changes',
        messageId: `srv_${Date.now()}`,
        timestamp: Date.now(),
        clientId,
        changes,
        sequence: {
          table,
          chunk: chunkNum,
          total
        }
      };
      await messageHandler.send(initChangesMsg);
      
      // Wait for client to acknowledge receipt
      await messageHandler.waitForMessage(
        'clt_init_received',
        (msg) => msg.table === table && msg.chunk === chunkNum
      );
    },
    { chunkSize: WS_CHUNK_SIZE }
  );
  
  syncLogger.info('Table processing complete', { clientId, table }, MODULE_NAME);
}

/**
 * Send initial sync complete message and wait for processing
 */
async function sendInitialSyncComplete(
  context: MinimalContext,
  clientId: string,
  startLSN: string,
  messageHandler: WebSocketHandler
): Promise<void> {
  const initCompleteMsg: ServerInitCompleteMessage = {
    type: 'srv_init_complete',
    serverLSN: startLSN,
    messageId: `srv_${Date.now()}`,
    timestamp: Date.now(),
    clientId
  };
  await messageHandler.send(initCompleteMsg);
  
  // Wait for client to acknowledge processing
  await messageHandler.waitForMessage('clt_init_processed');
}

/**
 * Perform initial sync for a client
 * This uses direct table queries instead of WAL
 */
export async function performInitialSync(
  context: MinimalContext,
  messageHandler: WebSocketHandler,
  stateManager: StateManager,
  clientId: string
): Promise<void> {
  syncLogger.info('Starting initial sync', { clientId }, MODULE_NAME);
  
  try {
    // Get current sync state if any
    let syncState = await stateManager.getInitialSyncProgress(clientId);
    
    // Check if we are resuming an interrupted sync
    if (syncState && syncState.status === 'in_progress') {
      syncLogger.info('Resuming interrupted sync', { clientId, completedTables: syncState.completedTables.length }, MODULE_NAME);
    } else {
      // Start a new sync from scratch
      syncLogger.info('Starting new initial sync', { clientId }, MODULE_NAME);

      // Get current server LSN before starting
      const serverLSN = await stateManager.getServerLSN();
      
      // Create initial sync state
      syncState = {
        table: '',
        lastChunk: 0,
        totalChunks: 0,
        completedTables: [],
        status: 'in_progress',
        startLSN: serverLSN,
        startTimeMs: Date.now()
      };
      await stateManager.saveInitialSyncProgress(clientId, syncState);
      
      // Send init start message
      const initStartMsg: ServerInitStartMessage = {
        type: 'srv_init_start',
        messageId: `srv_${Date.now()}`,
        timestamp: Date.now(),
        clientId,
        serverLSN
      };
      
      await messageHandler.send(initStartMsg);
    }

    // If resuming, send resume message
    if (syncState.completedTables.length > 0) {
      const resumeMsg: ServerInitStartMessage = {
        type: 'srv_init_start',
        messageId: `srv_${Date.now()}`,
        timestamp: Date.now(),
        clientId,
        serverLSN: syncState.startLSN + ' (resuming)'
      };
      
      await messageHandler.send(resumeMsg);
    }

    // Get ordered tables for sync
    const sortedTables = Object.keys(SERVER_TABLE_HIERARCHY).sort((a, b) => {
      const levelA = SERVER_TABLE_HIERARCHY[a as TableName];
      const levelB = SERVER_TABLE_HIERARCHY[b as TableName];
      return levelA - levelB;
    });

    // Process each table in order
    for (const tableName of sortedTables) {
      // Skip processed tables if resuming
      if (syncState.completedTables.includes(tableName)) {
        continue;
      }

      // Update sync state to reflect current table being processed
      syncState.table = tableName;
      await stateManager.saveInitialSyncProgress(clientId, syncState);

      // Process this table
      await processTable(context, clientId, tableName, stateManager, messageHandler);

      // Mark table as completed
      syncState.completedTables.push(tableName);
      await stateManager.saveInitialSyncProgress(clientId, syncState);
    }

    // We made it through all tables! Send completion message
    syncState.status = 'complete';
    await stateManager.saveInitialSyncProgress(clientId, syncState);

    // Get final LSN
    const serverLSN = await stateManager.getServerLSN();
    
    // Send sync complete message and wait for client processing
    await sendInitialSyncComplete(context, clientId, serverLSN, messageHandler);

    // Update client's LSN
    await stateManager.updateClientLSN(clientId, serverLSN);

    // Track state change internally
    await stateManager.updateClientSyncState(clientId, 'live');

    // Calculate sync time
    if (syncState.startTimeMs) {
      const syncTimeMs = Date.now() - syncState.startTimeMs;
      syncLogger.info('Initial sync complete', {
        clientId,
        tables: sortedTables.length,
        syncTimeMs,
        syncTimeSec: Math.round(syncTimeMs / 1000)
      }, MODULE_NAME);
    }
  } catch (error) {
    syncLogger.error('Initial sync error', { clientId, error: error instanceof Error ? error.message : String(error) }, MODULE_NAME);

    // No need to manually close the WebSocket - this should be handled by the SyncDO
    throw error;
  }
} 