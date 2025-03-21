import { Client } from '@neondatabase/serverless';
import { 
  TableChange, 
  SrvMessageType,
  CltMessageType,
  ServerReceivedMessage,
  ServerAppliedMessage,
  ClientChangesMessage,
  ServerChangesMessage,
  ServerMessage
} from '@repo/sync-types';
import { syncLogger } from '../middleware/logger';
import { getDBClient } from '../lib/db';
import type { MinimalContext } from '../types/hono';
import type { WebSocketHandler } from './types';
import type { StateManager } from './state-manager';

const MODULE_NAME = 'client-changes';

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
    
    syncLogger.info('Processing change', {
      clientId: data.client_id,
      table,
      operation,
      id: data.id
    }, MODULE_NAME);
    
    try {
      // Execute the change
      const result = await this.executeChange(change);
      const duration = Date.now() - startTime;

      // Log execution result
      if (result.success) {
        syncLogger.info('Change applied', {
          clientId: data.client_id,
          table,
          operation,
          id: data.id,
          duration,
          fieldCount: result.data ? Object.keys(result.data).length : 0
        }, MODULE_NAME);
      } else if (result.isConflict && result.error?.code === 'CRDT_CONFLICT') {
        syncLogger.info('CRDT conflict detected', {
          clientId: data.client_id,
          table,
          operation,
          id: data.id,
          duration
        }, MODULE_NAME);
      } else {
        syncLogger.warn('Change failed', {
          clientId: data.client_id,
          table,
          operation,
          id: data.id,
          duration,
          errorCode: result.error?.code,
          isConflict: result.isConflict
        }, MODULE_NAME);
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      syncLogger.error('Change processing error', {
        clientId: data.client_id,
        table,
        operation,
        id: data.id,
        duration,
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);

      // Write to changes_history for failed changes
      await this.recordFailedChange(change, error);

      return {
        success: false,
        error: {
          code: 'EXECUTION_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
          details: {
            table,
            operation,
            id: data.id
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
      syncLogger.debug('Recorded to history', {
        clientId: change.data.client_id,
        table: change.table,
        id: change.data.id,
        duration
      }, MODULE_NAME);
    } catch (recordError) {
      const duration = Date.now() - startTime;
      syncLogger.error('History record failed', {
        clientId: change.data.client_id,
        table: change.table,
        id: change.data.id,
        duration,
        error: recordError instanceof Error ? recordError.message : String(recordError)
      }, MODULE_NAME);
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
      syncLogger.debug('SQL executed', {
        clientId: data.client_id,
        table,
        operation,
        id: data.id,
        success: result.success,
        duration
      }, MODULE_NAME);

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Check if this is a CRDT conflict (updatedAt changed)
      if (error instanceof Error && error.message.includes('concurrent update')) {
        syncLogger.info('CRDT conflict', {
          clientId: data.client_id,
          table,
          operation,
          id: data.id,
          duration
        }, MODULE_NAME);

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

      syncLogger.error('SQL error', {
        clientId: data.client_id,
        table,
        operation,
        id: data.id,
        duration,
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);

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
    if (!('id' in data) || typeof data.id !== 'string') {
      throw new Error('Missing or invalid id in update operation');
    }

    // Extract metadata fields but preserve client_id in the data
    const { metadata, id, ...updateData } = data;
    
    // Set client_id directly in the data for WAL
    updateData.client_id = data.client_id;
    
    const fields = Object.keys(updateData);
    const values = Object.values(updateData);
    const setClause = fields.map((f, i) => `"${f}" = $${i + 1}`).join(', ');
    
    const query = `
      UPDATE "${table}"
      SET ${setClause}
      WHERE id = $${values.length + 1}
      RETURNING *
    `;

    const result = await this.client.query(query, [...values, id]);
    return {
      success: true,
      data: result.rows[0]
    };
  }

  private async executeDelete(table: string, id: string): Promise<ExecutionResult> {
    const query = `
      DELETE FROM "${table}"
      WHERE id = $1
      RETURNING *
    `;

    const result = await this.client.query(query, [id]);
    return {
      success: true,
      data: result.rows[0]
    };
  }

  /**
   * Send acknowledgment that we received client changes
   */
  async sendChangesReceived(
    clientId: string,
    changeIds: string[],
    messageHandler: WebSocketHandler
  ): Promise<void> {
    const message: ServerReceivedMessage = {
      type: 'srv_changes_received',
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId,
      changeIds
    };

    try {
      await messageHandler.send(message);
      syncLogger.debug('Ack sent: changes received', {
        clientId,
        count: changeIds.length
      }, MODULE_NAME);
    } catch (err) {
      syncLogger.error('Ack failed: changes received', {
        clientId,
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Send acknowledgment that we applied client changes
   */
  async sendChangesApplied(
    clientId: string,
    changeIds: string[],
    messageHandler: WebSocketHandler,
    success: boolean,
    error?: Error
  ): Promise<void> {
    const message: ServerAppliedMessage = {
      type: 'srv_changes_applied',
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId,
      appliedChanges: changeIds,
      success,
      error: error?.message
    };

    try {
      await messageHandler.send(message);
      syncLogger.debug('Ack sent: changes applied', {
        clientId,
        count: changeIds.length,
        success
      }, MODULE_NAME);
    } catch (err) {
      syncLogger.error('Ack failed: changes applied', {
        clientId,
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
  }
}

/**
 * Process client changes
 */
export async function processClientChanges(
  message: ClientChangesMessage,
  context: MinimalContext,
  messageHandler: WebSocketHandler
): Promise<void> {
  syncLogger.info('Processing batch changes', {
    clientId: message.clientId,
    count: message.changes.length
  }, MODULE_NAME);

  try {
    const dbClient = getDBClient(context);
    const handler = new ClientChangeHandler(dbClient);
    
    // Process changes sequentially
    for (const change of message.changes) {
      const result = await handler.handleChange(change);
      if (!result.success) {
        throw new Error(result.error?.message || 'Change processing failed');
      }
    }

    // Send success response
    const response: ServerChangesMessage = {
      type: 'srv_send_changes',
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId: message.clientId,
      changes: [],
      lastLSN: '0/0'
    };
    await messageHandler.send(response);
  } catch (error) {
    syncLogger.error('Batch processing failed', {
      clientId: message.clientId,
      error: error instanceof Error ? error.message : String(error)
    }, MODULE_NAME);
    
    // Send error response
    const errorResponse: ServerMessage = {
      type: 'srv_error',
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId: message.clientId
    };
    await messageHandler.send(errorResponse);
  }
} 