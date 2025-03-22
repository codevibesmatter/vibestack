import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { TableChange } from '@repo/sync-types';
import { ClientManager } from './client-manager';
import { replicationLogger } from '../middleware/logger';
import type { MinimalContext } from '../types/hono';
import type { WALData, PostgresWALMessage } from '../types/wal';
import { getDBClient, sql } from '../lib/db';
import { ChangeHistory } from '@repo/dataforge/entities/ChangeHistory';
import { StateManager } from './state-manager';

const MODULE_NAME = 'changes';

/**
 * Module for change processing and WAL management
 * 
 * Architectural responsibilities:
 * 1. PollingManager - Handles timing of polling cycles and peeking at WAL changes
 * 2. Changes module - Processes changes, stores them in change_history, and advances the LSN
 * 
 * Key principle: The LSN should only be advanced when changes have been successfully
 * stored in the change_history table. This prevents data loss if storing fails.
 */

/**
 * Validates if a WAL change should be processed based on our filtering rules.
 */
export function isValidTableChange(
  change: NonNullable<PostgresWALMessage['change']>[number] | undefined,
  lsn: string
): boolean {
  if (!change?.schema || !change?.table) {
    replicationLogger.debug('Filtered: Missing schema or table', {
      lsn,
      hasSchema: !!change?.schema,
      hasTable: !!change?.table
    }, MODULE_NAME);
    return false;
  }

  if (!change.columnnames || !change.columnvalues) {
    replicationLogger.debug('Filtered: Missing column data', {
      lsn,
      table: change.table,
      hasColumnNames: !!change.columnnames,
      hasColumnValues: !!change.columnvalues
    }, MODULE_NAME);
    return false;
  }

  return true;
}

/**
 * Transform WAL data to our universal TableChange format
 */
export function transformWALToTableChange(wal: WALData): TableChange | null {
  try {
    // Parse WAL data
    const parsedData = wal.data ? JSON.parse(wal.data) as PostgresWALMessage : null;
    if (!parsedData?.change || !Array.isArray(parsedData.change)) {
      replicationLogger.debug('Invalid WAL data format', { 
        lsn: wal.lsn,
        hasData: !!wal.data,
        dataLength: wal.data?.length || 0,
        dataPreview: wal.data ? wal.data.substring(0, 100) : 'null' 
      }, MODULE_NAME);
      return null;
    }

    // Get the first change
    const change = parsedData.change[0];
    
    // Use centralized filtering logic
    if (!isValidTableChange(change, wal.lsn)) {
      replicationLogger.debug('WAL change filtered out by validation', {
        lsn: wal.lsn,
        schema: change?.schema,
        table: change?.table,
        kind: change?.kind,
        hasColumns: !!(change?.columnnames && change?.columnvalues),
        columnCount: change?.columnnames?.length || 0
      }, MODULE_NAME);
      return null;
    }

    // Transform to structured format
    const data = change.columnvalues?.reduce((acc: Record<string, unknown>, value: unknown, index: number) => {
      acc[change.columnnames[index]] = value;
      return acc;
    }, {});

    // Log the transformation
    replicationLogger.debug('WAL transformed to TableChange', {
      lsn: wal.lsn,
      table: change.table,
      operation: change.kind,
      columnCount: Object.keys(data).length
    }, MODULE_NAME);

    // Return in our universal format
    return {
      table: change.table,
      operation: change.kind,
      data,
      lsn: wal.lsn,
      updated_at: data.updated_at as string || new Date().toISOString()
    };
  } catch (error) {
    replicationLogger.error('Error transforming WAL data', {
      error: error instanceof Error ? error.message : String(error),
      lsn: wal.lsn,
      dataPreview: wal.data ? wal.data.substring(0, 100) : 'null'
    }, MODULE_NAME);
    return null;
  }
}

/**
 * Process WAL changes from replication slot and store them in the change_history table
 * @returns When called with a client manager, returns { success: boolean } indicating whether changes were stored. 
 *          When called with just a context, returns the processed changes.
 */
