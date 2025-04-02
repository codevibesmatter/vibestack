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
const DEFAULT_STORE_BATCH_SIZE = 100;
const DEFAULT_CHUNK_SIZE = 500; // Added for chunking broadcasts

// ====== Helper Functions ======
export function shouldTrackTable(tableName: string): boolean {
  if (tableName === 'change_history') {
    // Don't log this at all - it's too noisy and expected behavior
    return false;
  }
  
  // First normalize the table name (add quotes if missing)
  const normalizedTableName = tableName.startsWith('"') ? tableName : `"${tableName}"`;
  
  // Check if the normalized table name is in our domain tables list
  const isTracked = SERVER_DOMAIN_TABLES.includes(normalizedTableName as any);
  
  replicationLogger.debug('Checking if table should be tracked', {
    originalTableName: tableName,
    normalizedTableName,
    isTracked,
    allDomainTables: SERVER_DOMAIN_TABLES
  }, MODULE_NAME);
  
  return isTracked;
}

/**
 * Get list of all client IDs from KV
 * Filters out inactive and stale clients (older than 10 minutes)
 */
export async function getAllClientIds(env: Env, timeout = 10 * 60 * 1000): Promise<string[]> {
  try {
    const { keys } = await env.CLIENT_REGISTRY.list({ prefix: 'client:' });
    const clientIds: string[] = [];
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
          clientIds.push(clientId);
        } else {
          // Clean up inactive or stale clients
          await env.CLIENT_REGISTRY.delete(key.name);
          // Log only client ID and time since last seen to reduce verbosity
          replicationLogger.debug('Cleaned up inactive client', {
            clientId,
            inactiveSecs: Math.round(timeSinceLastSeen / 1000)
          }, MODULE_NAME);
        }
      } catch (err) {
        replicationLogger.error('Client parse error', {
          key: key.name
        }, MODULE_NAME);
      }
    }
    
    // Only log the count at debug level
    replicationLogger.debug('Active clients retrieved', { count: clientIds.length }, MODULE_NAME);
    
    return clientIds;
  } catch (error) {
    replicationLogger.error('Client retrieval failed', {}, MODULE_NAME);
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
  // Track which tables we've already logged for this batch
  const loggedTables = new Set<string>();

  // Simple count only
  replicationLogger.debug(`Processing ${changes.length} WAL entries`, {}, MODULE_NAME);

  for (const wal of changes) {
    try {
      const parsedData = wal.data ? JSON.parse(wal.data) as PostgresWALMessage : null;
      if (!parsedData?.change || !Array.isArray(parsedData.change)) {
        addFilterReason(filteredReasons, 'Invalid WAL data structure');
        continue;
      }

      // Count total changes in this WAL entry for better logging
      totalChangesInWAL += parsedData.change.length;
      
      // Reset logged tables for this WAL entry
      loggedTables.clear();
      
      // Process ALL changes in the WAL entry - this is the key fix
      for (const change of parsedData.change) {
        if (!change?.schema || !change?.table) {
          addFilterReason(filteredReasons, 'Missing schema or table');
          continue;
        }
        
        // Only log non-change_history tables to reduce noise, and only log once per table type per WAL entry
        if (change.table !== 'change_history' && !loggedTables.has(change.table)) {
          replicationLogger.debug(`Processing ${change.kind} on ${change.table}`, {}, MODULE_NAME);
          loggedTables.add(change.table);
        }
        
        if (!shouldTrackTable(change.table)) {
          // Use a clearer message for change_history table but don't log it
          if (change.table === 'change_history') {
            addFilterReason(filteredReasons, 'Intentionally skipping change_history table (expected)');
          } else {
            addFilterReason(filteredReasons, `Table ${change.table} not in tracked tables`);
            // Only log non-tracked tables once per WAL entry
            if (!loggedTables.has(`skip:${change.table}`)) {
              replicationLogger.debug(`Skipping non-tracked table: ${change.table}`, {}, MODULE_NAME);
              loggedTables.add(`skip:${change.table}`);
            }
          }
          continue;
        }

        // Only log when keeping a domain table change - minimal info and only once per table type
        if (!loggedTables.has(`keep:${change.table}`)) {
          replicationLogger.debug(`Keeping ${change.kind} on ${change.table}`, {}, MODULE_NAME);
          loggedTables.add(`keep:${change.table}`);
        }

        if (change.kind === 'delete') {
          if (!change.oldkeys) {
            addFilterReason(filteredReasons, 'Delete operation missing oldkeys');
            continue;
          }
        } else {
          if (!change.columnnames || !change.columnvalues) {
            addFilterReason(filteredReasons, 'Insert/Update operation missing column data');
            continue;
          }
        }

        let data: Record<string, unknown> = {};
        
        if (change.kind === 'delete') {
          if (change.oldkeys) {
            data = change.oldkeys.keyvalues.reduce((acc: Record<string, unknown>, value: unknown, index: number) => {
              acc[change.oldkeys!.keynames[index]] = value;
              return acc;
            }, {});
          }
        } else {
          if (change.columnnames && change.columnvalues) {
            data = change.columnvalues.reduce((acc: Record<string, unknown>, value: unknown, index: number) => {
              acc[change.columnnames![index]] = value;
              return acc;
            }, {});
          }
        }

        const timestamp = data.updated_at as string || new Date().toISOString();

        tableChanges.push({
          table: change.table,
          operation: change.kind,
          data,
          lsn: wal.lsn,
          updated_at: timestamp
        });
      }
    } catch (error) {
      addFilterReason(filteredReasons, 
        `Error transforming WAL data: ${error instanceof Error ? error.message : String(error)}`
      );
      
      replicationLogger.error('WAL transform error', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
    }
  }

  // Only log detailed transformation results when there are actual changes or errors
  if (tableChanges.length > 0 || Object.keys(filteredReasons).length > 0) {
    // Extract table names from filtered reasons
    const filteredTables = Object.keys(filteredReasons)
      .filter(reason => reason.includes('Table ') || reason.includes('change_history'))
      .map(reason => {
        if (reason.includes('change_history')) return 'change_history';
        const match = reason.match(/Table ([^ ]+) not in tracked/);
        return match ? match[1] : null;
      })
      .filter(Boolean);
    
    // Combine kept tables and filtered tables for reporting
    const keptTables = tableChanges.length > 0 ? 
      [...new Set(tableChanges.map(c => c.table))] : [];
    
    // Group changes by table and operation for more concise logging
    const changesByTable: Record<string, Record<string, number>> = {};
    tableChanges.forEach(change => {
      if (!changesByTable[change.table]) {
        changesByTable[change.table] = {};
      }
      if (!changesByTable[change.table][change.operation]) {
        changesByTable[change.table][change.operation] = 0;
      }
      changesByTable[change.table][change.operation]++;
    });
    
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
      filteredTables: (filteredTables.length > 0 && filteredTables[0] !== 'change_history') ? 
                      filteredTables.filter(t => t !== 'change_history').join(',') : 
                      'none',
      reasons: Object.keys(filteredReasons).length > 0 && 
               Object.keys(filteredReasons).some(r => !r.includes('change_history')) ? 
               Object.fromEntries(
                 Object.entries(filteredReasons)
                   .filter(([key]) => !key.includes('change_history'))
               ) : undefined
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
  
  replicationLogger.info('Storing changes', {
    count: changes.length,
    tables: tablesStr
  }, MODULE_NAME);
  
  const client = getDBClient(context);
  let connected = false;
  
  try {
    await client.connect();
    connected = true;
    
    // Track success count
    let successCount = 0;
    let batchNumber = 0;
    const totalBatches = Math.ceil(changes.length / storeBatchSize);
    
    for (let i = 0; i < changes.length; i += storeBatchSize) {
      batchNumber++;
      const batch = changes.slice(i, i + storeBatchSize);
      
      const values = batch.map((change, index) => {
        const baseIndex = index * 5;
        return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}::timestamptz)`;
      }).join(', ');
      
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
      
      // Simple direct insert without transaction
      const query = `
        INSERT INTO change_history 
          (table_name, operation, data, lsn, timestamp) 
        VALUES 
          ${values};
      `;
      
      try {
        await client.query(query, params);
        successCount += batch.length;
        
        // Only log batch progress at debug level with minimal info
        // Skip logging individual batches if there's only one batch
        if (totalBatches > 1) {
          replicationLogger.debug('Batch inserted', { 
            batchNumber,
            totalBatches,
            batchSize: batch.length,
            progress: `${successCount}/${changes.length}`
          }, MODULE_NAME);
        }
      } catch (insertError) {
        // Log minimal info for batch errors
        replicationLogger.error('Batch insert error', {
          batchNumber,
          batchSize: batch.length,
          table: batch.length > 0 ? batch[0].table : 'unknown'
        }, MODULE_NAME);
        
        // Continue with next batch instead of failing the whole operation
        continue;
      }
    }
    
    // Log only essential info at info level
    replicationLogger.info('Changes stored', { 
      count: successCount,
      total: changes.length
    }, MODULE_NAME);
    
    return successCount > 0;
  } catch (error) {
    replicationLogger.error('Store changes failed', {
      count: changes.length
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
    // (storeChangesInHistory now handles its own logging more concisely)
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
      
      // Only log client notification if there are clients
      if (clientIds.length > 0) {
        replicationLogger.info('Notifying clients', {
          count: clientIds.length
        }, MODULE_NAME);
      }
      
      // Track successful notifications
      let successCount = 0;
      let failureCount = 0;
      
      // For each client, send simple notification to check for changes
      for (const clientId of clientIds) {
        try {
          // Get the client's SyncDO
          const clientDoId = env.SYNC.idFromName(`client:${clientId}`);
          const clientDo = env.SYNC.get(clientDoId);
          
          // Send notification to check for changes
          const response = await clientDo.fetch(
            `https://internal/new-changes?clientId=${encodeURIComponent(clientId)}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                lsn: lastLSN
              })
            }
          );
          
          if (response.status === 200) {
            successCount++;
          } else {
            failureCount++;
            // Only log failures at warn level with minimal info
            replicationLogger.warn('Client notify failed', {
              clientId,
              status: response.status
            }, MODULE_NAME);
          }
        } catch (error) {
          failureCount++;
          replicationLogger.error('Client notify error', {
            clientId
          }, MODULE_NAME);
        }
      }
      
      // Only log notification summary if there were clients
      if (clientIds.length > 0) {
        replicationLogger.info('Client notifications completed', {
          success: successCount,
          failed: failureCount
        }, MODULE_NAME);
      }
    } catch (notifyError) {
      replicationLogger.error('Client notification process failed', {}, MODULE_NAME);
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
      lsn: lastLSN
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