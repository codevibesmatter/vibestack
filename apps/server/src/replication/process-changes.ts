import type { TableChange } from '@repo/sync-types';
import { replicationLogger } from '../middleware/logger';
import type { MinimalContext } from '../types/hono';
import type { WALData, PostgresWALMessage } from '../types/wal';
import { sql, getDBClient } from '../lib/db';
import { StateManager } from './state-manager';
import { SERVER_DOMAIN_TABLES } from '@repo/dataforge/server-entities';
import type { Env } from '../types/env';

/**
 * Process Changes Module
 * 
 * This module handles the processing of PostgreSQL Write-Ahead Log (WAL) changes 
 * into our application data model. It follows a clear linear flow:
 * 
 * 1. TRANSFORMATION
 *    - Raw WAL data is received from the database
 *    - Invalid changes are filtered out
 *    - Valid changes are transformed into TableChange objects
 * 
 * 2. STORAGE
 *    - TableChange objects are stored in the change_history table
 *    - This provides a centralized historical record of all changes
 * 
 * 3. LSN MANAGEMENT
 *    - Once changes are successfully stored, the Log Sequence Number (LSN) is advanced
 *    - This happens by consuming the replication slot up to the last LSN
 *    - The current LSN is tracked in the StateManager
 * 
 * 4. CLIENT NOTIFICATION
 *    - After storage and LSN advancement, connected clients are notified
 *    - Active clients are queried directly from KV storage
 *    - Changes are broadcast to relevant clients
 * 
 * KEY PRINCIPLES:
 * - Changes are validated early in the pipeline
 * - LSN is only advanced after successful storage
 * - Each function has a single responsibility
 * - Clear separation between transformation, storage, and notification
 * - Error handling at each step to prevent data loss
 * 
 * MAIN ENTRY POINTS:
 * - processWALChanges: Handle transformation and storage
 * - processAndConsumeWALChanges: Complete flow including LSN management and client notification
 */

const MODULE_NAME = 'process-changes';

/**
 * Client state persisted in KV storage
 */
export interface ClientState {
  clientId: string;
  active: boolean;
  lastSeen: number;
}

/**
 * Check if a table should be tracked for replication
 * Uses SERVER_DOMAIN_TABLES to determine which tables should be tracked
 */
export function shouldTrackTable(tableName: string): boolean {
  // Skip the change_history table itself to avoid recursive loops
  if (tableName === 'change_history') {
    return false;
  }
  
  // Use SERVER_DOMAIN_TABLES to determine which tables should be tracked
  // The array contains quoted table names like '"users"', so we need to handle that
  const normalizedTableName = `"${tableName}"`;
  
  // Check if the normalized name is in the domain tables
  // Using type casting to handle the type mismatch
  return SERVER_DOMAIN_TABLES.includes(normalizedTableName as any);
}

/**
 * Validates if a WAL change contains the necessary data to be processed.
 * Checks for schema, table, and column data presence.
 */
export function isValidTableChange(
  change: NonNullable<PostgresWALMessage['change']>[number] | undefined,
  lsn: string
): boolean {
  if (!change?.schema || !change?.table) {
    // Skip debug logging for common filter cases
    return false;
  }
  
  // Check if this is a table we should track
  if (!shouldTrackTable(change.table)) {
    return false;
  }

  // For DELETE operations, we don't require column data
  if (change.kind === 'delete') {
    // For deletes, we still need to identify which record was deleted
    if (!change.oldkeys) {
      // Skip detailed debug logging
      return false;
    }
    return true;
  }

  // For INSERT and UPDATE operations, we need column data
  if (!change.columnnames || !change.columnvalues) {
    // Skip detailed debug logging
    return false;
  }

  return true;
}

/**
 * Transforms WAL data into our standardized TableChange format.
 * Returns null for invalid or unparseable changes.
 */
