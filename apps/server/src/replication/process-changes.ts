import type { TableChange, ServerSyncStatsMessage } from '@repo/sync-types';
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
  deduplicationReasons: Record<string, number>;
};

type TableName = keyof typeof SERVER_TABLE_HIERARCHY;

// ====== Constants ======
const DEFAULT_STORE_BATCH_SIZE = 100;
const DEFAULT_CHUNK_SIZE = 500; // Added for chunking broadcasts

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
  
  // Tracking stats for detailed reporting
  const originalCount = changes.length;
  const operationCounts: Record<string, number> = {
    insert: 0,
    update: 0,
    delete: 0
  };
  const tableStats: Record<string, number> = {};

  // Add tracking for specific deduplication reasons
  const deduplicationReasons: Record<string, number> = {
    'duplicate_update': 0,
    'duplicate_insert': 0,
    'duplicate_delete': 0,
    'newer_version': 0
  };

  // First pass - deduplicate and optimize
  for (const change of changes) {
    if (!change.data?.id) continue;

    const key = `${change.table}:${change.data.id}`;
    const existing = latestChanges.get(key);
    
    // Track operation stats
    operationCounts[change.operation] = (operationCounts[change.operation] || 0) + 1;
    
    // Track table stats
    tableStats[change.table] = (tableStats[change.table] || 0) + 1;
    
    // Track inserts for optimization
    if (change.operation === 'insert') {
      insertMap.set(key, change);
    }
    
    // Keep latest change - modified to track deduplication reasons
    if (!existing) {
      latestChanges.set(key, change);
    } else {
      // We have a duplicate - track the reason
      if (new Date(change.updated_at) >= new Date(existing.updated_at)) {
        // This is a newer version replacing older one
        deduplicationReasons['newer_version']++;
        latestChanges.set(key, change);
      } else {
        // This is an older duplicate we're discarding
        const reasonKey = `duplicate_${change.operation}`;
        deduplicationReasons[reasonKey] = (deduplicationReasons[reasonKey] || 0) + 1;
      }
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

  // Calculate deduplication metrics
  const deduplicatedCount = latestChanges.size;
  const reduction = originalCount - deduplicatedCount;
  const reductionPercent = originalCount > 0 ? 
    Math.round((reduction / originalCount) * 100) : 0;

  // Log detailed deduplication statistics
  replicationLogger.info('Change deduplication results', {
    originalCount,
    deduplicatedCount,
    reduction,
    reductionPercent,
    operationCounts,
    tableStats,
    clientCount: changesByClient.size,
    clientChangeDetails: Object.fromEntries(
      Array.from(changesByClient.entries())
        .map(([id, changes]) => [id || 'system', changes.length])
    ),
    deduplicationReasons // Include deduplication reasons in the log
  }, MODULE_NAME);

  return {
    deduplicatedChanges: orderedChanges,
    changesByClient,
    deduplicationReasons // Return deduplication reasons for use in stats
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
    
    // Simplified notification logic - just tell clients to check for changes
    replicationLogger.info('Notifying clients of new changes', {
      clientCount: clientIds.length,
      lastLSN
    }, MODULE_NAME);
    
    // Track successful notifications
    let successCount = 0;
    let failureCount = 0;
    
    // For each client, send notification to check for changes
    for (const clientId of clientIds) {
      try {
        // Get the client's SyncDO
        const clientDoId = env.SYNC.idFromName(`client:${clientId}`);
        const clientDo = env.SYNC.get(clientDoId);
        
        // Send notification to check for changes (only clientId and lastLSN)
        const response = await clientDo.fetch(
          `https://internal/new-changes?clientId=${encodeURIComponent(clientId)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              lsn: lastLSN,
              sequence: { chunk: 1, total: 1 }
            })
          }
        );
        
        if (response.status === 200) {
          successCount++;
          
          replicationLogger.debug('Client notification sent', { 
            clientId,
            lastLSN
          }, MODULE_NAME);
        } else {
          failureCount++;
          replicationLogger.warn('Failed to notify client', {
            clientId,
            status: response.status
          }, MODULE_NAME);
        }
      } catch (error) {
        failureCount++;
        replicationLogger.error('Client notification failed', {
          clientId,
          error: error instanceof Error ? error.message : String(error)
        }, MODULE_NAME);
      }
    }
    
    // Log notification summary
    replicationLogger.info('Client notification complete', {
      totalClients: clientIds.length,
      successCount,
      failureCount,
      lastLSN
    }, MODULE_NAME);
    
    return successCount > 0; // Consider successful if at least one client was notified
  } catch (error) {
    replicationLogger.error('Broadcast failed', {
      error: error instanceof Error ? error.message : String(error),
      changeCount: changes.length
    }, MODULE_NAME);
    return false;
  }
}

/**
 * Create a stats message with detailed information about change processing
 * Can be tailored for a specific client or general system stats
 */
function createSyncStatsMessage(
  clientId: string,
  syncType: 'live' | 'catchup' | 'initial',
  originalCount: number,
  processedCount: number,
  filteredCount: number,
  operationCounts: Record<string, number>,
  tableStats: Record<string, number>,
  clientStats: Record<string, number>,
  filterReasons: Record<string, number> = {},
  deduplicationReasons: Record<string, number> = {},
  startTime: number,
  lsnFirst?: string,
  lsnLast?: string,
  clientFilteredCount: number = 0, // Additional tracking for client-specific filtering
  filteredChangeDetails: Array<{id: string, table: string, reason: string}> = [] // Details of filtered changes
): ServerSyncStatsMessage {
  const processingTime = Date.now() - startTime;
  
  // Calculate deduplication stats
  const deduplicationStats = {
    beforeCount: originalCount,
    afterCount: processedCount,
    reduction: originalCount - processedCount,
    reductionPercent: originalCount > 0 ?
      Math.round(((originalCount - processedCount) / originalCount) * 100) : 0,
    reasons: deduplicationReasons
  };
  
  // Calculate filtering stats
  const filteringStats = {
    beforeCount: originalCount,
    afterCount: originalCount - filteredCount - clientFilteredCount,
    filtered: filteredCount + clientFilteredCount,
    reasons: {
      ...filterReasons,
      // Add client-specific filter reason if applicable
      'client_own_changes': clientFilteredCount
    },
    // Include details of filtered changes
    filteredChanges: filteredChangeDetails
  };
  
  // Create the stats message
  const statsMessage: ServerSyncStatsMessage = {
    type: 'srv_sync_stats',
    messageId: `stats_${Date.now()}`,
    timestamp: Date.now(),
    clientId,
    syncType,
    originalCount,
    processedCount,
    deduplicationStats,
    filteringStats,
    contentStats: {
      operations: operationCounts,
      tables: tableStats,
      clients: clientStats
    },
    performanceStats: {
      processingTimeMs: processingTime
    }
  };
  
  // Add LSN range if available
  if (lsnFirst && lsnLast) {
    statsMessage.lsnRange = {
      first: lsnFirst,
      last: lsnLast
    };
  }
  
  return statsMessage;
}

/**
 * Send stats message to a client's SyncDO
 */
async function sendStatsToClient(
  env: Env,
  clientId: string,
  statsMessage: ServerSyncStatsMessage
): Promise<boolean> {
  try {
    const clientDoId = env.SYNC.idFromName(`client:${clientId}`);
    const clientDo = env.SYNC.get(clientDoId);
    
    const response = await clientDo.fetch(
      `https://internal/sync-stats?clientId=${encodeURIComponent(clientId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(statsMessage)
      }
    );
    
    if (response.status === 200) {
      replicationLogger.debug('Sent stats message to client', { 
        clientId,
        syncType: statsMessage.syncType,
        originalCount: statsMessage.originalCount,
        processedCount: statsMessage.processedCount
      }, MODULE_NAME);
      return true;
    } else {
      replicationLogger.warn('Failed to send stats to client', {
        clientId,
        status: response.status
      }, MODULE_NAME);
      return false;
    }
  } catch (error) {
    replicationLogger.error('Stats message send failed', {
      clientId,
      error: error instanceof Error ? error.message : String(error)
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
  const startTime = Date.now(); // Track processing time

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
    const { deduplicatedChanges, changesByClient, deduplicationReasons } = processAndGroupChanges(tableChanges);
    
    // Log detailed processing results with deduplication info
    replicationLogger.info('Change processing results', {
      originalCount: changes.length,
      validCount: tableChanges.length,
      deduplicatedCount: deduplicatedChanges.length,
      deduplicationReasons, // Include deduplication reasons
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
    
    // Step 6: Send client-specific stats messages
    // Extract operation and table stats
    const operationCounts = deduplicatedChanges.reduce((acc, change) => {
      acc[change.operation] = (acc[change.operation] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const tableStats = deduplicatedChanges.reduce((acc, change) => {
      acc[change.table] = (acc[change.table] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    // Extract client stats
    const clientStats = Object.fromEntries(
      Array.from(changesByClient.entries())
        .map(([id, changes]) => [id || 'system', changes.length])
    );
    
    // Get first LSN
    const firstLSN = deduplicatedChanges.length > 0 ? deduplicatedChanges[0].lsn : undefined;
    
    // Get client IDs
    const clientIds = await getAllClientIds(env);
    
    // For each client, calculate specific stats and send a tailored message
    for (const clientId of clientIds) {
      // Get changes made by this client (if any)
      const clientChanges = changesByClient.get(clientId) || [];
      const clientChangeIds = new Set(clientChanges.map(c => `${c.table}:${c.data.id}`));
      
      // Calculate how many changes were filtered out specifically for this client
      // (excludes client's own changes from being sent back to them)
      const clientOwnChangesCount = clientChanges.length;
      
      // Collect details of client's own filtered changes
      const clientFilteredChanges: Array<{id: string, table: string, reason: string}> = clientChanges.map(change => ({
        id: String(change.data.id),
        table: change.table,
        reason: 'client_own_change'
      }));
      
      // Also collect system-filtered changes
      const systemFilteredChanges: Array<{id: string, table: string, reason: string}> = [];
      
      // If we have detailed filter reasons from the WAL transformation, add them
      if (Object.keys(filteredReasons).length > 0) {
        // This is approximate since we don't track exact changes that were filtered during WAL transformation
        Object.entries(filteredReasons).forEach(([reason, count]) => {
          for (let i = 0; i < count; i++) {
            systemFilteredChanges.push({
              id: `unknown-${i}`,
              table: 'unknown',
              reason
            });
          }
        });
      }
      
      // Combine all filtered change details
      const allFilteredChanges = [...clientFilteredChanges, ...systemFilteredChanges];
      
      // Calculate client-specific tables and operations stats
      // These should reflect only the changes this client will receive
      const relevantChanges = deduplicatedChanges.filter(change => {
        // Skip if this change was made by this client
        if (change.data.client_id === clientId) {
          return false;
        }
        
        // Skip if we have another change for this record from this client
        const changeKey = `${change.table}:${change.data.id}`;
        return !clientChangeIds.has(changeKey);
      });
      
      // Calculate client-specific operation stats
      const clientOperationCounts = relevantChanges.reduce((acc, change) => {
        acc[change.operation] = (acc[change.operation] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      // Calculate client-specific table stats
      const clientTableStats = relevantChanges.reduce((acc, change) => {
        acc[change.table] = (acc[change.table] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      // Create client-specific stats message with deduplication reasons
      const statsMessage = createSyncStatsMessage(
        clientId,
        'live', // This is always live sync in process-changes
        tableChanges.length,
        deduplicatedChanges.length,
        filteredCount,
        clientOperationCounts, // Use client-specific operation stats
        clientTableStats,      // Use client-specific table stats
        clientStats,
        filteredReasons,
        deduplicationReasons, // Pass the actual deduplication reasons
        startTime,
        firstLSN,
        lastLSN,
        clientOwnChangesCount,  // Add client's own changes count for filtering stats
        allFilteredChanges      // Add details of all filtered changes
      );
      
      await sendStatsToClient(env, clientId, statsMessage);
    }
    
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