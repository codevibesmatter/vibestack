import { Client } from '@neondatabase/serverless';
import { 
  TableChange, 
  ServerReceivedMessage,
  ServerAppliedMessage,
  ClientChangesMessage,
  ServerMessage,
  RecordData,
  ExecutionResult
} from '@repo/sync-types';
import { syncLogger } from '../middleware/logger';
import { getDBClient } from '../lib/db';
import type { MinimalContext } from '../types/hono';
import type { WebSocketHandler } from './types';
import { deduplicateChanges } from '../lib/sync-common';
import { SyncConfig, DEFAULT_SYNC_CONFIG } from '../types/sync';

const MODULE_NAME = 'client-changes';

/**
 * Specialized error types for better handling
 */
class DatabaseError extends Error {
  constructor(message: string, public readonly details?: any) {
    super(message);
    this.name = 'DatabaseError';
  }
}

class CRDTConflictError extends Error {
  constructor(message: string, public readonly details: any) {
    super(message);
    this.name = 'CRDTConflictError';
  }
}

class ValidationError extends Error {
  constructor(message: string, public readonly details?: any) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Main change processor that handles all operations
 */
export class ChangeProcessor {
  constructor(
    private client: Client,
    private messageHandler: WebSocketHandler,
    private config: SyncConfig = DEFAULT_SYNC_CONFIG
  ) {}

  /**
   * Process client changes - main entry point
   */
  async processChanges(message: ClientChangesMessage): Promise<void> {
    const { clientId, changes } = message;
    
    // Single log at start
    syncLogger.info(`Processing ${changes.length} changes for client ${clientId}`, {
      clientId,
      messageId: message.messageId,
      changeCount: changes.length,
      timestamp: new Date().toISOString()
    }, MODULE_NAME);

    try {
      // Set statement timeout
      await this.setStatementTimeout();
      
      // Extract change IDs for acknowledgment
      const changeIds = changes.map(change => (change.data as RecordData).id);
      
      // Send received acknowledgment first
      try {
        await this.sendChangesReceived(clientId, changeIds);
      } catch (ackError) {
        syncLogger.error(`Failed to send received acknowledgment for client ${clientId}`, {
          clientId,
          error: ackError instanceof Error ? ackError.message : String(ackError),
          timestamp: new Date().toISOString()
        }, MODULE_NAME);
        // Continue processing even if acknowledgment fails
      }
      
      // Deduplicate changes
      const optimizedChanges = deduplicateChanges(changes);
      
      // Process changes - no transaction needed as we're grouping by table/operation
      // and letting the database handle CRDT conflicts
      const results = await this.processAllChanges(optimizedChanges);
      
      // Summarize results
      const summary = this.summarizeResults(results);
      
      // Send applied acknowledgment
      try {
        await this.sendChangesApplied(
          clientId, 
          changeIds,
          summary.allSuccessful,
          summary.lastError
        );
      } catch (appliedError) {
        syncLogger.error(`Failed to send applied acknowledgment for client ${clientId}`, {
          clientId,
          error: appliedError instanceof Error ? appliedError.message : String(appliedError),
          timestamp: new Date().toISOString()
        }, MODULE_NAME);
      }
      
      // Single log at completion with summary
      syncLogger.info(`Completed processing ${optimizedChanges.length} changes for client ${clientId}`, {
        clientId,
        appliedCount: summary.appliedCount,
        skippedCount: summary.skippedCount,
        success: summary.allSuccessful,
        timestamp: new Date().toISOString()
      }, MODULE_NAME);
    } catch (error) {
      syncLogger.error(`Processing failed for client ${clientId}`, {
        clientId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      }, MODULE_NAME);
      
      // Send error response
      try {
        await this.sendError(clientId, error instanceof Error ? error : new Error(String(error)));
      } catch (errorSendError) {
        syncLogger.error(`Failed to send error message to client ${clientId}`, {
          clientId,
          error: errorSendError instanceof Error ? errorSendError.message : String(errorSendError),
          timestamp: new Date().toISOString()
        }, MODULE_NAME);
      }
      
      throw error; // Re-throw the original error
    }
  }
  
