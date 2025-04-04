import type { TableChange } from '@repo/sync-types';
import { replicationLogger } from '../middleware/logger';
import type { MinimalContext } from '../types/hono';
import type { WALData, PostgresWALMessage } from '../types/wal';
import { sql, getDBClient } from '../lib/db';
import { StateManager } from './state-manager';
import { SERVER_DOMAIN_TABLES, SERVER_TABLE_HIERARCHY } from '@repo/dataforge/server-entities';
import type { Env } from '../types/env';

// ====== Types and Interfaces ======
const MODULE_NAME = 'process-changes';

type TableName = keyof typeof SERVER_TABLE_HIERARCHY;

// ====== Constants ======
const DEFAULT_STORE_BATCH_SIZE = 500;

// Create a Set of tracked tables for O(1) lookup performance
const TRACKED_TABLES_SET = new Set(SERVER_DOMAIN_TABLES);

// ====== Helper Functions ======
export function shouldTrackTable(tableName: string): boolean {
  // Remove special case check for change_history as it's not in TRACKED_TABLES_SET anyway
  
  // Normalize the table name (add quotes if missing)
  const normalizedTableName = tableName.startsWith('"') ? tableName : `"${tableName}"`;
  
  // Check if the normalized table name is in our domain tables list using O(1) Set lookup
  return TRACKED_TABLES_SET.has(normalizedTableName as any);
}

// Static list of tracked tables to be logged once on module initialization
const TRACKED_TABLES = SERVER_DOMAIN_TABLES.join(', ');
replicationLogger.info('Replication tracking tables', { 
  count: SERVER_DOMAIN_TABLES.length,
  tables: TRACKED_TABLES
}, MODULE_NAME);

/**
 * Get list of all client IDs from KV
 * Filters out inactive and stale clients (older than 10 minutes)
 */
