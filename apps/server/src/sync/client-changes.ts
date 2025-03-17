import { Client } from '@neondatabase/serverless';
import { TableChange, SrvMessageType, CltMessageType } from '@repo/sync-types';
import { syncLogger } from '../middleware/logger';
import { ChangeHistory } from '@repo/typeorm/server-entities';
import { 
  CltChanges,
  SrvChangesReceived,
  SrvChangesApplied
} from '@repo/sync-types';
import type { MessageContext, MessageSender } from './message-handler';
import { getDBClient } from '../lib/db';

/**
 * Result of executing a client change
 */
interface ExecutionResult {
  success: boolean;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  data?: any;
  isConflict?: boolean;
}

/**
 * Handles client changes by executing them directly against the database.
 * No validation is performed as we let the WAL handle that naturally.
 */
export class ClientChangeHandler {
  constructor(private client: Client) {}

  /**
   * Handle a client change
   */
  async handleChange(change: TableChange): Promise<ExecutionResult> {
    const startTime = Date.now();
    const { table, operation, data } = change;
    
    syncLogger.info('Processing client change', {
      table,
      operation,
      dataFields: Object.keys(data || {})
    });
    
    try {
      // Execute the change
      const result = await this.executeChange(change);
      const duration = Date.now() - startTime;

      // Log execution result
      if (result.success) {
        syncLogger.info('Client change executed successfully', {
          table,
          operation,
          duration,
          affectedFields: result.data ? Object.keys(result.data) : []
        });
      } else if (result.isConflict && result.error?.code === 'CRDT_CONFLICT') {
        syncLogger.info('CRDT conflict detected (normal behavior)', {
          table,
          operation,
          duration,
          conflictDetails: result.error.details
        });
      } else {
        syncLogger.warn('Client change execution failed', {
          table,
          operation,
          duration,
          error: result.error,
          isConflict: result.isConflict
        });
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      syncLogger.error('Unexpected error processing client change', {
        table,
        operation,
        duration,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });

      // Write to changes_history for failed changes
      await this.recordFailedChange(change, error);

      return {
        success: false,
        error: {
          code: 'EXECUTION_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
          details: {
            table: change.table,
            operation: change.operation
          }
        }
      };
    }
  }

  /**
   * Record a failed change to changes_history
   */
  private async recordFailedChange(change: TableChange, error: any): Promise<void> {
    const startTime = Date.now();
    const timestamp = new Date();
    
    try {
      const query = `
        INSERT INTO change_history (
          table_name, operation, data,
          updated_at
        ) VALUES ($1, $2, $3, $4)
      `;

      await this.client.query(query, [
        change.table,
        change.operation,
        change.data,
        timestamp
      ]);

      const duration = Date.now() - startTime;
      syncLogger.info('Failed change recorded to history', {
        table: change.table,
        operation: change.operation,
        duration,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch (recordError) {
      const duration = Date.now() - startTime;
      syncLogger.error('Failed to record failed change', {
        error: recordError,
        duration,
        originalError: error,
        change: {
          table: change.table,
          operation: change.operation
        }
      });
    }
  }

  /**
   * Execute a client change directly against the database
   */
  private async executeChange(change: TableChange): Promise<ExecutionResult> {
    const startTime = Date.now();
    const { table, operation, data } = change;
    
    try {
      let result: ExecutionResult;
      switch (operation) {
        case 'insert':
          result = await this.executeInsert(table, data);
          break;
        case 'update':
          result = await this.executeUpdate(table, data);
          break;
        case 'delete':
          if (!('id' in data) || typeof data.id !== 'string') {
            throw new Error('Missing or invalid id in delete operation');
          }
          result = await this.executeDelete(table, data.id);
          break;
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }

      const duration = Date.now() - startTime;
      syncLogger.debug('SQL execution completed', {
        table,
        operation,
        duration,
        success: result.success,
        isConflict: result.isConflict
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Check if this is a CRDT conflict (updatedAt changed)
      if (error instanceof Error && error.message.includes('concurrent update')) {
        syncLogger.info('CRDT conflict detected in SQL execution', {
          table,
          operation,
          duration,
          errorMessage: error.message
        });

        return {
          success: false,
          isConflict: true,
          error: {
            code: 'CRDT_CONFLICT',
            message: 'Concurrent update detected',
            details: { table, operation }
          }
        };
      }

      syncLogger.error('SQL execution failed', {
        table,
        operation,
        duration,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });

      return {
        success: false,
        error: {
          code: 'EXECUTION_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  private async executeInsert(table: string, data: any): Promise<ExecutionResult> {
    // Extract metadata fields but preserve client_id in the data
    const { metadata, ...insertData } = data;
    
    // Set client_id directly in the data for WAL
    insertData.client_id = data.client_id;
    
    const fields = Object.keys(insertData);
    const values = Object.values(insertData);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    
    const query = `
      INSERT INTO "${table}" (${fields.map(f => `"${f}"`).join(', ')})
      VALUES (${placeholders})
      RETURNING *
    `;

    const result = await this.client.query(query, values);
    return {
      success: true,
      data: result.rows[0]
    };
  }

  private async executeUpdate(table: string, data: any): Promise<ExecutionResult> {
    // First check if entity exists and get current updatedAt
    const exists = await this.client.query(
      `SELECT "updatedAt" FROM "${table}" WHERE "id" = $1`,
      [data.id]
    );

    if (exists.rows.length === 0) {
      return {
        success: false,
        error: {
          code: 'ENTITY_NOT_FOUND',
          message: 'Entity not found',
          details: { table, id: data.id }
        }
      };
    }

    syncLogger.info('CRDT update check', {
      table,
      id: data.id,
      dbUpdatedAt: exists.rows[0].updatedAt,
      clientData: {
        updatedAt: data.updatedAt,
        old_data: data.old_data
      }
    });

    // Extract just the fields we want to update, excluding metadata fields
    const { id, createdAt, updatedAt, metadata, ...updateData } = data;
    
    // Set client_id directly in the data for WAL
    updateData.client_id = data.client_id;
    
    const fields = Object.keys(updateData);
    const values = Object.values(updateData);
    const setClause = fields.map((field, i) => `"${field}" = $${i + 1}`).join(', ');

    // Add updatedAt condition to detect concurrent updates
    const query = `
      UPDATE "${table}"
      SET 
        ${setClause}${setClause ? ',' : ''} 
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $${values.length + 1}
      AND (
        "updatedAt" < $${values.length + 2}
        OR "updatedAt" IS NULL
      )
      RETURNING *
    `;

    const result = await this.client.query(query, [...values, id, data.updatedAt]);
    
    // If no rows updated, it might be a concurrent update
    if (result.rowCount === 0) {
      // Query current state to see what changed
      const current = await this.client.query(
        `SELECT "updatedAt" FROM "${table}" WHERE "id" = $1`,
        [id]
      );

      return {
        success: false,
        isConflict: true,
        error: {
          code: 'CRDT_CONFLICT',
          message: 'Concurrent update detected - database has newer changes',
          details: { 
            table, 
            id,
            expectedUpdatedAt: exists.rows[0].updatedAt,
            actualUpdatedAt: current.rows[0]?.updatedAt,
            clientData: {
              updatedAt: data.updatedAt,
              old_data: data.old_data
            }
          }
        }
      };
    }

    return {
      success: true,
      data: result.rows[0]
    };
  }

  private async executeDelete(table: string, id: string): Promise<ExecutionResult> {
    // First check if entity exists
    const exists = await this.client.query(
      `SELECT 1 FROM "${table}" WHERE "id" = $1`,
      [id]
    );

    if (exists.rows.length === 0) {
      return {
        success: false,
        error: {
          code: 'ENTITY_NOT_FOUND',
          message: 'Entity not found',
          details: { table, id }
        }
      };
    }

    const query = `
      DELETE FROM "${table}"
      WHERE "id" = $1
      RETURNING *
    `;

    const result = await this.client.query(query, [id]);
    return {
      success: true,
      data: result.rows[0]
    };
  }
}

/**
 * Process changes from a client
 */
export async function processClientChanges(
  message: { type: CltMessageType; clientId: string; changes: TableChange[] },
  ctx: MessageContext,
  sender: MessageSender
): Promise<void> {
  syncLogger.info('Handling client changes', {
    clientId: message.clientId,
    changeCount: message.changes.length
  });

  // Collect LSNs once
  const changeLSNs: string[] = [];
  for (const change of message.changes) {
    changeLSNs.push(change.lsn);
  }

  // Send received acknowledgment
  const receivedAck = {
    type: 'srv_changes_received' as SrvMessageType,
    messageId: `srv_${Date.now()}`,
    timestamp: Date.now(),
    clientId: message.clientId,
    changeIds: changeLSNs
  };

  await sender.send(receivedAck);

  // Process the changes
  try {
    const dbClient = getDBClient(ctx.context);
    const handler = new ClientChangeHandler(dbClient);
    
    // Process changes sequentially
    for (const change of message.changes) {
      const result = await handler.handleChange(change);
      if (!result.success) {
        throw new Error(result.error?.message || 'Change processing failed');
      }
    }

    // Send applied acknowledgment
    const appliedAck = {
      type: 'srv_changes_applied' as SrvMessageType,
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId: message.clientId,
      success: true,
      appliedChanges: changeLSNs
    };

    await sender.send(appliedAck);
  } catch (error) {
    syncLogger.error('Error handling client changes:', error);
    
    const errorAck = {
      type: 'srv_changes_applied' as SrvMessageType,
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId: message.clientId,
      success: false,
      error: {
        code: 'CHANGE_PROCESSING_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      appliedChanges: []
    };

    await sender.send(errorAck);
  }
} 