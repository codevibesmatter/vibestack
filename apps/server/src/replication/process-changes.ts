import type { TableChange } from '@repo/sync-types';
import { ClientManager } from './client-manager';
import { replicationLogger } from '../middleware/logger';
import type { MinimalContext } from '../types/hono';
import type { WALData, PostgresWALMessage } from '../types/wal';
import { sql } from '../lib/db';
import { StateManager } from './state-manager';
import { SERVER_DOMAIN_TABLES } from '@repo/dataforge/server-entities';

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
 *    - The ClientManager broadcasts changes to relevant clients
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
  const shouldTrack = SERVER_DOMAIN_TABLES.includes(normalizedTableName as any);
  
  if (!shouldTrack) {
    replicationLogger.debug('Filtered: Table not in SERVER_DOMAIN_TABLES', {
      table: tableName,
      normalizedName: normalizedTableName
    }, MODULE_NAME);
  }
  
  return shouldTrack;
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
      // Skip debug logging for invalid formats
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
        
        // Only log delete operations in debug mode when troubleshooting specific issues
        // replicationLogger.debug('Processed DELETE operation', {
        //   lsn: wal.lsn,
        //   table: change.table,
        //   keys: Object.keys(data)
        // }, MODULE_NAME);
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
  changes: TableChange[]
): Promise<boolean> {
  if (changes.length === 0) {
    return true;
  }

  // Count operations by type for concise logging
  const ops = changes.reduce((acc: Record<string, number>, change) => {
    acc[change.operation] = (acc[change.operation] || 0) + 1;
    return acc;
  }, {});
  
  // Get unique tables for logging
  const tables = Array.from(new Set(changes.map(c => c.table)));

  // Single informative log for storage start that includes transform info
  replicationLogger.info('Store changes', { 
    count: changes.length,
    ops,
    tables: tables.length > 0 ? tables : []
  }, MODULE_NAME);

  try {
    // Prepare values for a batch insert
    const valueStrings: string[] = [];
    const values: any[] = [];
    let valueIndex = 1;
    
    for (const change of changes) {
      const placeholders = [
        `$${valueIndex++}`, // lsn
        `$${valueIndex++}`, // table_name
        `$${valueIndex++}`, // operation
        `$${valueIndex++}`  // data
      ];
      
      valueStrings.push(`(${placeholders.join(', ')})`);
      
      values.push(
        change.lsn,                // lsn
        change.table,              // table_name
        change.operation,          // operation
        JSON.stringify(change.data) // data
      );
    }
    
    // Execute batch insert
    if (valueStrings.length > 0) {
      const query = `
        INSERT INTO change_history (lsn, table_name, operation, data)
        VALUES ${valueStrings.join(', ')}
        ON CONFLICT DO NOTHING
      `;
      
      await sql(context, query, values);
    }
    
    // Simple completion log - only essential info
    replicationLogger.info('Changes stored', { count: changes.length }, MODULE_NAME);
    return true;
  } catch (error) {
    replicationLogger.error('Store failed', {
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    return false;
  }
}

/**
 * Advances the replication slot and updates the LSN after changes have been stored.
 * Only call this after successfully storing changes to ensure consistency.
 */
export async function consumeWALAndUpdateLSN(
  context: MinimalContext,
  stateManager: StateManager,
  slotName: string,
  lastLSN: string
): Promise<boolean> {
  try {
    // Get current LSN for logging
    const currentLSN = await stateManager.getLSN();
    
    // Use sql helper to consume changes
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
      LIMIT 200;
    `;
    
    const consumeResult = await sql(context, consumeQuery, [slotName, lastLSN]);
    const consumedCount = consumeResult.length;
    
    // Single concise log with LSN transition
    replicationLogger.info('LSN advanced', {
      count: consumedCount,
      lsn: `${currentLSN} → ${lastLSN}`,
      slot: slotName
    }, MODULE_NAME);
    
    // Update the LSN in the state manager
    await stateManager.setLSN(lastLSN);
    
    return true;
  } catch (error) {
    replicationLogger.error('Failed to consume WAL changes', {
      error: error instanceof Error ? error.message : String(error),
      lastLSN
    }, MODULE_NAME);
    return false;
  }
}

/**
 * Broadcasts changes to connected clients via the client manager.
 * This is separated from storage to maintain clear responsibilities.
 */
export async function broadcastChangesToClients(
  clientManager: ClientManager,
  changes: TableChange[]
): Promise<boolean> {
  if (changes.length === 0) {
    return true;
  }
  
  try {
    // Count tables for concise logging
    const tables = Array.from(new Set(changes.map(c => c.table)));
    
    // Single concise log with table count
    replicationLogger.info('Broadcasting', {
      count: changes.length,
      tables: tables.length > 0 ? tables : []
    }, MODULE_NAME);
    
    await clientManager.broadcastChanges(changes);
    return true;
  } catch (error) {
    replicationLogger.error('Broadcast failed', {
      error: error instanceof Error ? error.message : String(error)
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
  changes: WALData[]
): Promise<{ tableChanges: TableChange[], storedSuccessfully: boolean }> {
  // Early return for empty changes
  if (!changes || changes.length === 0) {
    return { tableChanges: [], storedSuccessfully: true };
  }

  // ====== STEP 1: TRANSFORM ======
  // Convert WAL changes to TableChange format and filter invalid ones
  const tableChanges = transformWALChanges(changes);
  
  // Early return if no valid changes after transformation
  if (tableChanges.length === 0) {
    return { tableChanges: [], storedSuccessfully: true };
  }
  
  // ====== STEP 2: STORE ======
  // Store the transformed changes in the change_history table
  const storedSuccessfully = await storeChangesInHistory(context, tableChanges);
  
  // Return both the changes and storage status for the next step in the pipeline
  return { tableChanges, storedSuccessfully };
}

/**
 * Complete WAL processing workflow: transform, store, update LSN, broadcast
 * This maintains the existing behavior while providing a clear linear flow
 */
export async function processAndConsumeWALChanges(
  peekedChanges: WALData[],
  clientManager: ClientManager,
  context: MinimalContext,
  stateManager: StateManager,
  slotName: string
): Promise<{ success: boolean, storedChanges: boolean, consumedChanges: boolean }> {
  // Early return if no changes
  if (!peekedChanges || peekedChanges.length === 0) {
    return { success: true, storedChanges: false, consumedChanges: false };
  }

  // ====== STEP 1: TRANSFORM AND STORE ======
  // Transform WAL to TableChanges and store in history
  const { tableChanges, storedSuccessfully } = await processWALChanges(context, peekedChanges);
  
  // Only proceed to LSN update if storage was successful
  if (!storedSuccessfully) {
    replicationLogger.warn('Changes not stored, skipping WAL consume', {
      lsn: peekedChanges[peekedChanges.length - 1].lsn
    }, MODULE_NAME);
    return { success: true, storedChanges: false, consumedChanges: false };
  }
  
  // ====== STEP 2: UPDATE LSN ======
  // Storage successful - now consume WAL and update LSN
  const lastLSN = peekedChanges[peekedChanges.length - 1].lsn;
  const consumedSuccessfully = await consumeWALAndUpdateLSN(context, stateManager, slotName, lastLSN);
  
  // ====== STEP 3: NOTIFY CLIENTS ======
  // Broadcast changes to clients if there are any valid changes
  if (tableChanges.length > 0) {
    await broadcastChangesToClients(clientManager, tableChanges);
  }
  
  return { 
    success: true, 
    storedChanges: storedSuccessfully, 
    consumedChanges: consumedSuccessfully 
  };
} 