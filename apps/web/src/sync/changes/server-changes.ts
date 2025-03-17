/**
 * Server Changes Handler
 * 
 * This module coordinates the processing of server changes directly in the sync worker:
 * - Records changes to the local_changes table
 * - Applies changes to the database
 * - Emits UI updates to main thread
 * - Manages retries for failed changes
 */

import { ServerChange } from '../message-types';
import { 
  ServerChangeProcessor, 
  ServerChangeOptions, 
  ServerChangeResponse,
  ServerChangeRecord
} from './types';
import { applyServerChanges } from './sql-processor';
import { 
  recordServerChange,
  updateChangeStatus,
  getFailedServerChanges
} from './change-recorder';
import { syncLogger, changesLogger } from '../../utils/logger';
import { getDatabase } from '../../db/core';

/**
 * Default options for server change processing
 */
const DEFAULT_OPTIONS: ServerChangeOptions = {
  skipExisting: true,
  retryOnError: true,
  maxRetries: 3
};

/**
 * Implementation of the ServerChangeProcessor interface
 */
export class ServerChangeHandler implements ServerChangeProcessor {
  private options: ServerChangeOptions;

  constructor(options: Partial<ServerChangeOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    changesLogger.logServiceEvent('Server changes handler initialized');
  }

  /**
   * Process a batch of server changes
   */
  async processChanges(
    changes: ServerChange[],
    options: ServerChangeOptions = this.options
  ): Promise<ServerChangeResponse[]> {
    if (!changes.length) return [];

    const db = await getDatabase();
    let transactionStarted = false;
    const responses: ServerChangeResponse[] = [];

    try {
      await db.query('BEGIN');
      transactionStarted = true;

      syncLogger.info(`Processing ${changes.length} server changes`);

      // Process each change in the batch
      for (const change of changes) {
        const { table, operation, data, old_data } = change;
        const id = data?.id || old_data?.id;

        try {
          // Check for skip conditions
          let skipReason = null;
          if ((operation === 'insert' || operation === 'update') && !data) {
            skipReason = `Skipping ${operation} - no data provided`;
          } else if (operation === 'insert') {
            // Check if record exists for inserts only
            const exists = await db.query(
              `SELECT 1 FROM "${table}" WHERE id = $1`,
              [id]
            );
            
            if (exists.rows.length > 0) {
              skipReason = 'Skipping insert - record already exists';
            }
          }

          // Record to history
          const record = await db.query<ServerChangeRecord>(
            `INSERT INTO local_changes (
              entity_type, entity_id, operation, data, 
              timestamp, processed_local, processed_sync, from_server,
              error
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
            [
              table,
              String(id),
              operation,
              JSON.stringify(data || old_data),
              Date.now(),
              !skipReason, // Only mark as processed if not skipped
              false,
              true,
              skipReason // Use error field to record skip reason
            ]
          );

          // Apply the change if not skipped
          if (!skipReason) {
            await applyServerChanges([change]);
            
            // Notify main thread of successful change
            self.postMessage({
              type: 'message',
              payload: {
                type: 'server_change_applied',
                table,
                operation,
                data,
                old_data,
                change_id: record.rows[0].id
              }
            });

            responses.push({ 
              success: true, 
              change_id: record.rows[0].id 
            });
          } else {
            syncLogger.info(skipReason);
            responses.push({ 
              success: true, 
              change_id: record.rows[0].id,
              error: skipReason 
            });
          }
        } catch (error) {
          syncLogger.error(`Error processing change: ${operation} ${table}:${id}`, error);
          
          // Record the error in local_changes
          const record = await db.query<ServerChangeRecord>(
            `INSERT INTO local_changes (
              entity_type, entity_id, operation, data,
              timestamp, processed_local, processed_sync, from_server,
              error, attempts
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *`,
            [
              table,
              String(id),
              operation,
              JSON.stringify(data || old_data),
              Date.now(),
              false,
              false,
              true,
              error instanceof Error ? error.message : String(error),
              1
            ]
          );

          // Notify main thread of failed change
          self.postMessage({
            type: 'error',
            payload: {
              message: 'Failed to process server change',
              details: {
                table,
                operation,
                change_id: record.rows[0].id,
                error: error instanceof Error ? error.message : String(error)
              }
            }
          });

          responses.push({ 
            success: false, 
            change_id: record.rows[0].id,
            error: error instanceof Error ? error.message : String(error)
          });

          if (!options.retryOnError) {
            throw error; // Re-throw to trigger transaction rollback
          }
        }
      }

      await db.query('COMMIT');
      transactionStarted = false;

      return responses;
    } catch (error) {
      syncLogger.error('Failed to process server changes', error);
      
      if (transactionStarted) {
        await db.query('ROLLBACK');
      }
      
      throw error;
    }
  }

  /**
   * Record a single server change
   */
  async recordChange(change: ServerChange): Promise<ServerChangeRecord> {
    return recordServerChange(change);
  }

  /**
   * Retry failed server changes
   */
  async retryFailedChanges(options: ServerChangeOptions = this.options): Promise<void> {
    const failedChanges = await getFailedServerChanges(options.maxRetries);
    
    if (failedChanges.length === 0) {
      return;
    }

    syncLogger.info(`Retrying ${failedChanges.length} failed server changes`);

    // Convert records back to ServerChange format
    const changes: ServerChange[] = failedChanges.map(record => ({
      table: record.entity_type,
      operation: record.operation,
      data: record.data ? JSON.parse(record.data) : null,
      old_data: record.old_data ? JSON.parse(record.old_data) : null
    }));

    // Process the changes
    await this.processChanges(changes, options);
  }
}

// Export a default instance
export const serverChanges = new ServerChangeHandler(); 