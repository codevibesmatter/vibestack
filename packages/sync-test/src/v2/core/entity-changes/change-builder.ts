/**
 * Change Builder V2
 * 
 * Handles conversion of entities to TableChanges and generation of changes for testing.
 * Implements a command pattern for entity operations with improved type safety and 
 * consistent batch ID and date handling.
 */

import { v4 as uuidv4 } from 'uuid';
import { faker } from '@faker-js/faker';
import { TableChange as BaseTableChange } from '@repo/sync-types';
import { User, Project, Task, Comment } from '@repo/dataforge/server-entities';

import { createLogger } from '../logger.ts';
import { EntityType, getEntityType, getTableName } from './entity-adapter.ts';
import { createUser, createProject, createTask, createComment, createEntities } from './entity-factories.ts';

// Initialize logger
const logger = createLogger('entity-changes.builder');

/**
 * Extended TableChange interface that includes batchId
 */
export interface TableChange extends BaseTableChange {
  batchId?: string;
}

/**
 * Operation type for change commands
 * Note: Matching the expected TableChange operation types
 */
export type OperationType = 'insert' | 'update' | 'delete';

/**
 * Change command interface - represents a change operation
 */
export interface ChangeCommand {
  type: OperationType;
  execute(): TableChange;
}

/**
 * Common date field names across entity types
 */
export const COMMON_DATE_FIELDS = ['createdAt', 'updatedAt'] as const;

/**
 * Entity-specific date field names
 */
export const ENTITY_DATE_FIELDS: Record<EntityType, readonly string[]> = {
  user: [],
  project: [],
  task: ['dueDate', 'completedAt'],
  comment: []
};

/**
 * Metadata properties that should be excluded from entity data
 */
export const METADATA_PROPERTIES = [
  '__entityType', 
  '__hasChanges__', 
  '__isInitialized__', 
  '__lazyRelations__',
  '__listeners__',
  '__meta__', // Assuming metadata might be added
  '__batchId'
];

/**
 * Options for creating change commands
 */
export interface ChangeCommandOptions {
  /** Logical sequence number for the change */
  lsn?: string;
  /** Client ID for the change source */
  clientId?: string;
  /** Batch ID for grouping related changes */
  batchId?: string;
  /** Timestamp for the change, defaults to now */
  timestamp?: Date;
}

/**
 * Base entity interface with required ID
 */
export interface BaseEntity {
  id: string;
  [key: string]: any;
}

/**
 * Entity with type marker interface, used for delete operations
 */
export interface EntityWithTypeMarker extends BaseEntity {
  __entityType: EntityType;
  __batchId?: string;
}

/**
 * Type guard for EntityWithTypeMarker
 */
function isEntityWithTypeMarker(entity: any): entity is EntityWithTypeMarker {
  return entity && typeof entity === 'object' 
    && 'id' in entity 
    && '__entityType' in entity
    && typeof entity.__entityType === 'string';
}

/**
 * Convert date strings to Date objects
 */
function ensureDateObjects(
  data: Record<string, any>, 
  entityType: EntityType
): void {
  // Handle common date fields
  for (const dateField of COMMON_DATE_FIELDS) {
    if (dateField in data && data[dateField]) {
      data[dateField] = new Date(data[dateField]);
    }
  }

  // Handle entity-specific date fields
  for (const dateField of ENTITY_DATE_FIELDS[entityType] || []) {
    if (dateField in data && data[dateField]) {
      data[dateField] = new Date(data[dateField]);
    }
  }
}

/**
 * Cleans entity data by removing metadata and handling relations
 */
