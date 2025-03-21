import type { 
  ServerMessage, 
  ServerInitStartMessage, 
  ServerInitChangesMessage, 
  ServerInitCompleteMessage,
  ServerStateChangeMessage,
  ClientMessage,
  CltMessageType,
  TableChange,
  ServerLSNUpdateMessage
} from '@repo/sync-types';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import { sql } from '../lib/db';
import { SERVER_TABLE_HIERARCHY } from '@repo/dataforge/server-entities';
import type { QueryResultRow } from '@neondatabase/serverless';
import { getDBClient } from '../lib/db';
import type { WebSocket } from '../types/cloudflare';
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
 */
function sendMessage(websocket: WebSocket, message: ServerMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      if (websocket.readyState === WS_READY_STATE.OPEN) {
        websocket.send(JSON.stringify(message));
        // Only log important messages or just log the type
        syncLogger.debug('Sent message', { type: message.type }, MODULE_NAME);
        resolve();
      } else {
        const error = new Error('WebSocket not open');
        syncLogger.error('Failed to send message', { type: message.type, readyState: websocket.readyState }, MODULE_NAME);
        reject(error);
      }
    } catch (error) {
      syncLogger.error('Error sending message', { type: message.type, error: error instanceof Error ? error.message : String(error) }, MODULE_NAME);
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
    // Only log for clt_init_processed, which is the final step in each table processing
    if (type === 'clt_init_processed') {
      syncLogger.debug('Waiting for final client confirmation', { clientId }, MODULE_NAME);
    }
    
    // Flag to track if the promise has been resolved/rejected
    let isCompleted = false;
    
    // Track processed message IDs to avoid duplicates
    const processedMessageIds = new Set<string>();

    // Create timeout to avoid hanging indefinitely
    const timeoutId = setTimeout(() => {
      if (isCompleted) return;
      isCompleted = true;
      
      syncLogger.error('Timeout waiting for message', { 
        clientId, 
        type,
        timeoutMs 
      }, MODULE_NAME);
      
      // Clean up event listeners
      websocket.addEventListener = null as any;
      
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeoutMs);

    // Create a message handler
    const messageHandler = (event: { data: any }) => {
      if (isCompleted) return;
      
      try {
        const rawData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        
        let message;
        try {
          message = JSON.parse(rawData);
        } catch (err) {
          syncLogger.error('Failed to parse message JSON', {
            clientId,
            expectedType: type,
            error: err instanceof Error ? err.message : String(err)
          }, MODULE_NAME);
          return; // Continue waiting for valid messages
        }
        
        // Skip if we've already processed this message ID
        if (message.messageId && processedMessageIds.has(message.messageId)) {
          return;
        }
        
        // Add this message ID to processed set to avoid duplicates
        if (message.messageId) {
          processedMessageIds.add(message.messageId);
        }
        
        // Only process if this is a message we're specifically waiting for
        if (message.type === type) {
          // Basic validation for all message types
          if (!message.messageId || !message.timestamp || !message.clientId) {
            syncLogger.error('Message missing required base fields', {
              clientId,
              type
            }, MODULE_NAME);
            return; // Continue waiting
          }
          
          // Type-specific validation
          let isValid = true;
          
          switch (type) {
            case 'clt_init_received':
              if (!message.table || typeof message.table !== 'string') {
                syncLogger.error('Invalid clt_init_received message: missing table', { clientId }, MODULE_NAME);
                isValid = false;
              }
              if (message.chunk === undefined || typeof message.chunk !== 'number') {
                syncLogger.error('Invalid clt_init_received message: missing chunk', { clientId }, MODULE_NAME);
                isValid = false;
              }
              break;
              
            case 'clt_init_processed':
              // Only needs the base fields
              break;
              
            case 'clt_changes_received':
              if (!Array.isArray(message.changeIds)) {
                syncLogger.error('Invalid clt_changes_received message: missing changeIds array', { clientId }, MODULE_NAME);
                isValid = false;
              }
              if (!message.lastLSN || typeof message.lastLSN !== 'string') {
                syncLogger.error('Invalid clt_changes_received message: missing lastLSN', { clientId }, MODULE_NAME);
                isValid = false;
              }
              break;
              
            case 'clt_changes_applied':
              if (!Array.isArray(message.changeIds)) {
                syncLogger.error('Invalid clt_changes_applied message: missing changeIds array', { clientId }, MODULE_NAME);
                isValid = false;
              }
              if (!message.lastLSN || typeof message.lastLSN !== 'string') {
                syncLogger.error('Invalid clt_changes_applied message: missing lastLSN', { clientId }, MODULE_NAME);
                isValid = false;
              }
              break;
              
            default:
              // For other message types, just proceed with basic validation
              break;
          }
          
          if (!isValid) {
            return; // Continue waiting for a valid message
          }
          
          // Apply optional filter
          if (filter && !filter(message)) {
            // Don't log filter misses
            return; // Wait for another message
          }
          
          // Mark as completed and clear the timeout
          isCompleted = true;
          clearTimeout(timeoutId);
          
          // Only log completion for clt_init_processed
          if (type === 'clt_init_processed') {
            syncLogger.info('Client confirmed processing complete', { clientId }, MODULE_NAME);
          }
          
          resolve();
        }
      } catch (err) {
        syncLogger.error('Error in message handler', {
          clientId,
          expectedType: type,
          error: err instanceof Error ? err.message : String(err)
        }, MODULE_NAME);
        
        // Continue waiting for valid messages
      }
    };
    
    // Register the handler
    websocket.addEventListener('message', messageHandler);
    
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
  });
}

/**
 * Process a table for initial sync
 */
async function processTable(
  context: MinimalContext,
  clientId: string,
  table: string,
  stateManager: StateManager,
  websocket: WebSocket
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
      await sendMessage(websocket, initChangesMsg);
      
      // Wait for client to acknowledge receipt
      await waitForMessage(
        websocket,
        clientId,
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
  websocket: WebSocket
): Promise<void> {
  const initCompleteMsg: ServerInitCompleteMessage = {
    type: 'srv_init_complete',
    serverLSN: startLSN,
    messageId: `srv_${Date.now()}`,
    timestamp: Date.now(),
    clientId
  };
  await sendMessage(websocket, initCompleteMsg);
  
  // Wait for client to acknowledge processing
  await waitForMessage(websocket, clientId, 'clt_init_processed');
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
      
      await sendMessage(websocket, initStartMsg);
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
      
      await sendMessage(websocket, resumeMsg);
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
      await processTable(context, clientId, tableName, stateManager, websocket);

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
    await sendInitialSyncComplete(context, clientId, serverLSN, websocket);

    // Update client's LSN
    await stateManager.updateClientLSN(clientId, serverLSN);

    // Track state change internally
    await stateManager.updateClientSyncState(clientId, 'live');

    // Send LSN update instead of state change
    const lsnUpdateMsg: ServerLSNUpdateMessage = {
      type: 'srv_lsn_update',
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId,
      lsn: serverLSN
    };

    await sendMessage(websocket, lsnUpdateMsg);
    
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

    // Try to close connection with error code
    try {
      if (websocket.readyState === WS_READY_STATE.OPEN) {
        websocket.close(1011, 'Error during initial sync');
      }
    } catch (closeError) {
      syncLogger.error('Error closing WebSocket', { clientId, error: closeError instanceof Error ? closeError.message : String(closeError) }, MODULE_NAME);
    }

    throw error;
  }
} 