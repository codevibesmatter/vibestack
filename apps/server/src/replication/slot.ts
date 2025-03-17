import { Client } from '@neondatabase/serverless';
import type { ReplicationConfig, DomainTable } from './types';
import { getDomainTables } from './types';
import { SERVER_DOMAIN_TABLES } from '@repo/typeorm/server-entities';
import { replicationLogger } from '../middleware/logger';
import { StateManager } from './state-manager';
import type { ReplicationMetrics } from './types';
import { getDBClient } from '../lib/db';
import type { Env } from '../types/env';
import type { MinimalContext } from '../types/hono';
import { Context } from 'hono';

export const DEFAULT_REPLICATION_CONFIG: ReplicationConfig = {
  slot: 'vibestack',
  publication: 'vibestack',
  hibernationDelay: 120000 // 2 minutes of inactivity before hibernation
};

export interface ReplicationLagStatus {
  replayLag: number;
  writeLag: number;
  flushLag: number;
}

export interface SlotStatus {
  exists: boolean;
  lsn?: string;
}

export async function getSlotStatus(c: MinimalContext, slotName: string): Promise<SlotStatus> {
  try {
    replicationLogger.debug('Checking replication slot status', {
      event: 'replication.slot.check',
      slot: slotName
    });

    const client = getDBClient(c);
    await client.connect();
    
    try {
      const result = await client.query(`
        SELECT slot_name, confirmed_flush_lsn
        FROM pg_replication_slots 
        WHERE slot_name = $1;
      `, [slotName]);

      if (result.rows.length === 0) {
        replicationLogger.info('Replication slot not found', {
          event: 'replication.slot.missing',
          slot: slotName
        });
        return { exists: false };
      }

      const status = {
        exists: true,
        lsn: result.rows[0].confirmed_flush_lsn
      };

      replicationLogger.info('Replication slot status', {
        event: 'replication.slot.status',
        slot: slotName,
        exists: true,
        lsn: status.lsn
      });

      return status;
    } finally {
      await client.end();
    }
  } catch (err) {
    replicationLogger.error('Error checking slot status:', {
      event: 'replication.slot.error',
      slot: slotName,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    throw err;
  }
}

export async function advanceReplicationSlot(
  ctx: MinimalContext,
  slotName: string,
  targetLSN: string
): Promise<void> {
  replicationLogger.debug('Advancing replication slot', {
    event: 'replication.slot.advance.start',
    slot: slotName,
    targetLSN
  });

  const client = getDBClient(ctx);
  await client.connect();
  try {
    // Consume changes up to target LSN
    await client.query(`
      SELECT pg_logical_slot_get_changes(
        $1,
        NULL,
        NULL,
        'upto_lsn', $2
      );
    `, [slotName, targetLSN]);
    
    replicationLogger.info('Advanced replication slot', {
      event: 'replication.slot.advance.complete',
      slot: slotName,
      targetLSN
    });
  } catch (err) {
    replicationLogger.error('Failed to advance replication slot', {
      event: 'replication.slot.advance.error',
      slot: slotName,
      targetLSN,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * Drop a replication slot
 */
export async function dropReplicationSlot(client: Client, slotName: string): Promise<void> {
  try {
    replicationLogger.info('Dropping replication slot:', { slotName });
    
    // First try to deactivate the slot
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_replication WHERE application_name = $1`,
      [slotName]
    );
    
    // Then drop the slot
    await client.query(
      `SELECT pg_drop_replication_slot($1)`,
      [slotName]
    );
    
    replicationLogger.info('✅ Successfully dropped replication slot:', { slotName });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    replicationLogger.error('❌ Failed to drop replication slot:', { slotName, error });
    throw err;
  }
}

/**
 * Peek at the WAL history from a given LSN without consuming changes
 * @param c Context with environment
 * @param slot Replication slot name
 * @param fromLSN Starting LSN (optional, defaults to '0/0')
 * @param limit Maximum number of changes to return (optional, defaults to 100)
 */
export async function peekSlotHistory(
  c: Context<{ Bindings: Env }> | MinimalContext,
  slot: string,
  fromLSN: string = '0/0',
  limit: number = 100
): Promise<{
  changes: Array<{
    data: string;
    lsn: string;
    xid: string;
    timestamp?: string;
  }>;
  hasMore: boolean;
  nextLSN?: string;
  slot_status?: {
    slot_name: string;
    confirmed_flush_lsn: string;
    restart_lsn: string;
    wal_status: string;
  };
}> {
  const client = getDBClient(c);
  await client.connect();

  try {
    replicationLogger.info('Peeking slot history', {
      event: 'replication.slot.peek',
      slot,
      fromLSN,
      limit
    });

    // Get slot status first
    const slotStatus = await client.query(`
      SELECT 
        slot_name,
        confirmed_flush_lsn,
        restart_lsn,
        CASE 
          WHEN pg_walfile_name(restart_lsn) = pg_walfile_name(pg_current_wal_lsn()) 
          THEN 'current'
          ELSE 'retained'
        END as wal_status
      FROM pg_replication_slots 
      WHERE slot_name = $1;
    `, [slot]);

    // Get changes
    const result = await client.query(`
      SELECT data, lsn, xid 
      FROM pg_logical_slot_peek_changes(
        $1,    -- slot name
        NULL,  -- upto_lsn (NULL means current)
        $2,    -- upto_nchanges
        'include-xids', '1',
        'include-timestamp', 'true'
      )
      LIMIT $3;
    `, [slot, null, limit + 1]);

    const hasMore = result.rows.length > limit;
    const changes = result.rows.slice(0, limit).map(row => {
      try {
        // Try to parse the data to extract timestamp if present
        const parsed = JSON.parse(row.data);
        return {
          data: row.data,
          lsn: row.lsn,
          xid: row.xid,
          timestamp: parsed.timestamp
        };
      } catch {
        // If parsing fails, return raw data
        return {
          data: row.data,
          lsn: row.lsn,
          xid: row.xid
        };
      }
    });

    const response = {
      changes,
      hasMore,
      // Only include nextLSN if there are more changes
      ...(hasMore && changes.length > 0 && {
        nextLSN: changes[changes.length - 1].lsn
      }),
      // Include slot status if available
      ...(slotStatus.rows.length > 0 && {
        slot_status: slotStatus.rows[0]
      })
    };

    replicationLogger.info('Slot history peek complete', {
      event: 'replication.slot.peek.complete',
      slot,
      fromLSN,
      changeCount: changes.length,
      hasMore,
      firstLSN: changes[0]?.lsn,
      lastLSN: changes[changes.length - 1]?.lsn,
      slot_status: slotStatus.rows[0]
    });

    return response;
  } catch (error) {
    replicationLogger.error('Failed to peek slot history:', {
      event: 'replication.slot.peek.error',
      error: error instanceof Error ? error.message : String(error),
      slot,
      fromLSN
    });
    throw error;
  } finally {
    await client.end();
  }
} 