function cleanEntityData(entityData: Record<string, any>): Record<string, any> {
  const cleanedData = { ...entityData };

  // Remove standard metadata properties
  for (const prop of METADATA_PROPERTIES) {
    if (prop in cleanedData) {
      delete cleanedData[prop];
    }
  }

  // --- START: Handle Relational Properties --- 
  const entityType = getEntityType(entityData); // Get type to determine relations

  // Handle Task relations
  if (entityType === 'task') {
    if ('project' in cleanedData) {
      cleanedData.project_id = cleanedData.project?.id || null;
      delete cleanedData.project;
    }
    if ('assignee' in cleanedData) {
      cleanedData.assignee_id = cleanedData.assignee?.id || null;
      delete cleanedData.assignee;
    }
    // Note: comments relation is usually one-to-many, not stored on Task table
  }

  // Handle Comment relations
  if (entityType === 'comment') {
    if ('author' in cleanedData) {
      cleanedData.author_id = cleanedData.author?.id || null;
      delete cleanedData.author;
    }
    if ('parent' in cleanedData) {
      cleanedData.parent_id = cleanedData.parent?.id || null;
      delete cleanedData.parent;
    }
    if ('entity' in cleanedData) {
        // Determine entity_type and entity_id from the related entity
        const relatedEntity = cleanedData.entity;
        if (relatedEntity && relatedEntity.id) {
            const relatedEntityType = getEntityType(relatedEntity);
            if (relatedEntityType === 'task' || relatedEntityType === 'project') {
                 cleanedData.entity_id = relatedEntity.id;
                 cleanedData.entity_type = relatedEntityType; 
            } else {
                 // Handle cases where the entity relation is invalid or unexpected
                 cleanedData.entity_id = null;
                 cleanedData.entity_type = null;
            }
        } else {
            cleanedData.entity_id = null;
            cleanedData.entity_type = null;
        }
        delete cleanedData.entity;
    }
  }
  
  // Handle Project relations (e.g., owner_id if applicable, tasks is one-to-many)
  if (entityType === 'project') {
    if ('owner' in cleanedData) {
      cleanedData.owner_id = cleanedData.owner?.id || null;
      delete cleanedData.owner;
    }
  }
  
  // Handle User relations (usually no direct FKs stored on User table for these relations)

  // --- END: Handle Relational Properties --- 

  return cleanedData;
}

/**
 * Factory function for creating TableChange objects from entities
 */
export function entityToChange(
  entity: User | Project | Task | Comment | EntityWithTypeMarker | Record<string, any>,
  operation: OperationType,
  options: ChangeCommandOptions = {}
): TableChange {
  try {
    // For deletes with marker, use the marker to get entity type
    let entityType: EntityType;
    
    if (operation === 'delete' && isEntityWithTypeMarker(entity)) {
      // Use provided entity type marker
      entityType = entity.__entityType;
    } else {
      // Get entity type normally
      entityType = getEntityType(entity);
    }
    
    const tableName = getTableName(entityType);
    
    // If it's a DELETE operation, we only need the ID
    let data: Record<string, any>;
    if (operation === 'delete') {
      data = { id: entity.id };
      
      // Include metadata for delete operations if available
      if (isEntityWithTypeMarker(entity) && entity.__batchId) {
        data.__batchId = entity.__batchId;
      }
    } else {
      // Clean the entity data by removing metadata properties
      data = cleanEntityData({ ...entity });
      
      // For non-delete operations, ensure date fields are proper Date objects
      ensureDateObjects(data, entityType);
    }
    
    // Create the TableChange
    const change: TableChange = {
      table: tableName,
      operation,
      data,
      lsn: options.lsn,
      updated_at: (options.timestamp || new Date()).toISOString()
    };
    
    // Add batch ID if provided in options or entity
    if (options.batchId) {
      change.batchId = options.batchId;
    } else if ('__batchId' in entity) {
      change.batchId = entity.__batchId as string;
    }
    
    return change;
  } catch (error) {
    logger.error(`Error converting entity to change: ${error}`);
    throw error;
  }
}

/**
 * Create insert command
 */
export function createInsertCommand(
  entity: User | Project | Task | Comment | Record<string, any>,
  options: ChangeCommandOptions = {}
): ChangeCommand {
  return {
    type: 'insert',
    execute: () => entityToChange(entity, 'insert', options)
  };
}

/**
 * Create update command
 */
