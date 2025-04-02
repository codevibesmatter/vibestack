import { EventEmitter } from 'events';
import { createLogger } from './logger.ts';
import type { ServerChangesMessage, TableChange } from '@repo/sync-types';
import type { EntityChange, EntityType, Operation } from '../types.ts';

/**
 * Message handler function type
 */
export type MessageHandler = (message: any) => Promise<boolean> | boolean;

/**
 * Configuration options for the MessageDispatcher
 */
export interface MessageDispatcherOptions {
  verbose?: boolean;
  strictValidation?: boolean;
  allowedEntityTypes?: string[];
  allowedOperations?: string[];
}

/**
 * MessageDispatcher serves as a central hub for all message routing and processing
 * It connects different message sources (WebSocket, API, etc.) to message handlers
 * Also processes raw messages into domain objects
 */
export class MessageDispatcher extends EventEmitter {
  private logger = createLogger('MsgDispatcher');
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private clientLSNMap: Map<string, string> = new Map();
  private idMapping: Record<string, string> = {};
  private options: MessageDispatcherOptions;
  
  constructor(options?: MessageDispatcherOptions) {
    super(); // Initialize EventEmitter
    
    this.options = {
      verbose: false,
      strictValidation: true,
      allowedEntityTypes: ['task', 'project', 'user', 'comment'],
      allowedOperations: ['create', 'update', 'delete'],
      ...options
    };
    
    this.logger.info('MessageDispatcher initialized');
  }
  
  /**
   * Register a handler for a specific message type
   */
  public registerHandler(messageType: string, handler: MessageHandler): void {
    if (!this.handlers.has(messageType)) {
      this.handlers.set(messageType, new Set());
    }
    
    this.handlers.get(messageType)!.add(handler);
    this.logger.debug(`Registered handler for message type: ${messageType}`);
  }
  
  /**
   * Remove a handler for a specific message type
   */
  public removeHandler(messageType: string, handler: MessageHandler): void {
    if (this.handlers.has(messageType)) {
      const handlers = this.handlers.get(messageType)!;
      handlers.delete(handler);
      
      if (handlers.size === 0) {
        this.handlers.delete(messageType);
      }
      
      this.logger.debug(`Removed handler for message type: ${messageType}`);
    }
  }
  
  /**
   * Remove all handlers for a specific message type
   */
  public removeAllHandlers(messageType: string): void {
    if (this.handlers.has(messageType)) {
      this.handlers.delete(messageType);
      this.logger.debug(`Removed all handlers for message type: ${messageType}`);
    }
  }
  
  /**
   * Dispatch a message to all registered handlers of its type
   * Returns true if the message was handled by at least one handler
   */
  public async dispatchMessage(message: any): Promise<boolean> {
    if (!message || !message.type) {
      this.logger.warn('Received invalid message without type');
      return false;
    }
    
    const messageType = message.type;
    const clientId = message.clientId;
    
    // Log all incoming messages for debugging (reduce to debug level)
    this.logger.debug(`Received message of type: ${messageType} for client: ${clientId}`);
    
    // Pre-process server message types
    if (messageType.startsWith('srv_')) {
      this.preprocessServerMessage(message);
    }
    
    // Emit the message as an event (for EventEmitter compatibility)
    this.emit(messageType, message);
    
    // If no handlers are registered for this message type, return false
    if (!this.handlers.has(messageType)) {
      // Only log at debug level to reduce noise
      this.logger.debug(`No handlers registered for message type: ${messageType}`);
      return false;
    }
    
    // Call all registered handlers
    const handlers = Array.from(this.handlers.get(messageType)!);
    this.logger.debug(`Dispatching message ${messageType} to ${handlers.length} handlers`);
    
    let handled = false;
    
    for (const handler of handlers) {
      try {
        const result = await handler(message);
        handled = handled || !!result;
      } catch (error) {
        this.logger.error(`Error in message handler for ${messageType}: ${error}`);
      }
    }
    
    return handled;
  }
  
  /**
   * Check if there are any handlers registered for a message type
   */
  public hasHandlers(messageType: string): boolean {
    return this.handlers.has(messageType) && this.handlers.get(messageType)!.size > 0;
  }
  
  /**
   * Pre-process server messages to extract useful information and enhance them
   */
  private preprocessServerMessage(message: any): void {
    const clientId = message.clientId;
    
    if (!clientId) {
      this.logger.warn('Server message missing clientId');
      return;
    }
    
    if (message.type === 'srv_live_changes' || message.type === 'srv_catchup_changes') {
      // Process server changes message
      const serverMessage = message as ServerChangesMessage;
      
      // Log more details for catchup messages
      if (message.type === 'srv_catchup_changes' && this.options.verbose) {
        this.logger.info(`Catchup change received: chunk=${serverMessage.sequence?.chunk}/${serverMessage.sequence?.total}, changes=${serverMessage.changes?.length || 0}, LSN=${serverMessage.lastLSN || 'none'}`);
      }
      
      // Update client's LSN if available
      if (serverMessage.lastLSN) {
        this.updateClientLSN(clientId, serverMessage.lastLSN);
      }
      
      // Process the changes for easier consumption by handlers
      if (serverMessage.changes && Array.isArray(serverMessage.changes)) {
        // Log original table names for debugging (at debug level)
        const tableNames = [...new Set(serverMessage.changes.map(c => c.table))];
        this.logger.debug(`Original table names in changes: ${tableNames.join(', ')}`);
        
        // Keep the original changes intact - don't modify the message.changes array
        // Instead, just add the processed changes as a separate property
        const processedChanges = this.processTableChanges(serverMessage.changes);
        
        // Augment the message with processed changes for handlers
        message._processedChanges = processedChanges;
      }
    } else if (message.type === 'srv_catchup_completed') {
      this.logger.info(`Catchup completed message received for client ${clientId}: ${JSON.stringify(message)}`);
    } else if (message.type === 'srv_lsn_update' && message.lsn) {
      this.updateClientLSN(clientId, message.lsn);
    }
  }
  