  /**
   * Process all changes, grouped by table and operation
   */
  private async processAllChanges(changes: TableChange[]): Promise<ExecutionResult[]> {
    syncLogger.info(`Processing ${changes.length} changes in batches`, {
      timestamp: new Date().toISOString()
    }, MODULE_NAME);
    
    // Group changes by table and operation
    const groups = this.groupChangesByTableAndOperation(changes);
    const results: ExecutionResult[] = [];
    const processingMap = new Map<string, boolean>(); // Track which changes were processed
    
    syncLogger.info(`Grouped into ${groups.length} operation groups`, {
      groups: groups.map(g => `${g.table}:${g.operation}:${g.changes.length}`),
      timestamp: new Date().toISOString()
    }, MODULE_NAME);
    
    // Track all changes by ID for conflict detection
    for (const change of changes) {
      const data = change.data as RecordData;
      processingMap.set(data.id, false); // Initially mark all as unprocessed
    }
    
    // Process each group
    for (const group of groups) {
      syncLogger.info(`Processing group ${group.table}:${group.operation} with ${group.changes.length} changes`, {
        timestamp: new Date().toISOString()
      }, MODULE_NAME);
      
      try {
        let batchResults: any[] = [];
        
        switch (group.operation) {
          case 'insert':
            // Use true batch insert for better performance
            if (group.changes.length > 1) {
              batchResults = await this.executeBatchInsert(group.table, group.changes);
            } else {
              batchResults = await this.executeBatch(group.table, group.changes, this.executeInsert.bind(this));
            }
            break;
          case 'update':
            // We can use batch for updates too since we're already grouping by table
            batchResults = await this.executeBatch(group.table, group.changes, this.executeUpdate.bind(this));
            break;
          case 'delete':
            batchResults = await this.executeBatch(
              group.table, 
              group.changes, 
              (table, data) => this.executeDelete(table, data.id, data.updated_at)
            );
            break;
        }
        
        // Mark successful changes
        for (const result of batchResults) {
          if (result && result.id) {
            processingMap.set(result.id, true); // Mark as processed
            results.push({ success: true, data: result });
          }
        }
      } catch (error) {
        syncLogger.error(`Group processing failed: ${group.table} ${group.operation}: ${
          error instanceof Error ? error.message : String(error)
        }`, {
          error: error instanceof Error ? error.stack : String(error),
          timestamp: new Date().toISOString()
        }, MODULE_NAME);
        
        // Fall back to individual processing
        try {
          syncLogger.info(`Falling back to individual processing for ${group.table}:${group.operation}`, {
            timestamp: new Date().toISOString()
          }, MODULE_NAME);
          
          const individualResults = await this.processIndividually(
            group.table, 
            group.changes, 
            group.operation
          );
          
          syncLogger.info(`Individual processing complete for ${group.table}:${group.operation}, got ${individualResults.length} results`, {
            timestamp: new Date().toISOString()
          }, MODULE_NAME);
          
          // Mark successful individual changes
          for (const result of individualResults) {
            if (result && result.id) {
              processingMap.set(result.id, true); // Mark as processed
              results.push({ success: true, data: result });
            }
          }
        } catch (individualError) {
          syncLogger.error(`Individual processing also failed: ${
            individualError instanceof Error ? individualError.message : String(individualError)
          }`, {
            error: individualError instanceof Error ? individualError.stack : String(individualError),
            timestamp: new Date().toISOString()
          }, MODULE_NAME);
        }
      }
    }
    
    // Add results for skipped changes (likely CRDT conflicts)
    let skippedCount = 0;
    for (const change of changes) {
      const data = change.data as RecordData;
      if (!processingMap.get(data.id)) {
        skippedCount++;
        // This change was skipped - likely a database-level CRDT conflict
        results.push({
          success: true, // Not an error, just skipped
          skipped: true,
          isConflict: true,
          error: {
            code: 'CRDT_CONFLICT',
            message: 'Change skipped due to database-level CRDT rules',
            details: {
              table: change.table,
              operation: change.operation,
              id: data.id
            }
          }
        });
      }
    }
    
    syncLogger.info(`All changes processed: ${results.length - skippedCount} successful, ${skippedCount} skipped`, {
      timestamp: new Date().toISOString()
    }, MODULE_NAME);
    
    return results;
  }
  