export function createUpdateCommand(
  entity: User | Project | Task | Comment | Record<string, any>,
  options: ChangeCommandOptions = {}
): ChangeCommand {
  return {
    type: 'update',
    execute: () => entityToChange(entity, 'update', options)
  };
}

/**
 * Create delete command
 */
export function createDeleteCommand(
  entity: User | Project | Task | Comment | EntityWithTypeMarker | BaseEntity,
  options: ChangeCommandOptions = {}
): ChangeCommand {
  return {
    type: 'delete',
    execute: () => entityToChange(entity, 'delete', options)
  };
}

/**
 * Directly create an insert change
 */
export function createInsertChange(
  entity: User | Project | Task | Comment | Record<string, any>,
  options: ChangeCommandOptions = {}
): TableChange {
  return entityToChange(entity, 'insert', options);
}

/**
 * Directly create an update change
 */
export function createUpdateChange(
  entity: User | Project | Task | Comment | Record<string, any>,
  options: ChangeCommandOptions = {}
): TableChange {
  return entityToChange(entity, 'update', options);
}

/**
 * Directly create a delete change
 */
export function createDeleteChange(
  entity: User | Project | Task | Comment | EntityWithTypeMarker | BaseEntity,
  options: ChangeCommandOptions = {}
): TableChange {
  return entityToChange(entity, 'delete', options);
}

/**
 * Options for generating change commands
 */
export interface GenerateChangeOptions {
  /** Percentage of create operations (0.0-1.0) */
  createPercentage?: number;
  /** Percentage of update operations (0.0-1.0) */
  updatePercentage?: number;
  /** Percentage of delete operations (0.0-1.0) */
  deletePercentage?: number;
  /** Distribution of entity types */
  entityDistribution?: Partial<Record<EntityType, number>>;
  /** Whether to use existing IDs for updates/deletes */
  useExistingIds?: boolean;
  /** Existing IDs to use for updates/deletes */
  existingIds?: Record<EntityType, string[]>;
  /** Batch ID to assign to all changes */
  batchId?: string;
  /** Minimum age in seconds for entities used in updates/deletes */
  minEntityAgeInSeconds?: number;
}

/**
 * Generate change commands for testing
 */