  /**
   * Update a client's LSN
   */
  public updateClientLSN(clientId: string, lsn: string): void {
    this.clientLSNMap.set(clientId, lsn);
    this.logger.debug(`Updated LSN for client ${clientId} to ${lsn}`);
    
    // Emit an LSN update event that the client factory can listen for
    this.emit('lsn_updated', { clientId, lsn });
  }
  
  /**
   * Get a client's current LSN
   */
  public getClientLSN(clientId: string): string | undefined {
    return this.clientLSNMap.get(clientId);
  }
  
  /**
   * Set ID mapping for translating between synthetic and real IDs
   */
  public setIdMapping(mapping: Record<string, string>): void {
    this.idMapping = mapping || {};
    if (this.options.verbose) {
      this.logger.info(`Set ID mapping with ${Object.keys(this.idMapping).length} entries`);
    }
  }
  
  /**
   * Create synthetic IDs for tracking and build a mapping between real and synthetic IDs
   */
  public createSyntheticIdMapping(changes: EntityChange[]): { 
    compatChanges: EntityChange[],
    idMapping: Record<string, string>
  } {
    const idMapping: Record<string, string> = {};
    
    // Create a mapping between real DB IDs and synthetic IDs used for tracking
    const compatChanges = changes.map((change: EntityChange, index: number) => {
      // Create a synthetic ID based on the entity type and index
      const syntheticId = `single-${change.type}-${index + 1}`;
      
      // Store the mapping between synthetic ID and real DB ID
      idMapping[syntheticId] = change.id;
      
      // Return a modified change object with the synthetic ID
      return {
        ...change,
        originalId: change.id, // Keep the original ID
        id: syntheticId // Use synthetic ID for validation
      };
    });
    
    // Update the internal mapping
    this.idMapping = { ...this.idMapping, ...idMapping };
    
    return { compatChanges, idMapping };
  }
  
  /**
   * Process TableChange objects from the server into EntityChange objects
   */
  public processTableChanges(
    tableChanges: TableChange[],
    logWarnings: boolean = false
  ): EntityChange[] {
    if (!tableChanges || !Array.isArray(tableChanges) || tableChanges.length === 0) {
      if (logWarnings) this.logger.warn('No table changes provided to process');
      return [];
    }
    
    const entityChanges = tableChanges.map(tableChange => {
      try {
        return this.tableChangeToEntityChange(tableChange);
      } catch (error) {
        if (logWarnings) this.logger.warn(`Error processing table change: ${error}`);
        return null;
      }
    }).filter(Boolean) as EntityChange[];
    
    if (this.options.verbose) {
      this.logger.info(`Processed ${entityChanges.length}/${tableChanges.length} table changes`);
    }
    
    return entityChanges;
  }
  
  /**
   * Convert a TableChange from the server to our EntityChange format
   */
  private tableChangeToEntityChange(tableChange: TableChange): EntityChange | null {
    if (!tableChange.table || !tableChange.operation || !tableChange.data) {
      throw new Error(`Invalid table change: ${JSON.stringify(tableChange)}`);
    }
    
    // Map table name to entity type
    const entityTypeMap: Record<string, EntityType> = {
      'tasks': 'task',
      'projects': 'project',
      'users': 'user',
      'comments': 'comment'
    };
    
    // Map TableChange operation to EntityChange operation
    const operationMap: Record<string, Operation> = {
      'insert': 'create',
      'update': 'update',
      'delete': 'delete'
    };
    
    const entityType = entityTypeMap[tableChange.table];
    const operation = operationMap[tableChange.operation];
    
    if (!entityType || !this.options.allowedEntityTypes?.includes(entityType)) {
      throw new Error(`Unsupported table type: ${tableChange.table}`);
    }
    
    if (!operation || !this.options.allowedOperations?.includes(operation)) {
      throw new Error(`Unsupported operation: ${tableChange.operation}`);
    }
    
    // Get the ID from the data
    const realId = tableChange.data.id?.toString();
    if (!realId) {
      throw new Error(`Missing ID in table change data: ${JSON.stringify(tableChange)}`);
    }
    
    // Look up synthetic ID if available
    let syntheticId = realId;
    if (this.idMapping && Object.keys(this.idMapping).length > 0) {
      const mappingEntry = Object.entries(this.idMapping).find(
        ([synthetic, real]) => real === realId
      );
      
      if (mappingEntry) {
        syntheticId = mappingEntry[0];
        if (this.options.verbose) this.logger.debug(`Mapped real ID ${realId} to synthetic ID ${syntheticId}`);
      }
    }
    
    // Return properly structured EntityChange object
    return {
      id: syntheticId,
      type: entityType as EntityType,
      operation: operation as Operation,
      data: tableChange.data as Record<string, any>,
      timestamp: Date.parse(tableChange.updated_at) || Date.now(),
      originalId: realId
    };
  }
}

// Export singleton instance
export const messageDispatcher = new MessageDispatcher(); 