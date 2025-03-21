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
import type { WebSocket } from '../types/cloudflare';

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

// WebSocket ready states
const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
} as const;

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

  syncLogger.debug('Building database query', {
    table: cleanTableName(table),
    query,
    cursor,
    chunkSize
  }, MODULE_NAME);

  // Create new client for this query
  const client = getDBClient(context);
  syncLogger.debug('Created database client', {
    table: cleanTableName(table)
  }, MODULE_NAME);
  
  try {
    syncLogger.debug('Connecting to database', {
      table: cleanTableName(table)
    }, MODULE_NAME);
    
    await client.connect();
    
    syncLogger.debug('Connected to database, executing query', {
      table: cleanTableName(table),
      query: query.trim()
    }, MODULE_NAME);
    
    const result = await client.query<T>(
      query,
      cursor ? [cursor] : []
    );

    syncLogger.debug('Query executed successfully', {
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
  } catch (error) {
    syncLogger.error('Error executing database query', {
      table: cleanTableName(table),
      query,
      cursor,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }, MODULE_NAME);
    throw error;
  } finally {
    syncLogger.debug('Closing database connection', {
      table: cleanTableName(table)
    }, MODULE_NAME);
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
 * Send a message to the client over WebSocket
 */
function sendMessage(websocket: WebSocket, message: ServerMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      if (websocket.readyState === WS_READY_STATE.OPEN) {
        websocket.send(JSON.stringify(message));
        syncLogger.debug('Sent message to client', {
          type: message.type,
          messageId: message.messageId
        }, MODULE_NAME);
        resolve();
      } else {
        const error = new Error('WebSocket not open');
        syncLogger.error('Failed to send message', {
          type: message.type,
          messageId: message.messageId,
          readyState: websocket.readyState
        }, MODULE_NAME);
        reject(error);
      }
    } catch (error) {
      syncLogger.error('Error sending message', {
        type: message.type,
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      reject(error);
    }
  });
}

/**
 * Wait for a message of a specific type with optional filter
 */
function waitForMessage(
  websocket: WebSocket,
  clientId: string,
  type: string, 
  filter?: (msg: any) => boolean,
  timeoutMs: number = 30000 // Default timeout of 30 seconds
): Promise<void> {
  return new Promise((resolve, reject) => {
    syncLogger.debug('Setting up wait for message', { 
      clientId, 
      type, 
      timeoutMs 
    }, MODULE_NAME);
    
    // Flag to track if the promise has been resolved/rejected
    let isCompleted = false;

    // Create timeout to avoid hanging indefinitely
    const timeoutId = setTimeout(() => {
      if (isCompleted) return;
      isCompleted = true;
      
      syncLogger.error('Timeout waiting for message', { 
        clientId, 
        type,
        timeoutMs 
      }, MODULE_NAME);
      
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeoutMs);

    // Create a message handler
    const messageHandler = (event: { data: any }) => {
      if (isCompleted) return;
      
      try {
        const rawData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        syncLogger.debug('Received message in waitForMessage', { 
          clientId,
          expectedType: type,
          rawData: rawData.substring(0, 100) + (rawData.length > 100 ? '...' : '')
        }, MODULE_NAME);

        const message = JSON.parse(rawData);
        
        // Check message type
        if (message.type === type) {
          syncLogger.debug('Message matches expected type', { 
            clientId,
            type,
            messageId: message.messageId
          }, MODULE_NAME);
          
          // Apply optional filter
          if (filter && !filter(message)) {
            syncLogger.debug('Message did not pass filter, continuing to wait', { 
              clientId,
              type,
              messageId: message.messageId
            }, MODULE_NAME);
            return; // Wait for another message
          }
          
          // Mark as completed and clear the timeout
          isCompleted = true;
          clearTimeout(timeoutId);
          
          syncLogger.debug('Received expected message, resolving wait', { 
            type,
            messageId: message.messageId
          }, MODULE_NAME);
          
          resolve();
        } else {
          syncLogger.debug('Received message with different type, continuing to wait', { 
            clientId,
            expectedType: type,
            actualType: message.type
          }, MODULE_NAME);
        }
      } catch (err) {
        syncLogger.error('Error in message handler', {
          clientId,
          expectedType: type,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          data: typeof event.data === 'string' ? 
            event.data.substring(0, 100) + (event.data.length > 100 ? '...' : '') : 
            '[binary data]'
        }, MODULE_NAME);
        
        // Don't reject here, keep waiting for the correct message
        // Just log the error and continue
      }
    };
    
    // Register the handler
    websocket.addEventListener('message', messageHandler);
    
    // Immediately check if WebSocket is already closed/closing
    if (websocket.readyState !== WS_READY_STATE.OPEN) {
      if (isCompleted) return;
      isCompleted = true;
      clearTimeout(timeoutId);
      
      syncLogger.error('WebSocket not open while waiting for message', { 
        clientId, 
        type,
        readyState: websocket.readyState
      }, MODULE_NAME);
      
      reject(new Error('WebSocket not open'));
    }
    
    // Also handle connection close
    const closeHandler = (event: { code: number; reason: string }) => {
      if (isCompleted) return;
      isCompleted = true;
      clearTimeout(timeoutId);
      
      syncLogger.error('WebSocket closed while waiting for message', { 
        clientId, 
        type,
        code: event.code,
        reason: event.reason
      }, MODULE_NAME);
      
      reject(new Error(`WebSocket closed while waiting for message: ${event.code} - ${event.reason}`));
    };
    
    websocket.addEventListener('close', closeHandler);
  });
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
  websocket: WebSocket,
  stateManager: StateManager,
  clientId: string
): Promise<void> {
  syncLogger.info('Beginning initial sync', { 
    clientId, 
    wsReadyState: websocket.readyState 
  }, MODULE_NAME);
  
  try {
    // Log table hierarchy for debugging
    syncLogger.info('Server table hierarchy for sync', { 
      clientId,
      tables: Object.keys(SERVER_TABLE_HIERARCHY),
      tableCount: Object.keys(SERVER_TABLE_HIERARCHY).length
    }, MODULE_NAME);
    
    // Get current sync state if any
    syncLogger.debug('Getting initial sync progress', { clientId }, MODULE_NAME);
    let syncState = await stateManager.getInitialSyncProgress(clientId);
    
    // Get server LSN to use for startup and comparison
    const startLSN = await stateManager.getServerLSN();
    syncLogger.info('Starting initial sync with server LSN', { clientId, startLSN }, MODULE_NAME);
    
    // Initialize sync if not resuming
    if (!syncState) {
      syncLogger.info('Starting new sync session', { clientId }, MODULE_NAME);
      
      // Send initial sync start message
      const initStartMsg: ServerInitStartMessage = {
        type: 'srv_init_start',
        serverLSN: startLSN,
        messageId: `srv_${Date.now()}`,
        timestamp: Date.now(),
        clientId
      };
      
      await sendMessage(websocket, initStartMsg);
      
      // Initialize sync state
      syncState = {
        table: '',
        lastChunk: 0,
        totalChunks: 0,
        completedTables: [],
        status: 'in_progress',
        startLSN
      };
      
      await stateManager.saveInitialSyncProgress(clientId, syncState);
    } else {
      syncLogger.info('Resuming sync', { 
        clientId, 
        completedTables: syncState.completedTables.length,
        currentTable: syncState.table 
      }, MODULE_NAME);
      
      // Send resume notification with custom message in serverLSN field
      const resumeMsg: ServerInitStartMessage = {
        type: 'srv_init_start',
        serverLSN: `${startLSN} (resuming)`,
        messageId: `srv_${Date.now()}`,
        timestamp: Date.now(),
        clientId
      };
      
      await sendMessage(websocket, resumeMsg);
      
      // Ensure startLSN is set if somehow missing
      if (!syncState.startLSN) {
        syncState.startLSN = startLSN;
      }
    }

    // Process each table in hierarchy
    for (const [table, level] of Object.entries(SERVER_TABLE_HIERARCHY)) {
      // Skip if table was completed in previous session
      if (syncState.completedTables.includes(table)) {
        syncLogger.debug('Skipping completed table', { clientId, table }, MODULE_NAME);
        continue;
      }

      syncLogger.info('Processing table', { clientId, table }, MODULE_NAME);
      
      // Start from last chunk + 1 if resuming same table
      const startChunk = syncState.table === table ? syncState.lastChunk + 1 : 1;
      
      try {
        await processTableInChunks(
          context,
          table,
          async (records, chunkNum, total) => {
            // Convert records to changes
            const changes = recordsToChanges(table, records);
            
            // Send changes to client
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
            
            await sendMessage(websocket, initChangesMsg);
            
            // Wait for client acknowledgment
            await waitForMessage(
              websocket, 
              clientId,
              'clt_init_received', 
              (msg) => msg.table === table && msg.chunk === chunkNum
            );
            
            // Update sync state after client confirms receipt
            const updatedState: InitialSyncState = {
              table,
              lastChunk: chunkNum,
              totalChunks: total,
              status: 'in_progress',
              startLSN: syncState?.startLSN || startLSN,
              completedTables: syncState?.completedTables || []
            };
            
            await stateManager.saveInitialSyncProgress(clientId, updatedState);
            syncState = updatedState;
          },
          { chunkSize: WS_CHUNK_SIZE, startChunk }
        );
      } catch (error) {
        syncLogger.error('Error processing table', {
          clientId,
          table,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        }, MODULE_NAME);
        
        // Continue with the next table instead of failing the entire sync
        continue;
      }

      // Mark table as completed
      const updatedState: InitialSyncState = {
        ...syncState,
        completedTables: [...syncState.completedTables, table]
      };
      
      await stateManager.saveInitialSyncProgress(clientId, updatedState);
      syncState = updatedState;
      
      syncLogger.info('Completed table', { clientId, table }, MODULE_NAME);
    }

    // Wait for client to process all data
    syncLogger.info('Waiting for client to process all data', { clientId }, MODULE_NAME);
    await waitForMessage(websocket, clientId, 'clt_init_processed');
    
    // Mark sync as complete
    const completeState: InitialSyncState = {
      ...syncState,
      status: 'complete'
    };

    await stateManager.saveInitialSyncProgress(clientId, completeState);

    // Get end LSN and send completion message
    const endLSN = await stateManager.getServerLSN();

    // Send completion message
    const initCompleteMsg: ServerInitCompleteMessage = {
      type: 'srv_init_complete',
      serverLSN: endLSN,
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId
    };

    await sendMessage(websocket, initCompleteMsg);

    // Update client LSN to the end LSN
    await stateManager.updateClientLSN(clientId, endLSN);

    // Determine next state based on LSN comparison
    const nextState = endLSN === startLSN ? 'live' : 'catchup';
    
    // Send state change message
    const stateChangeMsg: ServerStateChangeMessage = {
      type: 'srv_state_change',
      state: nextState,
      lsn: endLSN,
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId
    };
    
    await sendMessage(websocket, stateChangeMsg);
    
    syncLogger.info('Initial sync completed, transitioned to next state', { 
      clientId, 
      nextState,
      startLSN,
      endLSN
    }, MODULE_NAME);
  } catch (error) {
    syncLogger.error('Error during initial sync', {
      clientId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }, MODULE_NAME);
    
    // Try to close the connection with an error code
    try {
      if (websocket.readyState === WS_READY_STATE.OPEN) {
        websocket.close(1011, 'Error during initial sync');
      }
    } catch (closeError) {
      syncLogger.error('Error closing WebSocket', {
        clientId,
        error: closeError instanceof Error ? closeError.message : String(closeError)
      }, MODULE_NAME);
    }
    
    throw error;
  }
} 