export async function generateChangeCommands(
  count: number,
  options: GenerateChangeOptions = {}
): Promise<ChangeCommand[]> {
  // Default options
  const createPercentage = options.createPercentage ?? 0.7; // 70% creates by default
  const updatePercentage = options.updatePercentage ?? 0.2; // 20% updates by default
  const entityDistribution = options.entityDistribution ?? {
    user: 0.1,    // 10% users
    project: 0.1,  // 10% projects
    task: 0.3,     // 30% tasks
    comment: 0.5   // 50% comments
  };
  const batchId = options.batchId || `batch-${Date.now()}-${uuidv4().substring(0, 8)}`;
  
  logger.info(`Generating ${count} change commands with batch ID ${batchId}`);
  
  // Normalize entity distribution
  const totalDistribution = Object.values(entityDistribution)
    .reduce((sum, value) => sum + (value || 0), 0);
    
  const normalizedDistribution = Object.entries(entityDistribution)
    .reduce((acc, [key, value]) => {
      acc[key as EntityType] = (value || 0) / totalDistribution;
      return acc;
    }, {} as Record<EntityType, number>);
  
  // Calculate exact counts per entity type
  const entityCounts: Record<EntityType, number> = {
    user: Math.round(count * (normalizedDistribution.user || 0)),
    project: Math.round(count * (normalizedDistribution.project || 0)),
    task: Math.round(count * (normalizedDistribution.task || 0)),
    comment: Math.round(count * (normalizedDistribution.comment || 0))
  };
  
  // Adjust to ensure we get exactly the requested count
  const calculatedTotal = Object.values(entityCounts).reduce((sum, value) => sum + value, 0);
  if (calculatedTotal !== count) {
    // Adjust comments (usually most abundant) to match total
    entityCounts.comment += (count - calculatedTotal);
  }
  
  // Log distribution
  logger.info(`Entity distribution: user=${entityCounts.user}, project=${entityCounts.project}, task=${entityCounts.task}, comment=${entityCounts.comment}`);
  
  // Generate commands
  const commands: ChangeCommand[] = [];
  
  // Process each entity type
  for (const [entityType, typeCount] of Object.entries(entityCounts)) {
    if (typeCount <= 0) continue;
    
    const type = entityType as EntityType;
    
    // Calculate operations mix
    const createCount = Math.floor(typeCount * createPercentage);
    const updateCount = Math.floor(typeCount * updatePercentage);
    const deleteCount = typeCount - createCount - updateCount;
    
    logger.info(`${type}: ${createCount} creates, ${updateCount} updates, ${deleteCount} deletes`);
    
    // Generate entities for inserts
    if (createCount > 0) {
      const entities = await createEntities(type, createCount);
      for (const entity of entities) {
        // Add batch ID to entity
        (entity as any).__batchId = batchId;
        commands.push(createInsertCommand(entity, { batchId }));
      }
    }
    
    // Handle updates and deletes using existing IDs if available
    const existingIds = options.existingIds?.[type] || [];
    
    if (updateCount > 0) {
      if (existingIds.length > 0 && options.useExistingIds) {
        // Update existing entities
        for (let i = 0; i < Math.min(updateCount, existingIds.length); i++) {
          const entityToUpdate = generateEntityWithId(type, existingIds[i]);
          // Add batch ID to entity
          (entityToUpdate as any).__batchId = batchId;
          commands.push(createUpdateCommand(entityToUpdate, { batchId }));
        }
        
        // If we need more updates than existing IDs, create new ones
        if (updateCount > existingIds.length) {
          const additionalCount = updateCount - existingIds.length;
          const newEntities = await createEntities(type, additionalCount);
          for (const entity of newEntities) {
            // Add batch ID to entity
            (entity as any).__batchId = batchId;
            commands.push(createUpdateCommand(entity, { batchId }));
          }
        }
      } else {
        // Create new entities for updates
        const entitiesToUpdate = await createEntities(type, updateCount);
        for (const entity of entitiesToUpdate) {
          // Add batch ID to entity
          (entity as any).__batchId = batchId;
          commands.push(createUpdateCommand(entity, { batchId }));
        }
      }
    }
    
    if (deleteCount > 0) {
      if (existingIds.length > 0 && options.useExistingIds) {
        // Delete existing entities
        for (let i = 0; i < Math.min(deleteCount, existingIds.length); i++) {
          const idToDelete = existingIds[i];
          // Create entity with type marker
          const entityToDelete: EntityWithTypeMarker = { 
            id: idToDelete, 
            __entityType: type,
            __batchId: batchId
          };
          commands.push(createDeleteCommand(entityToDelete, { batchId }));
        }
        
        // If we need more deletes than existing IDs, create new ones
        if (deleteCount > existingIds.length) {
          const additionalCount = deleteCount - existingIds.length;
          const newEntities = await createEntities(type, additionalCount);
          for (const entity of newEntities) {
            // Add type marker and batch ID
            (entity as any).__entityType = type;
            (entity as any).__batchId = batchId;
            commands.push(createDeleteCommand(entity, { batchId }));
          }
        }
      } else {
        // Create new entities for deletes
        const entitiesToDelete = await createEntities(type, deleteCount);
        for (const entity of entitiesToDelete) {
          // Add type marker and batch ID
          (entity as any).__entityType = type;
          (entity as any).__batchId = batchId;
          commands.push(createDeleteCommand(entity, { batchId }));
        }
      }
    }
  }
  
  // Shuffle commands to mix operations and entity types
  return shuffleArray(commands);
}

/**
 * Generate changes by executing change commands
 */
export async function generateChanges(
  count: number,
  options: GenerateChangeOptions = {}
): Promise<TableChange[]> {
  // Generate commands
  const commands = await generateChangeCommands(count, options);
  
  // Execute commands to get changes
  return commands.map(command => command.execute());
}