export async function processWALChanges(
  changes: WALData[],
  clientManagerOrContext: ClientManager | MinimalContext,
  context?: MinimalContext
): Promise<TableChange[] | { success: boolean, storedChanges: boolean }> {
  // Determine if this is a client manager or context call
  const isClientManagerCall = clientManagerOrContext instanceof ClientManager;
  const clientManager = isClientManagerCall ? clientManagerOrContext as ClientManager : undefined;
  const ctx = isClientManagerCall ? context : clientManagerOrContext as MinimalContext;
  
  // Log processing details
  const loggingContext = {
    count: changes.length,
    tables: Array.from(new Set(changes.map(c => c.data ? JSON.parse(c.data).change?.[0]?.table : undefined).filter(Boolean))),
    lsnRange: changes.length > 0 ? `${changes[0].lsn} → ${changes[changes.length - 1].lsn}` : 'empty',
    hasContext: !!ctx,
    hasClientManager: !!clientManager,
    contextType: ctx ? typeof ctx : 'undefined'
  };

  replicationLogger.info('Processing WAL changes', loggingContext, MODULE_NAME);
  
  if (!changes || changes.length === 0) {
    replicationLogger.info('No WAL changes to process', {}, MODULE_NAME);
    return isClientManagerCall ? { success: true, storedChanges: false } : [];
  }

  // Transform WAL messages to table changes
  const tableChanges = changes
    .map(transformWALToTableChange)
    .filter((change): change is TableChange => change !== null);

  replicationLogger.info('WAL changes transformed', {
    originalCount: changes.length,
    transformedCount: tableChanges.length,
    filteredOutCount: changes.length - tableChanges.length,
    tables: Array.from(new Set(tableChanges.map(c => c.table)))
  }, MODULE_NAME);

  if (tableChanges.length === 0) {
    replicationLogger.info('No valid table changes after transformation', {}, MODULE_NAME);
    return isClientManagerCall ? { success: true, storedChanges: false } : [];
  }

  // Track if changes were successfully stored
  let changesStored = false;

  // Store changes in history table if we have a context
  if (ctx) {
    replicationLogger.info('Context present, will attempt to store changes', {
      contextKeys: ctx ? Object.keys(ctx) : [],
      hasEnv: ctx && ctx.env ? true : false
    }, MODULE_NAME);
    
    try {
      await storeChangesInHistory(ctx, tableChanges);
      changesStored = true;
      replicationLogger.debug('Stored changes in history', {
        count: tableChanges.length,
        lsnRange: changes.length > 0 ? `${changes[0].lsn} → ${changes[changes.length - 1].lsn}` : 'empty'
      }, MODULE_NAME);
    } catch (error) {
      // Log error but continue with change processing
      changesStored = false;
      replicationLogger.error('Failed to store changes in history', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        count: tableChanges.length
      }, MODULE_NAME);
    }
  } else {
    replicationLogger.warn('No context provided, skipping history storage', {}, MODULE_NAME);
  }

  // If this is a client manager call, process for clients
  if (isClientManagerCall && clientManager) {
    try {
      // Send changes to connected clients
      if (tableChanges.length > 0) {
        replicationLogger.info('Broadcasting changes to clients', {
          count: tableChanges.length
        }, MODULE_NAME);
        await clientManager.broadcastChanges(tableChanges);
      }
    } catch (error) {
      replicationLogger.error('Error broadcasting changes to clients', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
    }
    return { success: true, storedChanges: changesStored };
  }
  
  // Return the processed changes when called with just a context
  return tableChanges;
}

/**
 * Store processed changes in the change_history table
 */