export function transformWALToTableChange(wal: WALData): TableChange | null {
  try {
    // Parse WAL data
    const parsedData = wal.data ? JSON.parse(wal.data) as PostgresWALMessage : null;
    if (!parsedData?.change || !Array.isArray(parsedData.change)) {
      return null;
    }

    // Get the first change
    const change = parsedData.change[0];
    
    // Validate the change structure
    if (!isValidTableChange(change, wal.lsn)) {
      return null;
    }

    // Handle data differently based on operation type
    let data: Record<string, unknown> = {};
    
    if (change.kind === 'delete') {
      // For deletes, use oldkeys to identify the deleted record
      if (change.oldkeys) {
        data = change.oldkeys.keyvalues.reduce((acc: Record<string, unknown>, value: unknown, index: number) => {
          acc[change.oldkeys!.keynames[index]] = value;
          return acc;
        }, {});
      }
    } else {
      // For inserts and updates, use column data
      if (change.columnnames && change.columnvalues) {
        data = change.columnvalues.reduce((acc: Record<string, unknown>, value: unknown, index: number) => {
          acc[change.columnnames![index]] = value;
          return acc;
        }, {});
      }
    }

    // Return in our universal format
    return {
      table: change.table,
      operation: change.kind,
      data,
      lsn: wal.lsn,
      updated_at: (data.updated_at as string) || new Date().toISOString()
    };
  } catch (error) {
    replicationLogger.error('Error transforming WAL data', {
      error: error instanceof Error ? error.message : String(error),
      lsn: wal.lsn
    }, MODULE_NAME);
    return null;
  }
}

/**
 * Transforms an array of WAL changes to TableChange objects.
 * Filters out invalid changes.
 */
export function transformWALChanges(changes: WALData[]): TableChange[] {
  const tableChanges = changes
    .map(transformWALToTableChange)
    .filter((change): change is TableChange => change !== null);
  
  // Count operations by type for logging but don't log here
  // This will be logged in storeChangesInHistory instead
  return tableChanges;
}

/**
 * Stores transformed changes in the change_history table.
 * Returns true if successful, false otherwise.
 */
