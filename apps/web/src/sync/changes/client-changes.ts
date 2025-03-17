import { ConnectionManager } from '../connection-manager';
import { LSNManager } from '../lsn-manager';
import { 
  ClientChangeMessage, 
  ClientChangeResponse,
  TableChange
} from '../message-types';
import { syncLogger } from '../../utils/logger';
import { getDatabase } from '../../db/core';
import { PGliteWorker } from '@electric-sql/pglite/worker';

/**
 * Interface for change records in the local_changes table
 */
interface ChangeRecord {
  id: string;
  entity_type: string;
  entity_id: string;
  operation: 'insert' | 'update' | 'delete';
  data: string | null;
  old_data: string | null;
  updated_at: string;
  processed_local: boolean;
  processed_sync: boolean;
  from_server: boolean;
  error: string | null;
  attempts: number;
}

/**
 * Handles client change messages and responses
 */
export class ClientChangeHandler {
  private connectionManager: ConnectionManager;
  private lsnManager: LSNManager;

  constructor(connectionManager: ConnectionManager, lsnManager: LSNManager) {
    this.connectionManager = connectionManager;
    this.lsnManager = lsnManager;
    syncLogger.info('Client changes handler initialized');
  }

  /**
   * Convert a local change record to a TableChange
   */
  private async recordToTableChange(record: ChangeRecord): Promise<TableChange> {
    return {
      table: record.entity_type,
      operation: record.operation,
      data: record.data ? JSON.parse(record.data) : {},
      lsn: await this.lsnManager.getLSN(),
      timestamp: record.updated_at
    };
  }

  /**
   * Get unsynced changes from the local_changes table
   */
  private async getUnsynced(db: PGliteWorker): Promise<ChangeRecord[]> {
    // First get total count of changes
    const countResult = await db.query<{ total: string }>(
      `SELECT COUNT(*) as total FROM local_changes`
    );
    const totalChanges = parseInt(countResult.rows[0].total);

    // Get stats about changes
    interface ChangeStats {
      unprocessed: string;
      client_changes: string;
      max_attempts: string;
      eligible: string;
    }

    const statsResult = await db.query<ChangeStats>(`
      SELECT 
        COUNT(*) FILTER (WHERE NOT processed_sync) as unprocessed,
        COUNT(*) FILTER (WHERE NOT from_server) as client_changes,
        MAX(attempts) as max_attempts,
        COUNT(*) FILTER (
          WHERE NOT processed_sync 
          AND NOT from_server 
          AND (attempts < 3 OR attempts IS NULL)
        ) as eligible
      FROM local_changes
    `);

    // Log stats
    syncLogger.info('Local changes stats:', {
      total: totalChanges,
      ...statsResult.rows[0]
    });

    // Get eligible changes
    const result = await db.query<ChangeRecord>(`
      SELECT * FROM local_changes 
      WHERE NOT processed_sync 
      AND NOT from_server 
      AND (attempts < 3 OR attempts IS NULL)
      ORDER BY updated_at ASC
      LIMIT 50
    `);

    return result.rows;
  }

  /**
   * Mark a change as synced in the local_changes table
   */
  private async markSynced(db: PGliteWorker, changeId: string): Promise<void> {
    await db.query(
      `UPDATE local_changes 
       SET processed_sync = true,
           processed_local = true,
           error = null
       WHERE id = $1`,
      [changeId]
    );
  }

  /**
   * Mark a change as failed in the local_changes table
   */
  private async markFailed(db: PGliteWorker, changeId: string, error: string): Promise<void> {
    await db.query(
      `UPDATE local_changes 
       SET error = $2,
           attempts = attempts + 1
       WHERE id = $1`,
      [changeId, error]
    );
  }

  /**
   * Process a client change
   */
  public async processChange(change: ClientChangeMessage): Promise<void> {
    const db = await getDatabase();
    
    try {
      // Send the change to the server
      const success = this.connectionManager.sendToServer(change);
      
      if (!success) {
        syncLogger.error('Failed to send change to server', {
          table: change.change.table,
          operation: change.change.operation,
          localId: change.metadata?.local_id
        });

        // Mark as failed in local changes
        if (change.metadata?.local_id) {
          await this.markFailed(db, change.metadata.local_id, 'Failed to send to server');
        }
        return;
      }

      syncLogger.info('Change sent to server', {
        table: change.change.table,
        operation: change.change.operation,
        localId: change.metadata?.local_id
      });
    } catch (error) {
      syncLogger.error('Error processing change', {
        error,
        table: change.change.table,
        operation: change.change.operation,
        localId: change.metadata?.local_id
      });

      // Mark as failed in local changes
      if (change.metadata?.local_id) {
        await this.markFailed(
          db, 
          change.metadata.local_id, 
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
    }
  }

  /**
   * Handle server response to client change
   */
  public async handleResponse(response: ClientChangeResponse): Promise<void> {
    const localId = response.metadata?.local_id;
    
    if (!localId) {
      syncLogger.warn('Received client change response without local_id', response);
      return;
    }

    const db = await getDatabase();
    
    // Find the change in local_changes table
    const result = await db.query<ChangeRecord>(
      `SELECT * FROM local_changes WHERE id = $1 AND NOT from_server`,
      [localId]
    );

    if (result.rows.length === 0) {
      syncLogger.warn('Received response for unknown client change', {
        localId,
        response
      });
      return;
    }

    const change = result.rows[0];

    if (response.success) {
      syncLogger.info('Client change successful', {
        localId,
        table: change.entity_type,
        operation: change.operation
      });

      // Mark as synced in local_changes
      await this.markSynced(db, change.id);

      // Update LSN if provided in response
      if (response.lsn) {
        syncLogger.debug('Updating LSN from client change response', { lsn: response.lsn });
        await this.lsnManager.setLSN(response.lsn);
        
        // Notify main thread of LSN update
        self.postMessage({
          type: 'lsn_update',
          payload: { lsn: response.lsn }
        });
      }
    } else {
      syncLogger.error('Client change failed', {
        localId,
        error: response.error,
        table: change.entity_type,
        operation: change.operation
      });

      // Mark as failed in local_changes
      await this.markFailed(db, change.id, response.error?.message || 'Unknown error');

      // Notify main thread of error
      self.postMessage({
        type: 'error',
        payload: {
          message: 'Client change failed',
          details: {
            localId,
            error: response.error,
            table: change.entity_type,
            operation: change.operation
          }
        }
      });
    }
  }

  /**
   * Process unsynced changes
   */
  public async processUnsyncedChanges(): Promise<void> {
    const db = await getDatabase();
    const changes = await this.getUnsynced(db);

    for (const record of changes) {
      const clientId = await this.lsnManager.getClientId();
      if (!clientId) {
        syncLogger.error('No client ID available for change processing');
        continue;
      }

      // Process the change
      const change: ClientChangeMessage = {
        type: 'client_change',
        clientId,
        change: await this.recordToTableChange(record),
        metadata: {
          local_id: record.id
        }
      };

      await this.processChange(change);
    }
  }
} 