async function storeChangesInHistory(context: MinimalContext, changes: TableChange[]): Promise<void> {
  replicationLogger.info('storeChangesInHistory called', { changeCount: changes.length }, MODULE_NAME);
  
  if (changes.length === 0) {
    replicationLogger.debug('No changes to store in history', {}, MODULE_NAME);
    return;
  }

  replicationLogger.info('Storing changes in history table', { 
    count: changes.length,
    tables: Array.from(new Set(changes.map(c => c.table))),
    operations: Array.from(new Set(changes.map(c => c.operation))),
    firstChangeLSN: changes[0]?.lsn,
    firstChangeData: changes[0]?.data ? JSON.stringify(changes[0]?.data).substring(0, 100) : 'null'
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
        change.lsn,                                // lsn
        change.table,                              // table_name
        change.operation,                          // operation
        JSON.stringify(change.data)                // data
      );
    }
    
    // Execute batch insert
    if (valueStrings.length > 0) {
      const query = `
        INSERT INTO change_history (lsn, table_name, operation, data)
        VALUES ${valueStrings.join(', ')}
        ON CONFLICT DO NOTHING
      `;
      
      replicationLogger.debug('Executing insert query', { 
        query: query.substring(0, 100) + '...',
        valueCount: values.length
      }, MODULE_NAME);
      
      try {
        // Use the sql helper function that handles connections automatically
        await sql(context, query, values);
        replicationLogger.debug('Inserted changes into history table', { 
          rowsAffected: changes.length
        }, MODULE_NAME);
      } catch (insertErr) {
        replicationLogger.error('Insert query failed', {
          error: insertErr instanceof Error ? insertErr.message : String(insertErr),
          stack: insertErr instanceof Error ? insertErr.stack : undefined,
          query: query.substring(0, 100) + '...'
        }, MODULE_NAME);
        throw insertErr;
      }
    }
    
    replicationLogger.info('Changes stored in history table', { count: changes.length }, MODULE_NAME);
  } catch (error) {
    replicationLogger.error('Failed to store changes in history table', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }, MODULE_NAME);
    throw error;
  }
}

/**
 * Process WAL changes from replication slot, store them in the change_history table,
 * and advance the LSN if successful.
 * 
 * This combines the responsibility of:
 * 1. Consuming WAL changes (advancing the LSN)
 * 2. Processing changes to our TableChange format
 * 3. Storing changes in the change_history table
 * 4. Broadcasting changes to clients
 */
export async function processAndConsumeWALChanges(
  peekedChanges: WALData[],
  clientManager: ClientManager,
  context: MinimalContext,
  stateManager: StateManager,
  slotName: string
): Promise<{ success: boolean, storedChanges: boolean, consumedChanges: boolean }> {
  // If no changes, nothing to do
  if (!peekedChanges || peekedChanges.length === 0) {
    replicationLogger.info('No WAL changes to process', {}, MODULE_NAME);
    return { success: true, storedChanges: false, consumedChanges: false };
  }

  // First process the changes without advancing LSN
  replicationLogger.info('Processing peeked WAL changes', { 
    count: peekedChanges.length,
    lsnRange: peekedChanges.length > 0 ? `${peekedChanges[0].lsn} → ${peekedChanges[peekedChanges.length - 1].lsn}` : 'empty'
  }, MODULE_NAME);
  
  const result = await processWALChanges(peekedChanges, clientManager, context);
  
  // Check if changes were successfully stored
  if (!('storedChanges' in result) || !result.storedChanges) {
    replicationLogger.warn('Changes were not successfully stored, not consuming WAL changes', {
      lsnRange: peekedChanges.length > 0 ? `${peekedChanges[0].lsn} → ${peekedChanges[peekedChanges.length - 1].lsn}` : 'empty'
    }, MODULE_NAME);
    return { success: true, storedChanges: 'storedChanges' in result ? result.storedChanges : false, consumedChanges: false };
  }
  
  // If we made it here, changes were stored successfully - now we can consume the WAL changes
  try {
    // Get the current LSN
    const currentLSN = await stateManager.getLSN();
    
    // Get the last LSN from the peeked changes
    const lastLSN = peekedChanges[peekedChanges.length - 1].lsn;
    
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
    
    // Use the sql helper function that handles connections automatically
    const consumeResult = await sql(context, consumeQuery, [slotName, lastLSN]);
    const consumedCount = consumeResult.length;
    
    replicationLogger.info('Consumed WAL changes and advanced LSN', {
      consumedCount,
      newLSN: lastLSN,
      previousLSN: currentLSN,
      slotName
    }, MODULE_NAME);
    
    // Update the LSN in the state manager
    await stateManager.setLSN(lastLSN);
    
    return { success: true, storedChanges: true, consumedChanges: true };
  } catch (error) {
    replicationLogger.error('Failed to consume WAL changes', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }, MODULE_NAME);
    return { success: false, storedChanges: true, consumedChanges: false };
  }
}