export async function storeChangesInHistory(
  context: MinimalContext, 
  changes: TableChange[],
  storeBatchSize: number = 100
): Promise<boolean> {
  // Skip if no changes to store
  if (changes.length === 0) {
    return true;
  }
  
  // Count operations by type for summary logging
  const operationCounts: Record<string, number> = {};
  const tables = new Set<string>();
  let lastLSN = '';
  
  for (const change of changes) {
    // Count by operation type
    operationCounts[change.operation] = (operationCounts[change.operation] || 0) + 1;
    
    // Track tables
    tables.add(change.table);
    
    // Track last LSN
    if (!lastLSN || (change.lsn && change.lsn > lastLSN)) {
      lastLSN = change.lsn || '';
    }
  }
  
  try {
    // Get database client
    const client = getDBClient(context);
    await client.connect();
    
    // Start transaction
    await client.query('BEGIN');
    
    // Insert changes in batches to prevent parameter limit issues
    // Use SQL to insert in batches of configured size
    const BATCH_SIZE = storeBatchSize;
    
    for (let i = 0; i < changes.length; i += BATCH_SIZE) {
      const batch = changes.slice(i, i + BATCH_SIZE);
      
      // Build parameterized query for this batch
      const values = batch.map((change, index) => {
        const offset = index * 5;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
      }).join(', ');
      
      const params: any[] = [];
      batch.forEach(change => {
        params.push(
          change.table,
          change.operation,
          JSON.stringify(change.data),
          change.lsn,
          change.updated_at
        );
      });
      
      const query = `
        INSERT INTO change_history 
          (table_name, operation, data, lsn, timestamp) 
        VALUES 
          ${values}
        ON CONFLICT DO NOTHING;
      `;
      
      await client.query(query, params);
    }
    
    // Commit transaction
    await client.query('COMMIT');
    
    // Only log the final result once at debug level instead of info to reduce noise
    replicationLogger.debug('Changes stored', { 
      count: changes.length, 
      operations: operationCounts,
      tables: Array.from(tables),
      lastLSN,
      batchSize: BATCH_SIZE
    }, MODULE_NAME);
    
    return true;
  } catch (error) {
    replicationLogger.error('Store failed', {
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    return false;
  }
}

/**
 * Advances the replication slot by consuming WAL changes.
 * The LSN is updated separately to ensure we don't get stuck if consumption fails.
 */
export async function consumeWALChanges(
  context: MinimalContext,
  stateManager: StateManager,
  slotName: string,
  lastLSN: string,
  walConsumeSize: number = 2000
): Promise<boolean> {
  // Instead of using the sql helper, we'll manage the connection explicitly
  const client = getDBClient(context);
  
  try {
    // Get current LSN for logging
    const currentLSN = await stateManager.getLSN();
    
    // Connect explicitly
    await client.connect();
    
    // Use client directly to consume changes with configurable batch size
    // This larger batch size helps to process more changes at once
    const consumeQuery = `
      SELECT data, lsn, xid 
      FROM pg_logical_slot_get_changes(
        $1,
        NULL,
        NULL,
        'include-xids', '1',
        'include-timestamp', 'true'
      )
      WHERE lsn <= $2::pg_lsn
      LIMIT ${walConsumeSize};
    `;
    
    const result = await client.query(consumeQuery, [slotName, lastLSN]);
    const consumedCount = result.rows.length;
    const reachedLimit = consumedCount >= walConsumeSize;
    
    // Only log at info level for large batches or when we hit the limit
    if (reachedLimit || consumedCount > walConsumeSize / 2) {
      replicationLogger.info('WAL changes consumed (large batch)', {
        count: consumedCount,
        lsn: `${currentLSN} → ${lastLSN}`,
        reachedLimit
      }, MODULE_NAME);
    } else {
      // Otherwise log at debug level to reduce noise
      replicationLogger.debug('WAL changes consumed', {
        count: consumedCount,
        lsn: `${currentLSN} → ${lastLSN}`
      }, MODULE_NAME);
    }
    
    return true;
  } catch (error) {
    replicationLogger.error('Failed to consume WAL changes', {
      error: error instanceof Error ? error.message : String(error),
      lastLSN
    }, MODULE_NAME);
    return false;
  } finally {
    // Ensure connection is always closed, even in case of error
    try {
      await client.end();
    } catch (closeError) {
      replicationLogger.error('Error closing database connection after WAL consumption', {
        error: closeError instanceof Error ? closeError.message : String(closeError),
        slot: slotName
      }, MODULE_NAME);
    }
  }
}

/**
 * Get all active clients directly from KV storage
 * Filters out inactive and stale clients
 */
export async function getActiveClients(env: Env, timeout = 10 * 60 * 1000): Promise<ClientState[]> {
  try {
    const { keys } = await env.CLIENT_REGISTRY.list({ prefix: 'client:' });
    const activeClients: ClientState[] = [];
    const now = Date.now();
    
    for (const key of keys) {
      const value = await env.CLIENT_REGISTRY.get(key.name);
      if (!value) continue;
      
      try {
        const state = JSON.parse(value);
        const clientId = key.name.replace('client:', '');
        const lastSeen = state.lastSeen || 0;
        const timeSinceLastSeen = now - lastSeen;
        
        // Only include active, non-stale clients
        if (state.active && timeSinceLastSeen <= timeout) {
          activeClients.push({
            clientId,
            active: true,
            lastSeen
          });
        }
      } catch (err) {
        replicationLogger.error('Client parse error', {
          key: key.name,
          error: err instanceof Error ? err.message : String(err)
        }, MODULE_NAME);
      }
    }
    
    replicationLogger.debug('Active clients retrieved', { 
      count: activeClients.length 
    }, MODULE_NAME);
    
    return activeClients;
  } catch (error) {
    replicationLogger.error('Client retrieval failed', {
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    return [];
  }
}

/**
 * Check if there are any active clients
 * Fast path to avoid unnecessary processing when no clients are connected
 */
export async function hasActiveClients(env: Env): Promise<boolean> {
  try {
    const activeClients = await getActiveClients(env);
    return activeClients.length > 0;
  } catch (error) {
    replicationLogger.error('Active clients check failed', {
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    return false;
  }
}

/**
 * Broadcasts changes to connected clients directly
 * Uses SyncDO for each active client
 */
export async function broadcastChangesToClients(
  env: Env,
  changes: TableChange[],
  lastLSN: string
): Promise<boolean> {
  try {
    // Skip broadcasting if no changes
    if (changes.length === 0) {
      return true;
    }
    
    // Get active clients to notify about changes
    const activeClients = await getActiveClients(env);
    
    // Only log once at debug level to reduce noise
    replicationLogger.debug('Notifying clients', {
      clientCount: activeClients.length,
      changeCount: changes.length,
      lastLSN
    }, MODULE_NAME);
    
    // Track successful notifications
    let notifiedCount = 0;
    
    // Process each client
    for (const client of activeClients) {
      try {
        // Wake the client's SyncDO using the ClientState
        const { clientId } = client;
        
        // Make request to client's SyncDO for real-time updates
        const clientDoId = env.SYNC.idFromName(`client:${clientId}`);
        const clientDo = env.SYNC.get(clientDoId);
        
        // For Durable Objects, create a proper Request object
        try {
          // Create a new Request object
          const newRequest = new Request(
            `https://internal/new-changes?clientId=${encodeURIComponent(clientId)}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                changes: changes,
                lsn: lastLSN
              })
            }
          );
          
          // Send the request to the Durable Object
          const response = await clientDo.fetch(newRequest);
          
          // Count successful responses
          if (response.status === 200) {
            notifiedCount++;
          }
        } catch (error) {
          replicationLogger.debug('Client notification failed', {
            clientId,
            error: error instanceof Error ? error.message : String(error)
          }, MODULE_NAME);
        }
      } catch (error) {
        // Just count failures, no need to log each one
      }
    }
    
    // Log final broadcast result at debug level
    replicationLogger.debug('Broadcast complete', {
      totalClients: activeClients.length,
      notifiedCount,
      lastLSN
    }, MODULE_NAME);
    
    return true;
  } catch (error) {
    replicationLogger.error('Broadcast failed', {
      error: error instanceof Error ? error.message : String(error),
      changeCount: changes.length
    }, MODULE_NAME);
    return false;
  }
}

/**
 * Process WAL changes from replication slot with a clear linear flow:
 * 1. Transform WAL to TableChanges
 * 2. Store in history
 * 3. Return processed changes for further use
 */
export async function processWALChanges(
  context: MinimalContext,
  changes: WALData[],
  storeBatchSize?: number
): Promise<{ tableChanges: TableChange[], storedSuccessfully: boolean, filteredCount?: number, filterReason?: string }> {
  // Early return for empty changes
  if (!changes || changes.length === 0) {
    return { tableChanges: [], storedSuccessfully: true, filteredCount: 0 };
  }

  // ====== STEP 1: TRANSFORM ======
  // Convert WAL changes to TableChange format and filter invalid ones
  const tableChanges = transformWALChanges(changes);
  
  // Calculate how many changes were filtered out
  const filteredCount = changes.length - tableChanges.length;
  let filterReason = '';
  
  // If many changes were filtered, log this at info level and collect sample data
  if (filteredCount > 0) {
    // Try to determine why changes were filtered
    // This helps diagnose the missing changes issue
    try {
      // Take a sample of filtered changes for analysis
      const sampleWALChange = changes[0];
      const sampleData = sampleWALChange.data ? JSON.parse(sampleWALChange.data) : null;
      
      if (sampleData?.change?.[0]) {
        const changeInfo = sampleData.change[0];
        const table = changeInfo.table;
        const schema = changeInfo.schema;
        
        // Check if table is in our tracking list
        const isTableTracked = shouldTrackTable(table);
        
        if (!isTableTracked) {
          filterReason = `Table ${schema}.${table} not in tracked list`;
        } else if (!changeInfo.columnnames || !changeInfo.columnvalues) {
          filterReason = `Missing column data in ${schema}.${table} changes`;
        } else {
          filterReason = `Unknown filter reason for ${schema}.${table}`;
        }
      } else {
        filterReason = 'Invalid WAL format';
      }
    } catch (error) {
      filterReason = 'Error analyzing filtered changes';
    }
    
    replicationLogger.info('WAL changes filtered', {
      originalCount: changes.length,
      validCount: tableChanges.length,
      filteredCount,
      reason: filterReason
    }, MODULE_NAME);
  }
  
  // Early return if no valid changes after transformation
  if (tableChanges.length === 0) {
    return { tableChanges: [], storedSuccessfully: true, filteredCount, filterReason };
  }
  
  // ====== STEP 2: STORE ======
  // Store the transformed changes in the change_history table
  const storedSuccessfully = await storeChangesInHistory(context, tableChanges, storeBatchSize);
  
  // Return both the changes and storage status for the next step in the pipeline
  return { tableChanges, storedSuccessfully, filteredCount, filterReason };
}

/**
 * Process WAL changes without consuming them, just saving the LSN
 * This is a more efficient version that doesn't consume WAL entries but still
 * tracks the current LSN position for processing purposes
 */
export async function processWALChangesWithoutConsume(
  peekedChanges: WALData[],
  env: Env,
  context: MinimalContext,
  stateManager: StateManager,
  storeBatchSize?: number
): Promise<{ success: boolean, storedChanges: boolean, changeCount?: number, needsMorePolling?: boolean, filteredCount?: number, lastLSN: string }> {
  // Early return if no changes
  if (!peekedChanges || peekedChanges.length === 0) {
    return { success: true, storedChanges: false, needsMorePolling: false, lastLSN: '' };
  }

  // Get the lastLSN from the peeked changes
  const lastLSN = peekedChanges[peekedChanges.length - 1].lsn;
  
  // Check if we likely hit the batch limit (potentially more changes available)
  const likelyMoreChanges = peekedChanges.length >= 1000; // Use a simpler threshold

  try {
    // Transform WAL to TableChanges and store in history
    const { tableChanges, storedSuccessfully, filteredCount } = await processWALChanges(context, peekedChanges, storeBatchSize);
    
    // Determine if this is an LSN-only update (no valid domain table changes)
    const isLSNOnlyUpdate = tableChanges.length === 0;
    
    if (isLSNOnlyUpdate) {
      // Only log at info level after WAL changes are processed
      replicationLogger.info('LSN-only update (no domain table changes)', {
        walCount: peekedChanges.length,
        lsn: lastLSN,
        likelyMoreChanges,
        filteredCount
      }, MODULE_NAME);
      
      // Update the LSN for LSN-only changes
      await stateManager.setLSN(lastLSN);
      
      return { 
        success: true, 
        storedChanges: false, // No domain table changes to store
        changeCount: 0,
        needsMorePolling: likelyMoreChanges,
        filteredCount,
        lastLSN
      };
    }
    
    // If we're here, we have actual domain table changes to process
    
    // If storage wasn't successful, log a warning and update LSN anyway
    if (!storedSuccessfully) {
      replicationLogger.warn('Domain table changes not stored', {
        lsn: lastLSN
      }, MODULE_NAME);
      
      // Still update the LSN to prevent reprocessing the same changes
      await stateManager.setLSN(lastLSN);
      replicationLogger.info('Updated LSN despite storage failure', {
        lsn: lastLSN
      }, MODULE_NAME);
      
      return { 
        success: true, 
        storedChanges: false, 
        changeCount: tableChanges.length,
        needsMorePolling: likelyMoreChanges,
        filteredCount,
        lastLSN
      };
    }
    
    // Update LSN as soon as storage succeeds
    try {
      await stateManager.setLSN(lastLSN);
      replicationLogger.debug('Updated LSN after successful domain table change storage', {
        lsn: lastLSN,
        changeCount: tableChanges.length
      }, MODULE_NAME);
    } catch (lsnError) {
      replicationLogger.error('Failed to update LSN after successful storage', {
        error: lsnError instanceof Error ? lsnError.message : String(lsnError),
        lsn: lastLSN
      }, MODULE_NAME);
      // Continue with the process despite LSN update error
    }
    
    // Broadcast changes to clients with actual domain table changes
    await broadcastChangesToClients(env, tableChanges, lastLSN);
    
    return { 
      success: true, 
      storedChanges: storedSuccessfully,
      changeCount: tableChanges.length,
      needsMorePolling: likelyMoreChanges,
      filteredCount,
      lastLSN
    };
  } catch (error) {
    // Check for the specific "replication slot is active" error
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('replication slot') && errorMsg.includes('is active for PID')) {
      replicationLogger.warn('Replication slot is already in use, skipping this poll cycle', {
        error: errorMsg
      }, MODULE_NAME);
      
      // When this error occurs, we should still consider the operation successful
      // to prevent the polling manager from entering an error state
      return {
        success: true,
        storedChanges: false,
        changeCount: peekedChanges.length,
        needsMorePolling: false,
        filteredCount: 0, // Default value for error case
        lastLSN
      };
    }
    
    // Log other errors
    replicationLogger.error('Error in WAL change processing cycle', {
      error: errorMsg,
      lsn: lastLSN
    }, MODULE_NAME);
    
    return {
      success: false,
      storedChanges: false,
      changeCount: peekedChanges.length,
      needsMorePolling: false,
      filteredCount: 0, // Default value for error case
      lastLSN
    };
  }
}

/**
 * Complete WAL processing workflow: transform, store, update LSN, broadcast
 * This maintains the existing behavior while providing a clear linear flow.
 * Handles LSN-only updates differently from domain table changes.
 */
export async function processAndConsumeWALChanges(
  peekedChanges: WALData[],
  env: Env,
  context: MinimalContext,
  stateManager: StateManager,
  slotName: string,
  walConsumeSize?: number,
  storeBatchSize?: number
): Promise<{ success: boolean, storedChanges: boolean, consumedChanges: boolean, changeCount?: number, needsMorePolling?: boolean, filteredCount?: number }> {
  // Process the changes without consuming WAL
  const result = await processWALChangesWithoutConsume(
    peekedChanges,
    env,
    context,
    stateManager,
    storeBatchSize
  );
  
  // If no changes or processing failed, return early
  if (!result.success || !peekedChanges || peekedChanges.length === 0) {
    return { 
      success: result.success, 
      storedChanges: result.storedChanges, 
      consumedChanges: false,
      changeCount: result.changeCount,
      needsMorePolling: result.needsMorePolling,
      filteredCount: result.filteredCount
    };
  }
  
  // Consuming is now optional and can be done in a separate process
  // For backward compatibility, we'll still consume the WAL here
  // but this can be disabled in the future
  
  let consumedSuccessfully = false;
  
  // Use the provided consume size or default to 2000 if not specified
  const consumeSize = walConsumeSize || 2000;
  
  // Only try to consume WAL if lastLSN is not empty
  if (result.lastLSN) {
    try {
      // Attempt WAL consumption
      consumedSuccessfully = await consumeWALChanges(
        context, 
        stateManager, 
        slotName, 
        result.lastLSN, 
        consumeSize
      );
      
      if (!consumedSuccessfully) {
        replicationLogger.warn('WAL consumption failed, but LSN already updated', {
          lsn: result.lastLSN
        }, MODULE_NAME);
      }
    } catch (consumeError) {
      replicationLogger.error('Error during WAL consumption', {
        error: consumeError instanceof Error ? consumeError.message : String(consumeError),
        lsn: result.lastLSN
      }, MODULE_NAME);
      // Consumption failure is not considered a critical error
    }
  }
  
  return {
    success: result.success,
    storedChanges: result.storedChanges,
    consumedChanges: consumedSuccessfully,
    changeCount: result.changeCount,
    needsMorePolling: result.needsMorePolling,
    filteredCount: result.filteredCount
  };
} 