export async function getAllClientIds(env: Env, timeout = 10 * 60 * 1000): Promise<string[]> {
  try {
    const { keys } = await env.CLIENT_REGISTRY.list({ prefix: 'client:' });
    const clientIds: string[] = [];
    const now = Date.now();
    let removedCount = 0;
    
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
          clientIds.push(clientId);
        } else {
          // Clean up inactive or stale clients
          await env.CLIENT_REGISTRY.delete(key.name);
          removedCount++;
        }
      } catch (err) {
        replicationLogger.error('Client parse error', {
          key: key.name
        }, MODULE_NAME);
      }
    }
    
    // Log summary instead of individual client details
    if (removedCount > 0) {
      replicationLogger.debug('Removed inactive clients', { 
        count: removedCount,
        remaining: clientIds.length 
      }, MODULE_NAME);
    }
    
    return clientIds;
  } catch (error) {
    replicationLogger.error('Client retrieval failed', {
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    return [];
  }
}

// ====== Core Processing Functions ======
export function transformWALChanges(changes: WALData[]): { 
  tableChanges: TableChange[], 
  filteredReasons: Record<string, number> 
} {
  const tableChanges: TableChange[] = [];
  const filteredReasons: Record<string, number> = {};
  // Track change count per WAL entry to improve logging
  let totalChangesInWAL = 0;
  // Track changes by table and operation for summary logging
  const changesByTable: Record<string, Record<string, number>> = {};

  // Simple count only
  replicationLogger.debug(`Processing ${changes.length} WAL entries`, {}, MODULE_NAME);

  for (const wal of changes) {
    // Early filtering: Skip entries with no data
    if (!wal.data) {
      addFilterReason(filteredReasons, 'No WAL data');
      continue;
    }

    // Fast pre-check before parsing JSON
    if (!wal.data.includes('"table"')) {
      addFilterReason(filteredReasons, 'No table data in WAL entry');
      continue;
    }
    
    let parsedData: PostgresWALMessage;
    
    // Isolated JSON parsing in its own try/catch
    try {
      parsedData = JSON.parse(wal.data) as PostgresWALMessage;
    } catch (error) {
      addFilterReason(filteredReasons, `JSON parse error: ${error instanceof Error ? error.message : String(error)}`);
      replicationLogger.error('WAL JSON parse error', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      continue;
    }
    
    // Structure validation after parsing
    if (!parsedData?.change || !Array.isArray(parsedData.change)) {
      addFilterReason(filteredReasons, 'Invalid WAL data structure');
      continue;
    }

    // Count total changes for metrics
    totalChangesInWAL += parsedData.change.length;
    
    // Process changes with early table filtering
    for (const change of parsedData.change) {
      try {
        // Quick structural validation
        if (!change?.schema || !change?.table) {
          addFilterReason(filteredReasons, 'Missing schema or table');
          continue;
        }
        
        // Early table tracking check
        if (!shouldTrackTable(change.table)) {
          addFilterReason(filteredReasons, `Table ${change.table} not in tracked tables`);
          continue;
        }

        // Track for summary stats
        if (!changesByTable[change.table]) {
          changesByTable[change.table] = {};
        }
        if (!changesByTable[change.table][change.kind]) {
          changesByTable[change.table][change.kind] = 0;
        }
        changesByTable[change.table][change.kind]++;

        // Extract data efficiently
        const data: Record<string, unknown> = {};
        
        // Column data extraction
        if (change.columnnames && Array.isArray(change.columnnames) && 
            change.columnvalues && Array.isArray(change.columnvalues)) {
          const colCount = Math.min(change.columnnames.length, change.columnvalues.length);
          
          for (let i = 0; i < colCount; i++) {
            data[change.columnnames[i]] = change.columnvalues[i];
          }
        }
        
        // Oldkeys extraction for deletes
        if (change.kind === 'delete' && change.oldkeys && 
            change.oldkeys.keynames && Array.isArray(change.oldkeys.keynames) && 
            change.oldkeys.keyvalues && Array.isArray(change.oldkeys.keyvalues)) {
          const keyCount = Math.min(change.oldkeys.keynames.length, change.oldkeys.keyvalues.length);
          
          for (let i = 0; i < keyCount; i++) {
            data[change.oldkeys.keynames[i]] = change.oldkeys.keyvalues[i];
          }
        }
        
        // Set timestamp - either from the data or current time
        const timestamp = 
          (data.updated_at as string) || 
          new Date().toISOString();

        // Add to result array
        tableChanges.push({
          table: change.table,
          operation: change.kind,
          data,
          lsn: wal.lsn,
          updated_at: timestamp
        });
      } catch (error) {
        // More focused error handling at the change level
        addFilterReason(
          filteredReasons, 
          `Error processing change: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  // Only log detailed transformation results when there are actual changes or errors
  if (tableChanges.length > 0 || Object.keys(filteredReasons).length > 0) {
    // Extract table names from filtered reasons
    const filteredTables = Object.keys(filteredReasons)
      .filter(reason => reason.includes('Table '))
      .map(reason => {
        const match = reason.match(/Table ([^ ]+) not in tracked/);
        return match ? match[1] : null;
      })
      .filter(Boolean);
    
    // Combine kept tables and filtered tables for reporting
    const keptTables = tableChanges.length > 0 ? 
      [...new Set(tableChanges.map(c => c.table))] : [];
    
    // Create a summary of operations by table
    const tableOperationSummary = Object.entries(changesByTable).map(([table, ops]) => {
      const opSummary = Object.entries(ops)
        .map(([op, count]) => `${op}:${count}`)
        .join(',');
      return `${table}(${opSummary})`;
    }).join('; ');
    
    // Improved logging to show both WAL entries and actual entity changes
    replicationLogger.info('WAL transformation results', {
      walEntries: changes.length,
      entityChangesInWAL: totalChangesInWAL,
      keptChanges: tableChanges.length,
      filtered: totalChangesInWAL - tableChanges.length,
      tables: tableOperationSummary,
      keptTables: keptTables.length > 0 ? keptTables.join(',') : 'none',
      filteredTables: filteredTables.length > 0 ? filteredTables.join(',') : 'none',
      reasons: Object.keys(filteredReasons).length > 0 ? filteredReasons : undefined
    }, MODULE_NAME);
  }

  return { tableChanges, filteredReasons };
}

function addFilterReason(reasons: Record<string, number>, reason: string) {
  reasons[reason] = (reasons[reason] || 0) + 1;
}

export async function storeChangesInHistory(
  context: MinimalContext, 
  changes: TableChange[],
  storeBatchSize: number = DEFAULT_STORE_BATCH_SIZE
): Promise<boolean> {
  if (changes.length === 0) {
    return true;
  }
  
  // Group by table for better logging
  const tableGroups = changes.reduce((acc: Record<string, number>, change) => {
    acc[change.table] = (acc[change.table] || 0) + 1;
    return acc;
  }, {});
  
  // Format for concise logging
  const tablesStr = Object.entries(tableGroups)
    .map(([table, count]) => `${table}:${count}`)
    .join(',');
  
  // Single log at start with essential info
  replicationLogger.info('Storing changes', {
    count: changes.length,
    tables: tablesStr
  }, MODULE_NAME);
  
  const client = getDBClient(context);
  let connected = false;
  
  try {
    await client.connect();
    connected = true;
    
    // Use a single transaction for all batches
    await client.query('BEGIN');
    
    // Track success count
    let successCount = 0;
    let failureCount = 0;
    const totalBatches = Math.ceil(changes.length / storeBatchSize);
    
    for (let i = 0; i < changes.length; i += storeBatchSize) {
      const batch = changes.slice(i, i + storeBatchSize);
      
      // Create a multi-row insert with parameterized values
      const valueRows = batch.map((_, idx) => {
        const base = idx * 5;
        return `($${base + 1}, $${base + 2}, $${base + 3}::jsonb, $${base + 4}, $${base + 5}::timestamptz)`;
      }).join(',\n');
      
      const params: any[] = [];
      batch.forEach(change => {
        const timestamp = (change.data as any).updated_at || new Date().toISOString();
        
        params.push(
          change.table,
          change.operation,
          JSON.stringify(change.data),
          change.lsn,
          timestamp
        );
      });
      
      // Execute the multi-row insert in a single query
      const query = `
        INSERT INTO change_history 
          (table_name, operation, data, lsn, timestamp) 
        VALUES 
          ${valueRows};
      `;
      
      try {
        await client.query(query, params);
        successCount += batch.length;
      } catch (insertError) {
        failureCount += batch.length;
        replicationLogger.error('Batch insert error', {
          batchSize: batch.length,
          error: insertError instanceof Error ? insertError.message : String(insertError),
          batchNumber: Math.floor(i / storeBatchSize) + 1
        }, MODULE_NAME);
        
        // Continue with next batch - we'll commit what succeeded
      }
    }
    
    // Commit the transaction
    await client.query('COMMIT');
    
    // Single log at end with summary results
    replicationLogger.info('Changes stored', { 
      success: successCount,
      failed: failureCount,
      totalBatches
    }, MODULE_NAME);
    
    return successCount > 0;
  } catch (error) {
    // If we have an open transaction, roll it back
    if (connected) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // Ignore rollback errors
      }
    }
    
    replicationLogger.error('Store changes failed', {
      count: changes.length,
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    
    return false;
  } finally {
    // Always ensure we close the connection
    if (connected) {
      try {
        await client.end();
      } catch (endError) {
        replicationLogger.error('DB connection close error', {}, MODULE_NAME);
      }
    }
  }
}

// ====== Main Process Function ======
export async function processChanges(
  changes: WALData[],
  env: Env,
  context: MinimalContext,
  stateManager: StateManager,
  storeBatchSize?: number
): Promise<{ success: boolean, storedChanges: boolean, changeCount?: number, filteredCount?: number, lastLSN: string }> {
  if (!changes || changes.length === 0) {
    return { success: true, storedChanges: false, lastLSN: '' };
  }

  const lastLSN = changes[changes.length - 1].lsn;
  const startTime = Date.now();

  try {
    // Step 1: Transform
    // Reduced to a single debug log
    replicationLogger.debug(`Processing ${changes.length} WAL entries`, {}, MODULE_NAME);
    const { tableChanges, filteredReasons } = transformWALChanges(changes);
    const filteredCount = changes.length - tableChanges.length;
    
    // Only log filtering info if there are actual changes or non-expected filters
    const hasImportantFilters = Object.keys(filteredReasons).some(r => 
      !r.includes('Intentionally skipping change_history')
    );
    
    if (hasImportantFilters) {
      replicationLogger.info('Changes filtered', {
        valid: tableChanges.length,
        filtered: filteredCount,
        reasons: filteredReasons
      }, MODULE_NAME);
    }
    
    if (tableChanges.length === 0) {
      // Only log for non-change_history updates to reduce noise
      if (hasImportantFilters) {
        replicationLogger.info('No valid changes to process, updating LSN', {
          lastLSN
        }, MODULE_NAME);
      }
      
      await stateManager.setLSN(lastLSN);
      return { 
        success: true, 
        storedChanges: false,
        changeCount: 0,
        filteredCount,
        lastLSN
      };
    }

    // Step 2: Store raw changes in history 
    const storedSuccessfully = await storeChangesInHistory(context, tableChanges, storeBatchSize);
    
    if (!storedSuccessfully) {
      replicationLogger.warn('Failed to store changes', {
        lastLSN
      }, MODULE_NAME);
      
      await stateManager.setLSN(lastLSN);
      return { 
        success: true, 
        storedChanges: false, 
        changeCount: tableChanges.length,
        filteredCount,
        lastLSN
      };
    }

    // Step 3: Update LSN
    try {
      await stateManager.setLSN(lastLSN);
    } catch (lsnError) {
      replicationLogger.error('LSN update failed', { lsn: lastLSN }, MODULE_NAME);
    }
    
    // Step 4: Notify clients about new changes
    try {
      const clientIds = await getAllClientIds(env);
      
      // Skip logging if no clients to notify
      if (clientIds.length === 0) {
        return { 
          success: true, 
          storedChanges: storedSuccessfully,
          changeCount: tableChanges.length,
          filteredCount,
          lastLSN
        };
      }
      
      // Single log at start of notification with client count only
      replicationLogger.info('Notifying clients in parallel', {
        count: clientIds.length
      }, MODULE_NAME);
      
      // Process all clients in parallel
      const results = await Promise.all(
        clientIds.map(async (clientId) => {
          try {
            const clientDoId = env.SYNC.idFromName(`client:${clientId}`);
            const clientDo = env.SYNC.get(clientDoId);
            
            const response = await clientDo.fetch(
              `https://internal/new-changes?clientId=${encodeURIComponent(clientId)}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lsn: lastLSN })
              }
            );
            
            return { 
              clientId, 
              success: response.status === 200,
              error: response.status !== 200 ? `Status ${response.status}` : undefined
            };
          } catch (error) {
            return { 
              clientId, 
              success: false, 
              error: error instanceof Error ? error.message : String(error)
            };
          }
        })
      );
      
      // Process results
      const successCount = results.filter(r => r.success).length;
      const failureCount = results.length - successCount;
      const failedClients = results.filter(r => !r.success).map(r => r.clientId);
      
      // Log any failures individually
      results.filter(r => !r.success).forEach(result => {
        replicationLogger.warn('Client notify failed', {
          clientId: result.clientId,
          error: result.error
        }, MODULE_NAME);
      });
      
      // Summary log
      replicationLogger.info('Client notifications completed', {
        success: successCount,
        failed: failureCount,
        failedClients: failedClients.length > 0 ? failedClients : undefined
      }, MODULE_NAME);
    } catch (notifyError) {
      replicationLogger.error('Client notification process failed', {
        error: notifyError instanceof Error ? notifyError.message : String(notifyError)
      }, MODULE_NAME);
    }
    
    return { 
      success: true, 
      storedChanges: storedSuccessfully,
      changeCount: tableChanges.length,
      filteredCount,
      lastLSN
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    if (errorMsg.includes('replication slot') && errorMsg.includes('is active for PID')) {
      return {
        success: true,
        storedChanges: false,
        changeCount: changes.length,
        filteredCount: 0,
        lastLSN
      };
    }
    
    replicationLogger.error('Changes processing failed', {
      lsn: lastLSN,
      error: errorMsg
    }, MODULE_NAME);
    
    return {
      success: false,
      storedChanges: false,
      changeCount: changes.length,
      filteredCount: 0,
      lastLSN
    };
  }
} 