/**
 * Database Message Bus
 * 
 * This module provides a simple message bus for communicating with the database worker
 * without requiring React context.
 */

import { syncLogger } from '../utils/logger';

// Event types
export type DbEventType = 
  | 'initialized'
  | 'error'
  | 'entity_updated'
  | 'entity_deleted'
  | 'query_result'
  | 'transaction_complete'
  | 'changes_table_created'
  | 'change_recorded'
  | 'change_processed'
  | 'processor_started'
  | 'processor_stopped'
  | 'user_created'
  | 'user_updated'
  | 'user_deleted';

// Event listener type
export type DbEventListener = (data: any) => void;

// Command types
export type DbCommandType =
  | 'query'
  | 'upsert'
  | 'delete'
  | 'transaction'
  | 'reset';

// Command interface
export interface DbCommand {
  type: DbCommandType;
  id: string;
  payload: any;
}

// Response interface
export interface DbResponse {
  commandId: string;
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Database Message Bus
 * 
 * A simple message bus for communicating with the database worker.
 */
class DbMessageBus {
  private eventListeners: Map<DbEventType, Set<DbEventListener>> = new Map();
  private commandCallbacks: Map<string, (response: DbResponse) => void> = new Map();
  private commandCounter = 0;
  
  constructor() {
    syncLogger.info('Initializing database message bus');
  }
  
  /**
   * Subscribe to a database event
   * @param eventType The event type to subscribe to
   * @param listener The listener function
   * @returns A function to unsubscribe
   */
  public subscribe(eventType: DbEventType, listener: DbEventListener): () => void {
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, new Set());
    }
    
    this.eventListeners.get(eventType)!.add(listener);
    
    // Return unsubscribe function
    return () => {
      const listeners = this.eventListeners.get(eventType);
      if (listeners) {
        listeners.delete(listener);
      }
    };
  }
  
  /**
   * Publish a database event
   * @param eventType The event type
   * @param data The event data
   */
  public publish(eventType: DbEventType, data: any): void {
    const listeners = this.eventListeners.get(eventType);
    const listenerCount = listeners?.size || 0;
    
    syncLogger.debug(`Publishing ${eventType} event with ${listenerCount} listeners`);
    
    if (listeners && listeners.size > 0) {
      listeners.forEach(listener => {
        try {
          listener(data);
        } catch (error) {
          syncLogger.error(`Error in database event listener for ${eventType}:`, error);
        }
      });
      syncLogger.debug(`Successfully published ${eventType} event to ${listenerCount} listeners`);
    } else {
      syncLogger.debug(`No listeners for ${eventType} event`);
    }
  }
  
  /**
   * Send a command to the database worker
   * @param type The command type
   * @param payload The command payload
   * @returns A promise that resolves with the command response
   */
  public sendCommand<T = any>(type: DbCommandType, payload: any): Promise<T> {
    const commandId = `cmd_${++this.commandCounter}`;
    
    const command: DbCommand = {
      type,
      id: commandId,
      payload
    };
    
    return new Promise<T>((resolve, reject) => {
      // Store callback for when response is received
      this.commandCallbacks.set(commandId, (response: DbResponse) => {
        if (response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response.error || 'Unknown database error'));
        }
        
        // Clean up callback
        this.commandCallbacks.delete(commandId);
      });
      
      // Send command to worker
      // This will be implemented by the service that connects to this bus
      this.dispatchCommand(command);
    });
  }
  
  /**
   * Handle a response from the database worker
   * @param response The response
   */
  public handleResponse(response: DbResponse): void {
    const callback = this.commandCallbacks.get(response.commandId);
    
    if (callback) {
      callback(response);
    } else {
      syncLogger.warn(`No callback found for database command: ${response.commandId}`);
    }
  }
  
  /**
   * Dispatch a command to the database worker
   * This is a placeholder that will be implemented by the service
   * @param command The command to dispatch
   */
  private dispatchCommand(command: DbCommand): void {
    // This will be implemented by the service that connects to this bus
    syncLogger.debug('Command dispatched but no handler registered:', command);
  }
  
  /**
   * Set the command dispatcher function
   * @param dispatcher The function to dispatch commands
   */
  public setCommandDispatcher(dispatcher: (command: DbCommand) => void): void {
    this.dispatchCommand = dispatcher;
  }
}

// Create and export singleton instance
export const dbMessageBus = new DbMessageBus();

// Export default for convenience
export default dbMessageBus; 