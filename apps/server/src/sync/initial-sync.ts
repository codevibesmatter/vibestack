import type { 
  ServerMessage, 
  ServerInitStartMessage, 
  ServerInitChangesMessage, 
  ServerInitCompleteMessage,
  ServerStateChangeMessage,
  ClientMessage,
  CltMessageType,
  TableChange
} from '@repo/sync-types';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import { sql } from '../lib/db';
import { SERVER_TABLE_HIERARCHY } from '@repo/dataforge/server-entities';
import type { QueryResultRow } from '@neondatabase/serverless';
import { getDBClient } from '../lib/db';
import type { WebSocketMessageHandler } from './websocket-handler';
import type { StateManager } from './state-manager';
import type { InitialSyncState } from './types';
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

  syncLogger.debug('Executing query:', {
    table: cleanTableName(table),
    query,
    cursor,
    chunkSize
  }, MODULE_NAME);

  // Create new client for this query
  const client = getDBClient(context);
  try {
    await client.connect();
    const result = await client.query<T>(
      query,
      cursor ? [cursor] : []
    );

    syncLogger.debug('Query result:', {
      table: cleanTableName(table),
      rowCount: result.rows.length
    }, MODULE_NAME);

    // Check if there are more records
    const hasMore = result.rows.length > chunkSize;
    const items = hasMore ? result.rows.slice(0, chunkSize) : result.rows;
    const nextCursor = items.length > 0 ? items[items.length - 1].id : null;

    syncLogger.debug('Retrieved table chunk', {
      table: cleanTableName(table),
      chunkSize,
      itemCount: items.length,
      hasMore,
      nextCursor
    }, MODULE_NAME);

    return {
      items,
      nextCursor,
      hasMore
    };
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
  syncLogger.debug('Starting to process table in chunks', {
    table,
    options
  }, MODULE_NAME);

  let cursor: string | null = null;
  let totalProcessed = 0;

  while (true) {
    const chunk: ChunkResult<QueryResultRow> = await getTableChunk<QueryResultRow>(context, table, { ...options, cursor });
    await processor(chunk.items, totalProcessed, totalProcessed + chunk.items.length);
    totalProcessed += chunk.items.length;

    if (!chunk.hasMore) {
      break;
    }

    cursor = chunk.nextCursor;
  }

  syncLogger.info('Finished processing table in chunks', {
    table,
    totalProcessed
  }, MODULE_NAME);
}

/**
 * Get current server LSN
 */
async function getServerLSN(context: MinimalContext): Promise<string> {
  const lsnResult = await sql<{ lsn: string }>(context, 'SELECT pg_current_wal_lsn() as lsn');
  return lsnResult[0].lsn;
}

/**
 * Send initial sync start message
 */
async function sendInitialSyncStart(
  context: MinimalContext,
  clientId: string,
  startLSN: string,
  messageHandler: WebSocketMessageHandler
): Promise<void> {
  const initStartMsg: ServerInitStartMessage = {
    type: 'srv_init_start',
    serverLSN: startLSN,
    messageId: `srv_${Date.now()}`,
    timestamp: Date.now(),
    clientId
  };
  await messageHandler.send(initStartMsg);
}

/**
 * Process a single table during initial sync
 */
async function processTable(
  context: MinimalContext,
  clientId: string,
  table: string,
  stateManager: StateManager,
  messageHandler: WebSocketMessageHandler
): Promise<void> {
  // Get current sync state
  const syncState = await stateManager.getInitialSyncProgress(clientId);
  if (!syncState) throw new Error('Sync state not found');

  // Process table in chunks
  await processTableInChunks(
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
    },
    { chunkSize: WS_CHUNK_SIZE }
  );
}

/**
 * Send initial sync complete message
 */
async function sendInitialSyncComplete(
  context: MinimalContext,
  clientId: string,
  startLSN: string,
  messageHandler: WebSocketMessageHandler
): Promise<void> {
  const initCompleteMsg: ServerInitCompleteMessage = {
    type: 'srv_init_complete',
    serverLSN: startLSN,
    messageId: `srv_${Date.now()}`,
    timestamp: Date.now(),
    clientId
  };
  await messageHandler.send(initCompleteMsg);
}

/**
 * Perform initial sync for a client
 * This uses direct table queries instead of WAL
 */
