import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { TableChange } from '@repo/sync-types';
import { ClientManager } from './client-manager';
import { replicationLogger } from '../middleware/logger';
import type { MinimalContext } from '../types/hono';
import type { WALData, PostgresWALMessage } from '../types/wal';

const MODULE_NAME = 'changes';

/**
 * Validates if a WAL change should be processed based on our filtering rules.
 */
export function isValidTableChange(
  change: NonNullable<PostgresWALMessage['change']>[number] | undefined,
  lsn: string
): boolean {
  if (!change?.schema || !change?.table) {
    return false;
  }

  if (!change.columnnames || !change.columnvalues) {
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
      return null;
    }

    // Get the first change
    const change = parsedData.change[0];
    
    // Use centralized filtering logic
    if (!isValidTableChange(change, wal.lsn)) {
      return null;
    }

    // Transform to structured format
    const data = change.columnvalues?.reduce((acc: Record<string, unknown>, value: unknown, index: number) => {
      acc[change.columnnames[index]] = value;
      return acc;
    }, {});

    // Return in our universal format
    return {
      table: change.table,
      operation: change.kind,
      data,
      lsn: wal.lsn,
      updated_at: data.updated_at as string || new Date().toISOString()
    };
  } catch (error) {
    return null;
  }
}

/**
 * Process WAL changes from replication slot
 */
export async function processWALChanges(
  changes: WALData[],
  clientManager: ClientManager
): Promise<void> {
  // Transform WAL messages to table changes
  const tableChanges = changes
    .map(transformWALToTableChange)
    .filter((change): change is TableChange => change !== null);

  if (tableChanges.length === 0) {
    return;
  }

  // Log WAL processing at replication level
  replicationLogger.info('Processing WAL changes', {
    count: tableChanges.length,
    tables: Array.from(new Set(tableChanges.map(c => c.table))),
    lsnRange: `${changes[0].lsn} → ${changes[changes.length - 1].lsn}`
  }, MODULE_NAME);

  // Send changes to clients
  await clientManager.handleChanges(tableChanges);
} 