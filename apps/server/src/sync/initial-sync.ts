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
): Promise<number> {
  let cursor: string | null = null;
  let totalProcessed = 0;
  let chunkNum = 0;

  syncLogger.debug('Processing table', { table, chunkSize: options.chunkSize }, MODULE_NAME);

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

  return totalProcessed;
}

/**
 * Process a table for initial sync
 */
async function processTable(
  context: MinimalContext,
  clientId: string,
  table: string,
  messageHandler: WebSocketHandler
): Promise<number> {
  let totalRecords = 0;
  
  // Process table in chunks
  totalRecords = await processTableInChunks(
    context,
    table,
    async (records, chunkNum, total) => {
      const changes = recordsToChanges(table, records);
      
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
  
  return totalRecords;
}

/**
 * Send initial sync complete message and wait for processing
 */
async function sendInitialSyncComplete(
  context: MinimalContext,
  clientId: string,
  serverLSN: string,
  messageHandler: WebSocketHandler
): Promise<void> {
  const initCompleteMsg: ServerInitCompleteMessage = {
    type: 'srv_init_complete',
    serverLSN,
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
    const startTime = Date.now();
    
    // Get current server LSN
    const startLSN = await stateManager.getServerLSN();
    
    // Initialize new sync or use existing state
    if (!syncState || syncState.status !== 'in_progress') {
      // Start a new sync
      syncState = {
        table: '',
        lastChunk: 0,
        totalChunks: 0,
        completedTables: [],
        status: 'in_progress',
        startLSN,
        startTimeMs: startTime
      };
      
      // Send init start message
      const initStartMsg: ServerInitStartMessage = {
        type: 'srv_init_start',
        messageId: `srv_${Date.now()}`,
        timestamp: Date.now(),
        clientId,
        serverLSN: startLSN
      };
      await messageHandler.send(initStartMsg);
    } else {
      // Resuming sync - send resume message
      syncLogger.info('Resuming interrupted sync', { 
        clientId, 
        completedTables: syncState.completedTables.length 
      }, MODULE_NAME);
      
      const resumeMsg: ServerInitStartMessage = {
        type: 'srv_init_start',
        messageId: `srv_${Date.now()}`,
        timestamp: Date.now(),
        clientId,
        serverLSN: syncState.startLSN + ' (resuming)'
      };
      await messageHandler.send(resumeMsg);
    }
    
    // Save initial state once at the beginning
    await stateManager.saveInitialSyncProgress(clientId, syncState);

    // Get ordered tables for sync
    const sortedTables = Object.keys(SERVER_TABLE_HIERARCHY).sort((a, b) => {
      const levelA = SERVER_TABLE_HIERARCHY[a as TableName];
      const levelB = SERVER_TABLE_HIERARCHY[b as TableName];
      return levelA - levelB;
    });

    // Track sync progress metrics
    let totalRecords = 0;
    let processedTables = 0;
    
    // Process each table in order
    for (const tableName of sortedTables) {
      // Skip processed tables if resuming
      if (syncState.completedTables.includes(tableName)) {
        processedTables++;
        continue;
      }

      // Update sync state to current table - save only when changing tables
      syncState.table = tableName;
      await stateManager.saveInitialSyncProgress(clientId, syncState);

      // Process this table
      syncLogger.info('Processing table', { clientId, table: tableName }, MODULE_NAME);
      const tableRecords = await processTable(context, clientId, tableName, messageHandler);
      totalRecords += tableRecords;

      // Add to completed tables
      syncState.completedTables.push(tableName);
      processedTables++;
      
      // Periodically save state (after each table completes)
      await stateManager.saveInitialSyncProgress(clientId, syncState);
      
      syncLogger.info('Table completed', { 
        clientId, 
        table: tableName, 
        records: tableRecords,
        progress: `${processedTables}/${sortedTables.length} tables`
      }, MODULE_NAME);
    }

    // Mark sync as complete in our state tracking
    syncState.status = 'complete';
    await stateManager.saveInitialSyncProgress(clientId, syncState);

    // Get final LSN
    const finalLSN = await stateManager.getServerLSN();
    
    // Calculate sync metrics
    const syncTimeMs = Date.now() - startTime;
    
    // Log completion before sending the completion message
    syncLogger.info('Initial sync complete, sending completion message', {
      clientId,
      tables: sortedTables.length,
      totalRecords,
      syncTimeMs,
      syncTimeSec: Math.round(syncTimeMs / 1000),
      recordsPerSecond: Math.round((totalRecords / syncTimeMs) * 1000),
      finalLSN
    }, MODULE_NAME);
    
    // Send sync complete message and wait for client acknowledgment
    await sendInitialSyncComplete(context, clientId, finalLSN, messageHandler);

    // Store the client's LSN internally without sending additional messages
    await stateManager.updateClientLSN(clientId, finalLSN);
    
    // Note: We no longer send srv_state_change, srv_lsn_update, or srv_sync_completed messages
    // Those were determined to be unnecessary for the initial sync flow
  } catch (error) {
    syncLogger.error('Initial sync error', { 
      clientId, 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }, MODULE_NAME);
    throw error;
  }
} 