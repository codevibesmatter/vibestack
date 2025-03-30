import { EntityChange, EntityType, Operation } from '../types.ts';
import { createLogger } from './logger.ts';
import type {
  BaseMessage,
  ServerChangesMessage,
  TableChange,
  SrvMessageType
} from '@repo/sync-types';

/**
 * Configuration options for the MessageProcessor
 */
export interface MessageProcessorOptions {
  verbose?: boolean;
  strictValidation?: boolean;
  allowedEntityTypes?: string[];
  allowedOperations?: string[];
}

/**
 * MessageProcessor handles the parsing, validation and transformation
 * of WebSocket messages into EntityChange objects
 */
export class MessageProcessor {
  private logger = createLogger('MessageProcessor');
  private verbose: boolean = false;
  private idMapping: Record<string, string> = {};
  private options: MessageProcessorOptions;
  
  /**
   * Create a new MessageProcessor
   */
  constructor(options?: MessageProcessorOptions) {
    this.options = {
      verbose: false,
      strictValidation: true,
      allowedEntityTypes: ['task', 'project', 'user', 'comment'],
      allowedOperations: ['create', 'update', 'delete'],
      ...options
    };
    
    this.verbose = this.options.verbose || false;
    
    if (this.verbose) {
      this.logger.info(`MessageProcessor initialized with options: ${JSON.stringify(this.options)}`);
    }
  }
  
  /**
   * Set ID mapping for translating between synthetic and real IDs
   */
  public setIdMapping(mapping: Record<string, string>): void {
    this.idMapping = mapping || {};
    if (this.verbose) {
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
   * Process WebSocket messages to create valid EntityChange objects
   * Maps real IDs to synthetic IDs if mapping exists
   */
  public processWebSocketMessages(
    wsMessages: any[],
    logWarnings: boolean = true
  ): EntityChange[] {
    if (!wsMessages || !Array.isArray(wsMessages) || wsMessages.length === 0) {
      if (logWarnings) this.logger.warn('No messages provided to process');
      return [];
    }
    
    // Process each message with validation
    const entityChanges = wsMessages.map((message: any) => {
      return this.processWebSocketMessage(message, logWarnings);
    }).filter(Boolean) as EntityChange[];
    
    // Log results if verbose
    if (this.verbose) {
      this.logger.info(`Processed ${entityChanges.length}/${wsMessages.length} messages`);
    }
    
    return entityChanges;
  }
  
  /**
   * Process WebSocket message from the server
   * Validates and converts ServerChangesMessage to EntityChange objects
   */
  public processServerChangesMessage(
    message: ServerChangesMessage,
    logWarnings: boolean = true
  ): EntityChange[] {
    if (!message || !message.changes || !Array.isArray(message.changes)) {
      if (logWarnings) this.logger.warn(`Invalid server changes message: ${JSON.stringify(message)}`);
      return [];
    }
    
    return this.processTableChanges(message.changes, logWarnings);
  }
  
  /**
   * Process TableChange objects from the server
   */
  public processTableChanges(
    tableChanges: TableChange[],
    logWarnings: boolean = true
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
    
    if (this.verbose) {
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
        if (this.verbose) this.logger.debug(`Mapped real ID ${realId} to synthetic ID ${syntheticId}`);
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
  
  /**
   * Process a single WebSocket message to create a valid EntityChange object
   * This is for backward compatibility with the old message format
   */
  public processWebSocketMessage(
    message: any,
    logWarnings: boolean = true
  ): EntityChange | null {
    // Strict validation - message must match expected server format
    if (!message) {
      if (logWarnings) this.logger.warn(`Null message object`);
      return null;
    }
    
    // Required fields according to protocol
    if (!message.entity || !message.data || !message.data.id || !message.operation) {
      if (logWarnings) this.logger.warn(`Invalid message object - missing required fields: ${JSON.stringify(message)}`);
      return null;
    }
    
    // Entity type must be one of the allowed types
    const entityType = message.entity.toLowerCase();
    if (!this.options.allowedEntityTypes?.includes(entityType)) {
      if (logWarnings) this.logger.warn(`Invalid entity type: ${entityType}`);
      return null;
    }
    
    // Operation must be one of the allowed operations
    const operation = message.operation.toLowerCase();
    if (!this.options.allowedOperations?.includes(operation)) {
      if (logWarnings) this.logger.warn(`Invalid operation: ${operation}`);
      return null;
    }
    
    const realId = message.data.id;
    
    // Look up synthetic ID if available
    let syntheticId = realId;
    if (this.idMapping && Object.keys(this.idMapping).length > 0) {
      const mappingEntry = Object.entries(this.idMapping).find(
        ([synthetic, real]) => real === realId
      );
      
      if (mappingEntry) {
        syntheticId = mappingEntry[0];
        if (this.verbose) this.logger.debug(`Mapped real ID ${realId} to synthetic ID ${syntheticId}`);
      }
    }
    
    // Return properly structured EntityChange object
    return {
      id: syntheticId,
      type: entityType as EntityType,
      operation: operation as Operation,
      data: message.data,
      timestamp: message.timestamp || Date.now(),
      originalId: realId
    };
  }
  
  /**
   * Map a real database ID to a synthetic ID if one exists
   */
  public mapRealIdToSynthetic(realId: string): string {
    if (!realId || !this.idMapping || Object.keys(this.idMapping).length === 0) {
      return realId;
    }
    
    const mappingEntry = Object.entries(this.idMapping).find(
      ([synthetic, real]) => real === realId
    );
    
    return mappingEntry ? mappingEntry[0] : realId;
  }
  
  /**
   * Map a synthetic ID to a real database ID if one exists
   */
  public mapSyntheticIdToReal(syntheticId: string): string {
    return this.idMapping[syntheticId] || syntheticId;
  }
} 