/**
 * Create a batch of related changes with the same batch ID
 */
export async function createBatchChanges(
  entities: Record<EntityType, any[]>,
  options: {
    batchId?: string;
    timestamp?: Date;
  } = {}
): Promise<TableChange[]> {
  const batchId = options.batchId || `batch-${Date.now()}-${uuidv4().substring(0, 8)}`;
  const timestamp = options.timestamp || new Date();
  const changes: TableChange[] = [];
  
  for (const [entityType, entityList] of Object.entries(entities)) {
    for (const entity of entityList) {
      // Add batch ID to entity
      (entity as any).__batchId = batchId;
      
      // Create change
      const change = entityToChange(entity, 'insert', { 
        batchId, 
        timestamp 
      });
      
      changes.push(change);
    }
  }
  
  return changes;
}

// ------ Helper Functions ------

/**
 * Generate an entity with a specific ID
 */
function generateEntityWithId(entityType: EntityType, id: string): any {
  switch (entityType) {
    case 'user':
      return createUser({ id });
    case 'project':
      return createProject({}, { id });
    case 'task':
      return createTask({}, { id });
    case 'comment':
      return createComment({}, { id });
    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }
}

/**
 * Shuffle an array (Fisher-Yates algorithm)
 */
function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Options for building changes from entities
 */
export interface BuildChangesOptions {
  /** Batch ID to assign to all changes */
  batchId?: string;
  /** Timestamp for the changes */
  timestamp?: Date;
  /** Default operation type (insert, update, delete) */
  operation?: OperationType;
  /** Whether to shuffle the changes */
  shuffle?: boolean;
}

/**
 * Build changes from a record of entities
 * 
 * @param entities Record of entities by type
 * @param options Options for building changes
 * @returns Array of TableChange objects
 */
export function buildChangesFromEntities(
  entities: Record<EntityType, any[]>,
  options: BuildChangesOptions = {}
): TableChange[] {
  const changes: TableChange[] = [];
  const batchId = options.batchId || `batch-${Date.now()}-${uuidv4().substring(0, 8)}`;
  const timestamp = options.timestamp || new Date();
  const operation = options.operation || 'insert';
  
  // Process each entity type in dependency order
  for (const entityType of ['user', 'project', 'task', 'comment'] as EntityType[]) {
    if (!entities[entityType] || entities[entityType].length === 0) continue;
    
    logger.info(`Building ${operation} changes for ${entities[entityType].length} ${entityType} entities`);
    
    // Create changes for each entity
    for (const entity of entities[entityType]) {
      // Add batch ID to entity
      (entity as any).__batchId = batchId;
      
      // Create change
      const change = entityToChange(entity, operation, { 
        batchId, 
        timestamp 
      });
      
      changes.push(change);
    }
  }
  
  // Ensure all date fields are properly handled
  const processedChanges = ensureDateFieldsInChanges(changes);
  
  // Shuffle if requested
  return options.shuffle ? shuffleArray(processedChanges) : processedChanges;
}

/**
 * Ensure date fields in changes are properly converted to Date objects
 * This handles serialization issues where dates are converted to strings
 */
export function ensureDateFieldsInChanges(
  changes: TableChange[]
): TableChange[] {
  return changes.map(change => {
    if (!change.data) return change;
    
    const newChange = { ...change };
    newChange.data = { ...change.data };
    
    // Get entity type from table name
    const entityType = getEntityTypeFromTable(change.table);
    if (!entityType) return newChange;
    
    // Process common date fields
    for (const dateField of COMMON_DATE_FIELDS) {
      if (dateField in newChange.data && newChange.data[dateField]) {
        newChange.data[dateField] = ensureValidDate(newChange.data[dateField]);
      }
    }
    
    // Process entity-specific date fields
    for (const dateField of ENTITY_DATE_FIELDS[entityType] || []) {
      if (dateField in newChange.data && newChange.data[dateField]) {
        newChange.data[dateField] = ensureValidDate(newChange.data[dateField]);
      }
    }
    
    return newChange;
  });
}