export async function performInitialSync(
  context: MinimalContext,
  messageHandler: WebSocketMessageHandler,
  stateManager: StateManager,
  clientId: string
): Promise<void> {
  // Get current sync state if any
  let syncState = await stateManager.getInitialSyncProgress(clientId);
  let startLSN: string;
  
  // Send initial sync start if not resuming
  if (!syncState || syncState.status === 'complete') {
    const lsnResult = await sql<{ lsn: string }>(context, 'SELECT pg_current_wal_lsn() as lsn');
    startLSN = lsnResult[0].lsn;
    
    const initStartMsg: ServerInitStartMessage = {
      type: 'srv_init_start',
      serverLSN: startLSN,
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId
    };
    await messageHandler.send(initStartMsg);

    // Initialize sync state
    syncState = {
      table: '',
      lastChunk: 0,
      totalChunks: 0,
      completedTables: [],
      status: 'in_progress',
      startLSN: startLSN
    };
    await stateManager.saveInitialSyncProgress(clientId, syncState);
  } else {
    startLSN = syncState.startLSN;
  }

  // Process each table in hierarchy
  for (const [table, config] of Object.entries(SERVER_TABLE_HIERARCHY)) {
    // Skip if table was completed in previous session
    if (syncState?.completedTables.includes(table)) {
      continue;
    }

    // Start from last chunk + 1 if resuming same table
    const startChunk = syncState?.table === table ? syncState.lastChunk + 1 : 1;
    let totalChunks = 0;

    await processTableInChunks(
      context,
      table,
      async (records, chunkNum, total) => {
        totalChunks = total;
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

        // Wait for chunk acknowledgment
        await waitForMessage(messageHandler, 'clt_init_received', (msg: ClientMessage) => 
          'table' in msg && 'chunk' in msg && 
          msg.table === table && msg.chunk === chunkNum
        );

        // Save progress
        const updatedState: InitialSyncState = {
          table,
          lastChunk: chunkNum,
          totalChunks,
          completedTables: syncState?.completedTables || [],
          status: 'in_progress',
          startLSN: syncState?.startLSN || startLSN
        };
        await stateManager.saveInitialSyncProgress(clientId, updatedState);
        syncState = updatedState;
      },
      { chunkSize: WS_CHUNK_SIZE, startChunk }
    );

    // Update completed tables
    const updatedState: InitialSyncState = {
      ...syncState,
      completedTables: [...syncState.completedTables, table]
    };
    await stateManager.saveInitialSyncProgress(clientId, updatedState);
    syncState = updatedState;
  }

  // Wait for client to process all data
  await waitForMessage(messageHandler, 'clt_init_processed');
  const processingState: InitialSyncState = {
    ...syncState,
    status: 'processing'
  };
  await stateManager.saveInitialSyncProgress(clientId, processingState);
  syncState = processingState;

  // Send completion
  const endLSNResult = await sql<{ lsn: string }>(context, 'SELECT pg_current_wal_lsn() as lsn');
  const endLSN = endLSNResult[0].lsn;
  
  const initCompleteMsg: ServerInitCompleteMessage = {
    type: 'srv_init_complete',
    serverLSN: endLSN,
    messageId: `srv_${Date.now()}`,
    timestamp: Date.now(),
    clientId
  };
  await messageHandler.send(initCompleteMsg);

  // Mark sync as complete
  const completeState: InitialSyncState = {
    ...syncState,
    status: 'complete'
  };
  await stateManager.saveInitialSyncProgress(clientId, completeState);
  syncState = completeState;

  // Handle state transition based on LSN comparison
  if (syncState && endLSN === syncState.startLSN) {
    const stateChangeMsg: ServerStateChangeMessage = {
      type: 'srv_state_change',
      state: 'live',
      lsn: endLSN,
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId
    };
    await messageHandler.send(stateChangeMsg);
  } else {
    // Changes occurred during sync, start catchup
    await handleCatchupSync(context, messageHandler, clientId, endLSN);
  }
}

// Helper function with proper type checking
function waitForMessage(
  messageHandler: WebSocketMessageHandler,
  type: CltMessageType, 
  filter?: (msg: ClientMessage) => boolean
): Promise<void> {
  return new Promise(resolve => {
    messageHandler.onMessage(type, (message: ClientMessage) => {
      if (filter ? filter(message) : true) {
        resolve();
      }
      return Promise.resolve();
    });
  });
}

// Placeholder for handleCatchupSync function
async function handleCatchupSync(
  context: MinimalContext,
  messageHandler: WebSocketMessageHandler,
  clientId: string,
  endLSN: string
): Promise<void> {
  // Implementation of handleCatchupSync
} 