  /**
   * Execute a batch operation with a common executor function
   */
  private async executeBatch(
    table: string, 
    changes: TableChange[],
    executor: (table: string, data: RecordData) => Promise<any>
  ): Promise<any[]> {
    if (changes.length === 0) return [];
    if (changes.length === 1) {
      const timeoutPromise = new Promise<null>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Single operation timed out after 10000ms`));
        }, 10000);
      });
      
      try {
        const result = await Promise.race([
          executor(table, changes[0].data as RecordData),
          timeoutPromise
        ]);
        return result ? [result] : [];
      } catch (error) {
        syncLogger.error(`Single operation timed out or failed: ${error instanceof Error ? error.message : String(error)}`, {
          table,
          operation: changes[0].operation,
          id: (changes[0].data as RecordData).id,
          timestamp: new Date().toISOString()
        }, MODULE_NAME);
        return [];
      }
    }
    
    const results: any[] = [];
    
    // Process each change with a timeout
    for (const change of changes) {
      try {
        const data = change.data as RecordData;
        
        const timeoutPromise = new Promise<null>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Operation timed out after 10000ms`));
          }, 10000);
        });
        
        syncLogger.debug(`Executing operation on ${table} for id ${data.id}`, {
          table,
          operation: change.operation,
          id: data.id,
          timestamp: new Date().toISOString()
        }, MODULE_NAME);
        
        const result = await Promise.race([
          executor(table, data),
          timeoutPromise
        ]);
        
        // Only add successful results (null results are CRDT conflicts)
        if (result) {
          syncLogger.debug(`Operation succeeded on ${table} for id ${data.id}`, {
            table,
            operation: change.operation,
            id: data.id,
            timestamp: new Date().toISOString()
          }, MODULE_NAME);
          results.push(result);
        } else {
          syncLogger.debug(`Operation skipped on ${table} for id ${data.id} (CRDT conflict)`, {
            table,
            operation: change.operation,
            id: data.id,
            timestamp: new Date().toISOString()
          }, MODULE_NAME);
        }
      } catch (error) {
        // Log the error but continue processing other changes
        syncLogger.warn(`Error processing change ${table}:${change.operation} ${(change.data as RecordData).id}: ${
          error instanceof Error ? error.message : String(error)
        }`, {
          error: error instanceof Error ? error.stack : String(error),
          timestamp: new Date().toISOString()
        }, MODULE_NAME);
      }
    }
    
    return results;
  }
  
  /**
   * Process changes individually
   */
  private async processIndividually(
    table: string, 
    changes: TableChange[], 
    operation: string
  ): Promise<any[]> {
    const results: any[] = [];
    
    for (const change of changes) {
      try {
        const data = change.data as RecordData;
        let result: any;
        
        switch (operation) {
          case 'insert':
            result = await this.executeInsert(table, data);
            break;
          case 'update':
            result = await this.executeUpdate(table, data);
            break;
          case 'delete':
            result = await this.executeDelete(table, data.id, data.updated_at);
            break;
        }
        
        // Only add successful results (null results are CRDT conflicts)
        if (result) results.push(result);
      } catch (error) {
        // Log the error but continue processing other changes
        syncLogger.warn(`Error processing individual change ${table}:${change.operation} ${(change.data as RecordData).id}: ${
          error instanceof Error ? error.message : String(error)
        }`);
      }
    }
    
    return results;
  }
  
  /**
   * Group changes by table and operation
   */
  private groupChangesByTableAndOperation(changes: TableChange[]): Array<{
    table: string;
    operation: string;
    changes: TableChange[];
  }> {
    const groups: Array<{
      table: string;
      operation: string;
      changes: TableChange[];
    }> = [];
    
    const groupMap = new Map<string, TableChange[]>();
    
    // Group changes by table and operation
    for (const change of changes) {
      const key = `${change.table}:${change.operation}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, []);
      }
      groupMap.get(key)!.push(change);
    }
    
    // Convert to array of groups
    for (const [key, changes] of groupMap.entries()) {
      const [table, operation] = key.split(':');
      groups.push({ table, operation, changes });
    }
    
    return groups;
  }
  
  /**
   * Execute an insert operation
   */
  private async executeInsert(table: string, data: RecordData): Promise<any> {
    // Validate data
    if (!data.id) {
      throw new ValidationError('Missing id in insert operation');
    }
    
    const { metadata, ...insertData } = data as any;
    
    // Ensure client_id is included
    insertData.client_id = data.client_id;
    
    const fields = Object.keys(insertData);
    const values = Object.values(insertData);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    
    // Build upsert query - CRDT timestamp check is handled by trigger
    const query = `
      INSERT INTO "${table}" (${fields.map(f => `"${f}"`).join(', ')})
      VALUES (${placeholders})
      ON CONFLICT (id) DO UPDATE 
      SET ${fields
        .filter(f => f !== 'id')
        .map(f => `"${f}" = EXCLUDED."${f}"`)
        .join(', ')}
      RETURNING *
    `;

    try {
      const result = await this.client.query(query, values);
      
      // If no rows returned, it was likely rejected by the CRDT trigger
      if (result.rowCount === 0) {
        // Just report as a conflict without extra fetch
        return null;
      }
      
      return result.rows[0];
    } catch (error) {
      throw new DatabaseError(
        error instanceof Error ? error.message : String(error),
        { table, operation: 'insert', id: data.id }
      );
    }
  }
  
  /**
   * Execute an update operation
   */
  private async executeUpdate(table: string, data: RecordData): Promise<any> {
    // Validate data
    if (!data.id) {
      throw new ValidationError('Missing id in update operation');
    }
    
    const { metadata, id, ...updateData } = data as any;
    
    // Ensure client_id is included
    updateData.client_id = data.client_id;
    
    const fields = Object.keys(updateData);
    const values = Object.values(updateData);
    const setClause = fields.map((f, i) => `"${f}" = $${i + 1}`).join(', ');
    
    // Build update query - CRDT timestamp check is handled by trigger
    const query = `
      UPDATE "${table}"
      SET ${setClause}
      WHERE id = $${values.length + 1}
      RETURNING *
    `;

    try {
      const result = await this.client.query(query, [...values, id]);
      
      // If no rows affected, the record doesn't exist or CRDT trigger rejected it
      if (result.rowCount === 0) {
        // Just return null, let caller handle it
        return null;
      }
      
      return result.rows[0];
    } catch (error) {
      throw new DatabaseError(
        error instanceof Error ? error.message : String(error),
        { table, operation: 'update', id: data.id }
      );
    }
  }
  
  /**
   * Execute a delete operation
   */
  private async executeDelete(table: string, id: string, timestamp: string): Promise<any> {
    // For deletes, we still need the timestamp check in WHERE clause
    // since triggers don't prevent DELETE operations the same way
    const query = `
      DELETE FROM "${table}"
      WHERE id = $1
      AND updated_at <= $2
      RETURNING *
    `;

    try {
      const result = await this.client.query(query, [id, timestamp]);
      return result.rows[0] || null;
    } catch (error) {
      throw new DatabaseError(
        error instanceof Error ? error.message : String(error),
        { table, operation: 'delete', id }
      );
    }
  }
  
  /**
   * Fetch a record from the database - only used when absolutely necessary
   */
  private async fetchCurrentRecord(table: string, id: string): Promise<any> {
    try {
      const query = `
        SELECT * 
        FROM "${table}" 
        WHERE id = $1 
        LIMIT 1
      `;
      
      const result = await this.client.query(query, [id]);
      return result.rows[0] || null;
    } catch (error) {
      throw new DatabaseError(
        error instanceof Error ? error.message : String(error),
        { table, operation: 'fetch', id }
      );
    }
  }
  
  /**
   * Summarize execution results
   */
  private summarizeResults(results: ExecutionResult[]): {
    allSuccessful: boolean;
    lastError?: Error;
    appliedCount: number;
    skippedCount: number;
  } {
    let allSuccessful = true;
    let lastError: Error | undefined;
    let appliedCount = 0;
    let skippedCount = 0;
    
    for (const result of results) {
      if (!result.success) {
        allSuccessful = false;
        lastError = new Error(result.error?.message || 'Change processing failed');
      } else if (result.skipped) {
        skippedCount++;
      } else {
        appliedCount++;
      }
    }
    
    return { allSuccessful, lastError, appliedCount, skippedCount };
  }
  
  /**
   * Send acknowledgment that we received client changes
   */
  private async sendChangesReceived(
    clientId: string,
    changeIds: string[]
  ): Promise<void> {
    const message: ServerReceivedMessage = {
      type: 'srv_changes_received',
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      clientId,
      changeIds
    };

    try {
      // Send the message directly without retry logic
      await this.messageHandler.send(message);
    } catch (error) {
      syncLogger.error(`Failed to send 'received' acknowledgment to client ${clientId}`, {
        clientId,
        messageType: message.type,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      }, MODULE_NAME);
      throw error; // Re-throw to handle in the calling method
    }
  }

  /**
   * Send acknowledgment that we applied client changes
   */
  private async sendChangesApplied(
    clientId: string,
    changeIds: string[],
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
      // Send the message directly without retry logic
      await this.messageHandler.send(message);
    } catch (error) {
      syncLogger.error(`Failed to send 'applied' acknowledgment to client ${clientId}`, {
        clientId,
        messageType: message.type,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      }, MODULE_NAME);
      throw error; // Re-throw to handle in the calling method
    }
  }

  /**
   * Send error message to client
   */
  private async sendError(clientId: string, error?: Error): Promise<void> {
    // Create a simple message with just the required fields for ServerMessage
    const errorResponse = {
      type: 'srv_error' as const,
      messageId: `srv_${Date.now()}_error`,
      timestamp: Date.now(),
      clientId,
      // We don't add any additional fields that aren't in the type
    };

    try {
      await this.messageHandler.send(errorResponse);
    } catch (sendError) {
      syncLogger.error(`Failed to send error message to client ${clientId}`, {
        clientId,
        originalError: error?.message || 'Unknown error',
        sendError: sendError instanceof Error ? sendError.message : String(sendError),
        timestamp: new Date().toISOString()
      }, MODULE_NAME);
      // We don't re-throw here since this is already handling an error condition
    }
  }
  
  /**
   * Set statement timeout
   */
  private async setStatementTimeout(): Promise<void> {
    // Only log errors, no need for info logs about setting timeout
    try {
      // Add a local timeout to prevent hanging indefinitely
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Statement timeout setting timed out after 5000ms`));
        }, 5000);
      });
      
      // Race the query against a timeout
      await Promise.race([
        this.client.query(`SET statement_timeout = ${this.config.database.statementTimeoutMs}`),
        timeoutPromise
      ]);
    } catch (error) {
      syncLogger.error(`Failed to set statement timeout: ${error instanceof Error ? error.message : String(error)}`, {
        timeout: this.config.database.statementTimeoutMs,
        timestamp: new Date().toISOString()
      }, MODULE_NAME);
      // Continue execution even if setting the timeout fails
    }
  }

  /**
   * Perform a true batch insert with a multi-row VALUES clause for better performance
   */
  private async executeBatchInsert(table: string, changes: TableChange[]): Promise<any[]> {
    if (changes.length === 0) return [];
    if (changes.length === 1) return [await this.executeInsert(table, changes[0].data as RecordData)].filter(Boolean);
    
    // First determine the complete set of fields from all records
    const allFields = new Set<string>();
    for (const change of changes) {
      const data = change.data as RecordData;
      Object.keys(data).forEach(key => {
        if (key !== 'metadata') { // Skip metadata as it's not a DB field
          allFields.add(key);
        }
      });
    }
    
    const fields = Array.from(allFields);
    const placeholders: string[] = [];
    const allValues: any[] = [];
    let paramIndex = 1;
    
    // Build values for each row
    for (const change of changes) {
      const data = change.data as RecordData;
      const rowPlaceholders: string[] = [];
      
      // For each field in our complete field list
      for (const field of fields) {
        if (field === 'metadata') continue; // Skip metadata
        
        // Use the value if present or NULL
        const value = data[field as keyof RecordData];
        allValues.push(value !== undefined ? value : null);
        rowPlaceholders.push(`$${paramIndex++}`);
      }
      
      placeholders.push(`(${rowPlaceholders.join(', ')})`);
    }
    
    // Build the ON CONFLICT update clause
    const updateClause = fields
      .filter(f => f !== 'id') // Don't update the id
      .map(f => `"${f}" = EXCLUDED."${f}"`)
      .join(', ');
    
    // Build the full query
    const query = `
      INSERT INTO "${table}" (${fields.map(f => `"${f}"`).join(', ')})
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (id) DO UPDATE 
      SET ${updateClause}
      RETURNING *
    `;
    
    try {
      // Add a timeout to the batch insert
      const timeoutPromise = new Promise<null>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Batch insert timed out after 20000ms`));
        }, 20000);
      });
      
      syncLogger.info(`Executing batch insert for ${table} with ${changes.length} records`, {
        table,
        recordCount: changes.length,
        timestamp: new Date().toISOString()
      }, MODULE_NAME);
      
      const result = await Promise.race([
        this.client.query(query, allValues),
        timeoutPromise
      ]);
      
      if (!result) {
        throw new Error('Query result is null');
      }
      
      syncLogger.info(`Batch insert completed for ${table}: ${result.rowCount} rows affected`, {
        table,
        rowCount: result.rowCount,
        timestamp: new Date().toISOString()
      }, MODULE_NAME);
      
      return result.rows;
    } catch (error) {
      syncLogger.error(`Batch insert failed for ${table} (${changes.length} records): ${
        error instanceof Error ? error.message : String(error)
      }`, {
        table,
        recordCount: changes.length,
        error: error instanceof Error ? error.stack : String(error),
        timestamp: new Date().toISOString()
      }, MODULE_NAME);
      
      // Fall back to individual inserts
      syncLogger.info(`Falling back to individual inserts for ${table}`, {
        table,
        recordCount: changes.length,
        timestamp: new Date().toISOString()
      }, MODULE_NAME);
      
      return this.executeBatch(table, changes, this.executeInsert.bind(this));
    }
  }
}

/**
 * Process client changes - main entry point
 */
export async function processClientChanges(
  message: ClientChangesMessage,
  context: MinimalContext,
  messageHandler: WebSocketHandler,
  config: SyncConfig = DEFAULT_SYNC_CONFIG
): Promise<void> {
  const dbClient = getDBClient(context);
  
  try {
    // Connect to the database before processing
    await dbClient.connect();
    
    const processor = new ChangeProcessor(dbClient, messageHandler, config);
    await processor.processChanges(message);
  } catch (error) {
    syncLogger.error(`Failed to process client changes: ${error instanceof Error ? error.message : String(error)}`, {
      clientId: message.clientId,
      messageId: message.messageId,
      timestamp: new Date().toISOString()
    }, MODULE_NAME);
    throw error;
  } finally {
    // Ensure we always close the connection
    try {
      await dbClient.end();
    } catch (err) {
      // Just silently close the connection - no need to log errors here
    }
  }
} 