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

type ProcessedChanges = {
  deduplicatedChanges: TableChange[];
  changesByClient: Map<string | null, TableChange[]>;
};

type TableName = keyof typeof SERVER_TABLE_HIERARCHY;

// ====== Constants ======
const DEFAULT_STORE_BATCH_SIZE = 100;

// ====== Helper Functions ======
export function shouldTrackTable(tableName: string): boolean {
  if (tableName === 'change_history') {
    return false;
  }
  const normalizedTableName = `"${tableName}"`;
  return SERVER_DOMAIN_TABLES.includes(normalizedTableName as any);
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
          replicationLogger.debug('Cleaned up inactive client', {
            clientId,
            lastSeen: new Date(lastSeen).toISOString(),
            timeSinceLastSeen: `${Math.round(timeSinceLastSeen / 1000)}s`
          }, MODULE_NAME);
        }
      } catch (err) {
        replicationLogger.error('Client parse error', {
          key: key.name,
          error: err instanceof Error ? err.message : String(err)
        }, MODULE_NAME);
      }
    }
    
    replicationLogger.debug('Active clients retrieved', { 
      count: clientIds.length 
    }, MODULE_NAME);
    
    return clientIds;
  } catch (error) {
    replicationLogger.error('Client retrieval failed', {
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    return [];
  }
}

// ====== Core Processing Functions ======
/**
 * Process changes by:
 * 1. Deduplicating changes (keeping latest)
 * 2. Grouping by client_id
 * 3. Ordering by domain hierarchy
 */
function processAndGroupChanges(changes: TableChange[]): ProcessedChanges {
  // Track latest changes and inserts for optimization
  const latestChanges = new Map<string, TableChange>();
  const insertMap = new Map<string, TableChange>();

  // First pass - deduplicate and optimize
  for (const change of changes) {
    if (!change.data?.id) continue;

    const key = `${change.table}:${change.data.id}`;
    const existing = latestChanges.get(key);
    
    // Track inserts for optimization
    if (change.operation === 'insert') {
      insertMap.set(key, change);
    }
    
    // Keep latest change
    if (!existing || new Date(change.updated_at) >= new Date(existing.updated_at)) {
      latestChanges.set(key, change);
    }
  }
  
  // Second pass - optimize insert+update patterns and group by client
  const changesByClient = new Map<string | null, TableChange[]>();
  
  for (const [key, change] of latestChanges.entries()) {
    let finalChange: TableChange;
    
    // Optimize insert+update patterns
    if (change.operation === 'update' && insertMap.has(key)) {
      const insert = insertMap.get(key)!;
      
      if (insert === change) {
        finalChange = change;
      } else {
        finalChange = {
          table: change.table,
          operation: 'insert',
          data: {
            ...insert.data,
            ...change.data,
            id: change.data.id,
            client_id: change.data.client_id
          },
          updated_at: change.updated_at,
          lsn: change.lsn
        };
      }
    } else {
      finalChange = change;
    }

    // Group by client_id
    const clientId = typeof finalChange.data.client_id === 'string' ? finalChange.data.client_id : null;
    if (!changesByClient.has(clientId)) {
      changesByClient.set(clientId, []);
    }
    changesByClient.get(clientId)!.push(finalChange);
  }

  // Order all changes by domain hierarchy
  const orderedChanges = changes.sort((a, b) => {
    const aLevel = SERVER_TABLE_HIERARCHY[`"${a.table}"` as TableName] ?? 0;
    const bLevel = SERVER_TABLE_HIERARCHY[`"${b.table}"` as TableName] ?? 0;

    // For deletes, reverse the hierarchy
    if (a.operation === 'delete' && b.operation === 'delete') {
      return bLevel - aLevel;
    }

    // For mixed operations, deletes come last
    if (a.operation === 'delete') return 1;
    if (b.operation === 'delete') return -1;

    // For creates/updates, follow hierarchy
    return aLevel - bLevel;
  });

  return {
    deduplicatedChanges: orderedChanges,
    changesByClient
  };
}

export function transformWALChanges(changes: WALData[]): { 
  tableChanges: TableChange[], 
  filteredReasons: Record<string, number> 
} {
  const tableChanges: TableChange[] = [];
  const filteredReasons: Record<string, number> = {};

  for (const wal of changes) {
    try {
      const parsedData = wal.data ? JSON.parse(wal.data) as PostgresWALMessage : null;
      if (!parsedData?.change || !Array.isArray(parsedData.change)) {
        addFilterReason(filteredReasons, 'Invalid WAL data structure');
        continue;
      }

      const change = parsedData.change[0];
      
      if (!change?.schema || !change?.table) {
        addFilterReason(filteredReasons, 'Missing schema or table');
        continue;
      }
      
      if (!shouldTrackTable(change.table)) {
        addFilterReason(filteredReasons, `Table ${change.table} not in tracked tables`);
        continue;
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

    } catch (error) {
      addFilterReason(filteredReasons, 
        `Error transforming WAL data: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
  
  try {
    const client = getDBClient(context);
    await client.connect();
    await client.query('BEGIN');
    
    for (let i = 0; i < changes.length; i += storeBatchSize) {
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
      
      const query = `
        INSERT INTO change_history 
          (table_name, operation, data, lsn, timestamp) 
        VALUES 
          ${values}
        ON CONFLICT DO NOTHING;
      `;
      
      await client.query(query, params);
    }
    
    await client.query('COMMIT');
    
    replicationLogger.info('Changes stored successfully', { 
      count: changes.length,
      lsnRange: {
        first: changes[0].lsn,
        last: changes[changes.length - 1].lsn
      }
    }, MODULE_NAME);
    
    return true;
  } catch (error) {
    replicationLogger.error('Failed to store changes', {
      error: error instanceof Error ? error.message : String(error),
      count: changes.length
    }, MODULE_NAME);
    
    try {
      const client = getDBClient(context);
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      replicationLogger.error('Rollback failed', {
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      }, MODULE_NAME);
    }
    
    return false;
  }
}

/**
 * Broadcasts changes to connected clients using SyncDO
 * This is the main entry point for sending changes to clients
 */
export async function broadcastChangesToClients(
  env: Env,
  changes: TableChange[],
  changesByClient: Map<string | null, TableChange[]>,
  lastLSN: string,
  stateManager: StateManager
): Promise<boolean> {
  if (changes.length === 0) {
    return true;
  }
  
  try {
    const clientIds = await getAllClientIds(env);
    let totalChangesSent = 0;
    
    // For each client, send only the changes not made by that client
    for (const clientId of clientIds) {
      // Get changes made by this client (if any)
      const clientChanges = changesByClient.get(clientId) || [];
      const clientChangeIds = new Set(clientChanges.map(c => `${c.table}:${c.data.id}`));
      
      // Filter out self-changes and get only non-system changes
      const changesToSend = changes.filter(change => {
        // Skip system changes (they'll be handled separately)
        if (typeof change.data.client_id !== 'string') {
          return false;
        }
        
        // Skip if this change was made by this client
        if (change.data.client_id === clientId) {
          return false;
        }
        
        // Skip if we have another change for this record from this client
        // (prevents race conditions where client already has a newer version)
        const changeKey = `${change.table}:${change.data.id}`;
        return !clientChangeIds.has(changeKey);
      });
      
      // Add system changes to the changes to send
      const systemChanges = changesByClient.get(null) || [];
      const allChangesToSend = [...changesToSend, ...systemChanges];
      
      if (allChangesToSend.length > 0) {
        try {
          // Get the client's SyncDO
          const clientDoId = env.SYNC.idFromName(`client:${clientId}`);
          const clientDo = env.SYNC.get(clientDoId);
          
          const response = await clientDo.fetch(
            `https://internal/new-changes?clientId=${encodeURIComponent(clientId)}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                changes: allChangesToSend,
                lsn: lastLSN
              })
            }
          );
          
          if (response.status === 200) {
            totalChangesSent += allChangesToSend.length;
            
            replicationLogger.debug('Client changes sent', { 
              clientId,
              changeCount: allChangesToSend.length,
              tables: [...new Set(allChangesToSend.map(c => c.table))]
            }, MODULE_NAME);
          } else {
            replicationLogger.warn('Failed to send changes to client', {
              clientId,
              status: response.status
            }, MODULE_NAME);
          }
        } catch (error) {
          replicationLogger.error('Client notification failed', {
            clientId,
            error: error instanceof Error ? error.message : String(error)
          }, MODULE_NAME);
        }
      }
    }
    
    // Log high-level broadcast status
    replicationLogger.info('Broadcast complete', {
      totalChanges: changes.length,
      clientCount: clientIds.length,
      totalChangesSent
    }, MODULE_NAME);
    
    // Log detailed broadcast info at debug level
    replicationLogger.debug('Broadcast details', {
      totalClients: clientIds.length,
      changesByClientCount: Object.fromEntries(
        Array.from(changesByClient.entries())
          .map(([id, changes]) => [id || 'system', changes.length])
      ),
      lsnRange: {
        first: changes[0].lsn,
        last: lastLSN
      }
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

  try {
    // Step 1: Transform
    const { tableChanges, filteredReasons } = transformWALChanges(changes);
    const filteredCount = changes.length - tableChanges.length;
    
    if (filteredCount > 0) {
      replicationLogger.info('Changes filtered', {
        originalCount: changes.length,
        validCount: tableChanges.length,
        filteredCount,
        reasons: filteredReasons
      }, MODULE_NAME);
    }
    
    if (tableChanges.length === 0) {
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
      await stateManager.setLSN(lastLSN);
      return { 
        success: true, 
        storedChanges: false, 
        changeCount: tableChanges.length,
        filteredCount,
        lastLSN
      };
    }

    // Step 3: Process and group changes for broadcast
    const { deduplicatedChanges, changesByClient } = processAndGroupChanges(tableChanges);
    
    // Log detailed processing results
    replicationLogger.info('Change processing results', {
      originalCount: changes.length,
      validCount: tableChanges.length,
      deduplicatedCount: deduplicatedChanges.length,
      changesByClient: Object.fromEntries(
        Array.from(changesByClient.entries())
          .map(([id, changes]) => [id || 'system', changes.length])
      ),
      changesByOperation: deduplicatedChanges.reduce((acc, change) => {
        acc[change.operation] = (acc[change.operation] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      changesByTable: deduplicatedChanges.reduce((acc, change) => {
        acc[change.table] = (acc[change.table] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      lsnRange: {
        first: deduplicatedChanges[0].lsn,
        last: deduplicatedChanges[deduplicatedChanges.length - 1].lsn
      }
    }, MODULE_NAME);
    
    // Step 4: Update LSN
    try {
      await stateManager.setLSN(lastLSN);
    } catch (lsnError) {
      replicationLogger.error('LSN update failed', {
        error: lsnError instanceof Error ? lsnError.message : String(lsnError),
        lsn: lastLSN
      }, MODULE_NAME);
    }
    
    // Step 5: Broadcast
    await broadcastChangesToClients(env, deduplicatedChanges, changesByClient, lastLSN, stateManager);
    
    return { 
      success: true, 
      storedChanges: storedSuccessfully,
      changeCount: tableChanges.length, // Return total changes stored, not deduplicated
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
    
    replicationLogger.error('Change processing failed', {
      error: errorMsg,
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