/**
 * Ensure a value is a valid Date object
 */
export function ensureValidDate(value: any): Date {
  if (value instanceof Date) {
    return value;
  }
  
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date;
    }
  }
  
  // If conversion failed, return current date
  return new Date();
}

/**
 * Get entity type from table name
 */
function getEntityTypeFromTable(tableName: string): EntityType | null {
  const tableToEntityMap: Record<string, EntityType> = {
    'users': 'user',
    'projects': 'project',
    'tasks': 'task',
    'comments': 'comment'
  };
  
  return tableToEntityMap[tableName] || null;
}

/**
 * Duplicate a change with proper date handling and tracking
 */
export function duplicateChange(
  change: TableChange, 
  options: { 
    markAsDuplicate?: boolean; 
    delayInMs?: number;
  } = {}
): TableChange {
  // Create a deep copy of the change
  const duplicate: TableChange = JSON.parse(JSON.stringify(change));
  
  // Update timestamp if delay is specified
  if (options.delayInMs) {
    const timestamp = change.updated_at ? new Date(change.updated_at) : new Date();
    timestamp.setMilliseconds(timestamp.getMilliseconds() + options.delayInMs);
    duplicate.updated_at = timestamp.toISOString();
  }
  
  // Mark as intentional duplicate if requested
  if (options.markAsDuplicate && duplicate.data) {
    duplicate.data.__intentionalDuplicate = true;
    duplicate.data.__isDuplicate = true;
  }
  
  // Ensure date fields are properly handled
  if (duplicate.data) {
    const entityType = getEntityTypeFromTable(duplicate.table);
    if (entityType) {
      // Process common date fields
      for (const dateField of COMMON_DATE_FIELDS) {
        if (dateField in duplicate.data && duplicate.data[dateField]) {
          duplicate.data[dateField] = ensureValidDate(duplicate.data[dateField]);
        }
      }
      
      // Process entity-specific date fields
      for (const dateField of ENTITY_DATE_FIELDS[entityType] || []) {
        if (dateField in duplicate.data && duplicate.data[dateField]) {
          duplicate.data[dateField] = ensureValidDate(duplicate.data[dateField]);
        }
      }
    }
  }
  
  return duplicate;
}

/**
 * Add intentional duplicates to a changes array
 */
export function addIntentionalDuplicates(
  changes: TableChange[], 
  options: {
    duplicateRate?: number;
    maxDuplicates?: number;
    delayInMs?: number;
  } = {}
): { 
  allChanges: TableChange[]; 
  duplicates: { original: TableChange; duplicate: TableChange }[] 
} {
  const duplicateRate = options.duplicateRate || 0.05; // 5% by default
  const maxDuplicates = options.maxDuplicates || 10;
  const delayInMs = options.delayInMs || 100;
  
  const allChanges = [...changes];
  const duplicates: { original: TableChange; duplicate: TableChange }[] = [];
  
  const potentialChanges = changes.filter(c => 
    c.operation === 'insert' || c.operation === 'update'
  );
  
  // Determine number of duplicates to create
  const duplicateCount = Math.min(
    Math.floor(potentialChanges.length * duplicateRate),
    maxDuplicates
  );
  
  if (duplicateCount <= 0 || potentialChanges.length === 0) {
    return { allChanges, duplicates };
  }
  
  logger.info(`Adding ${duplicateCount} intentional duplicates`);
  
  // Shuffle and take the first N changes to duplicate
  const changesToDuplicate = shuffleArray(potentialChanges).slice(0, duplicateCount);
  
  for (const originalChange of changesToDuplicate) {
    const duplicate = duplicateChange(originalChange, {
      markAsDuplicate: true,
      delayInMs
    });
    
    allChanges.push(duplicate);
    duplicates.push({ original: originalChange, duplicate });
    
    logger.debug(`Added intentional duplicate for ${originalChange.table} change`);
  }
  
  return { allChanges, duplicates };
} 