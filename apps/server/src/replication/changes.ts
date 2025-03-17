import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { TableChange } from '@repo/sync-types';
import type { ReplicationState } from './types';
import { ClientManager } from './client-manager';
import { replicationLogger } from '../middleware/logger';
import { StateManager } from './state-manager';
import { SERVER_DOMAIN_TABLES, ChangeHistory } from '@repo/typeorm/server-entities';
import { getDBClient } from '../lib/db';
import type { MinimalContext } from '../types/hono';

export interface WALData {
  lsn: string;
  data: string;
  xid?: number;
}

interface PostgresWALMessage {
  change?: Array<{
    schema: string;
    table: string;
    kind: 'insert' | 'update' | 'delete';
    columnnames: string[];
    columnvalues: unknown[];
  }>;
  lsn: string;
  xid?: number;
}

// Constants for chunking
const CHUNK_SIZE = 100; // Maximum changes per chunk

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
    if (!change?.schema || !change?.table) {
      return null;
    }

    // Transform to structured format
    const data = change.columnvalues?.reduce((acc: Record<string, unknown>, value: unknown, index: number) => {
      acc[change.columnnames[index]] = value;
      return acc;
    }, {});

    // Get updated_at from the data
    if (!data.updated_at) {
      replicationLogger.error('Missing updated_at in WAL data:', {
        event: 'replication.transform.error',
        table: change.table,
        operation: change.kind,
        data
      });
      return null;
    }

    // Return in our universal format
    return {
      table: change.table,
      operation: change.kind,
      data,
      lsn: wal.lsn,
      updated_at: data.updated_at as string
    };
  } catch (error) {
    replicationLogger.error('Failed to transform WAL data:', error);
    return null;
  }
}

/**
 * Process WAL changes from replication slot
 */
export async function processWALChanges(
  c: Context<{ Bindings: Env }> | MinimalContext,
  changes: WALData[],
  state: ReplicationState,
  clientManager: ClientManager,
  stateManager: StateManager
): Promise<void> {
  try {
    // Transform WAL messages to table changes
    const tableChanges = changes
      .map(transformWALToTableChange)
      .filter((change): change is TableChange => change !== null);

    if (tableChanges.length === 0) {
      return;
    }

    replicationLogger.info('Processing WAL changes:', {
      event: 'replication.wal.process',
      changeCount: tableChanges.length,
      tables: Array.from(new Set(tableChanges.map(c => c.table))),
      firstLSN: tableChanges[0].lsn,
      lastLSN: tableChanges[tableChanges.length - 1].lsn
    });

    // Process changes in chunks
    const chunks = Math.ceil(tableChanges.length / CHUNK_SIZE);
    for (let i = 0; i < chunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, tableChanges.length);
      const chunkChanges = tableChanges.slice(start, end);

      replicationLogger.info('Processing chunk of changes:', {
        event: 'replication.wal.chunk',
        chunk: i + 1,
        total: chunks,
        changeCount: chunkChanges.length,
        firstLSN: chunkChanges[0].lsn,
        lastLSN: chunkChanges[chunkChanges.length - 1].lsn
      });

      // Save changes to history for this chunk
      await saveChangesToHistory(c, chunkChanges);

      // Let client manager handle notifications for this chunk
      await clientManager.handleChanges(chunkChanges);
    }

    // Only advance LSN after all chunks are processed successfully
    const lastLSN = tableChanges[tableChanges.length - 1].lsn;
    if (lastLSN !== state.confirmedLSN) {
      replicationLogger.info('Advancing LSN', {
        event: 'replication.lsn.advance',
        from: state.confirmedLSN || '0/0',
        to: lastLSN
      });
      await stateManager.updateState({ confirmedLSN: lastLSN });
    }
  } catch (error) {
    replicationLogger.error('Failed to process WAL changes:', error);
    throw error;
  }
}

/**
 * Save changes to history table
 */
async function saveChangesToHistory(c: Context<{ Bindings: Env }> | MinimalContext, changes: TableChange[]): Promise<void> {
  // Prepare values array outside try block for error handling scope
  const values: Omit<ChangeHistory, 'id'>[] = changes.map(change => ({
    table_name: change.table,
    operation: change.operation,
    data: change.data,
    lsn: change.lsn,
    updated_at: new Date(change.updated_at),
    client_id: undefined
  }));

  // Log before batch insert
  replicationLogger.info('Writing changes to history:', {
    event: 'replication.history.write.start',
    count: values.length,
    tables: [...new Set(values.map(v => v.table_name))],
    firstLSN: values[0]?.lsn,
    lastLSN: values[values.length - 1]?.lsn,
    firstTimestamp: values[0]?.updated_at.toISOString(),
    lastTimestamp: values[values.length - 1]?.updated_at.toISOString()
  });

  // Batch insert implementation
  const placeholders = values.map((_, i) => 
    `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`
  ).join(',');
  
  const flatValues = values.flatMap(v => [
    v.table_name,
    v.operation,
    v.data,
    v.lsn,
    v.updated_at,
    v.client_id
  ]);

  // Use a fresh client for this operation
  const client = getDBClient(c);
  await client.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query<Pick<ChangeHistory, 'id' | 'lsn' | 'updated_at'>>(`
      INSERT INTO change_history (
        table_name,
        operation,
        data,
        lsn,
        updated_at,
        client_id
      )
      VALUES ${placeholders}
      RETURNING id, lsn, updated_at;
    `, flatValues);

    await client.query('COMMIT');

    // Log after successful insert with null checks
    const rowCount = result.rowCount ?? 0;
    if (rowCount > 0) {
      replicationLogger.info('Changes written to history:', {
        event: 'replication.history.write.complete',
        count: rowCount,
        firstId: result.rows[0]?.id,
        lastId: result.rows[rowCount - 1]?.id,
        firstLSN: result.rows[0]?.lsn,
        lastLSN: result.rows[rowCount - 1]?.lsn
      });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
} 