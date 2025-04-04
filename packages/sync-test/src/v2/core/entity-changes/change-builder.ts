/**
 * Change Builder
 * 
 * Handles conversion of entities to TableChanges and generation of changes for testing.
 * Implements a command pattern for entity operations.
 */

import { v4 as uuidv4 } from 'uuid';
import { faker } from '@faker-js/faker';
import { TableChange } from '@repo/sync-types';
import { User, Project, Task, Comment } from '@repo/dataforge/server-entities';

import { createLogger } from '../logger.ts';
import { EntityType, getEntityType, getTableName } from './entity-adapter.ts';
import { createUser, createProject, createTask, createComment, createEntities } from './entity-factories.ts';

// Initialize logger
const logger = createLogger('EntityChanges:Builder');

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
 * Options for creating change commands
 */
export interface ChangeCommandOptions {
  id?: string;
  lsn?: string;
  clientId?: string;
}

// Add an interface for delete operations with entity type marker
export interface EntityWithTypeMarker extends Record<string, any> {
  id: string;
  __entityType: string;
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
    
    if (operation === 'delete' && 'id' in entity && '__entityType' in entity) {
      // Use provided entity type marker
      entityType = entity.__entityType as EntityType;
    } else {
      // Get entity type normally
      entityType = getEntityType(entity);
    }
    
    const tableName = getTableName(entityType);
    
    // If it's a DELETE operation, we only need the ID
    const data = operation === 'delete' 
      ? { id: entity.id } 
      : { ...entity }; // Convert entity to plain object
    
    // Remove any __entityType marker from the data to keep it clean
    if ('__entityType' in data) {
      delete data.__entityType;
    }
    
    // For non-delete operations, ensure date fields are proper Date objects
    if (operation !== 'delete') {
      // Cast to Record to avoid type errors
      const record = entity as Record<string, any>;
      
      // Convert common date fields to Date objects
      if (record.createdAt) {
        data.createdAt = new Date(record.createdAt);
      }
      
      if (record.updatedAt) {
        data.updatedAt = new Date(record.updatedAt);
      }
      
      // Handle entity-specific date fields
      if (entityType === 'task' && record.dueDate) {
        data.dueDate = new Date(record.dueDate);
      }
      if (entityType === 'task' && record.completedAt) {
        data.completedAt = new Date(record.completedAt);
      }
    }
    
    return {
      table: tableName,
      operation,
      data,
      lsn: options.lsn,
      updated_at: new Date().toISOString()
    };
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
  entity: User | Project | Task | Comment | { id: string, [key: string]: any },
  options: ChangeCommandOptions = {}
): ChangeCommand {
  return {
    type: 'delete',
    execute: () => entityToChange(entity, 'delete', options)
  };
}

/**
 * Generate change commands for testing
 */
export function generateChangeCommands(
  count: number,
  options: {
    createPercentage?: number;
    updatePercentage?: number;
    deletePercentage?: number;
    entityDistribution?: Partial<Record<EntityType, number>>;
    useExistingIds?: boolean;
    existingIds?: Record<EntityType, string[]>;
  } = {}
): ChangeCommand[] {
  // Default options
  const createPercentage = options.createPercentage ?? 0.7; // 70% creates by default
  const updatePercentage = options.updatePercentage ?? 0.2; // 20% updates by default
  const entityDistribution = options.entityDistribution ?? {
    user: 0.1,    // 10% users
    project: 0.1,  // 10% projects
    task: 0.3,     // 30% tasks
    comment: 0.5   // 50% comments
  };
  
  logger.info(`Generating ${count} change commands`);
  
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
  Object.entries(entityCounts).forEach(([entityType, typeCount]) => {
    if (typeCount <= 0) return;
    
    const type = entityType as EntityType;
    
    // Calculate operations mix
    const createCount = Math.floor(typeCount * createPercentage);
    const updateCount = Math.floor(typeCount * updatePercentage);
    const deleteCount = typeCount - createCount - updateCount;
    
    logger.info(`${type}: ${createCount} creates, ${updateCount} updates, ${deleteCount} deletes`);
    
    // Generate entities for inserts
    if (createCount > 0) {
      createEntities(type, createCount).then(entities => {
        entities.forEach(entity => {
          commands.push(createInsertCommand(entity));
        });
      });
    }
    
    // Handle updates and deletes using existing IDs if available
    const existingIds = options.existingIds?.[type] || [];
    
    if (updateCount > 0) {
      if (existingIds.length > 0 && options.useExistingIds) {
        // Update existing entities
        for (let i = 0; i < Math.min(updateCount, existingIds.length); i++) {
          const entityToUpdate = generateEntityWithId(type, existingIds[i]);
          commands.push(createUpdateCommand(entityToUpdate));
        }
        
        // If we need more updates than existing IDs, create new ones
        if (updateCount > existingIds.length) {
          const additionalCount = updateCount - existingIds.length;
          const newEntities = createEntities(type, additionalCount);
          newEntities.forEach(entity => {
            commands.push(createUpdateCommand(entity));
          });
        }
      } else {
        // Create new entities for updates
        const entitiesToUpdate = createEntities(type, updateCount);
        entitiesToUpdate.forEach(entity => {
          commands.push(createUpdateCommand(entity));
        });
      }
    }
    
    if (deleteCount > 0) {
      if (existingIds.length > 0 && options.useExistingIds) {
        // Delete existing entities
        for (let i = 0; i < Math.min(deleteCount, existingIds.length); i++) {
          const idToDelete = existingIds[i];
          commands.push(createDeleteCommand({ id: idToDelete }));
        }
        
        // If we need more deletes than existing IDs, create new ones
        if (deleteCount > existingIds.length) {
          const additionalCount = deleteCount - existingIds.length;
          const newEntities = createEntities(type, additionalCount);
          newEntities.forEach(entity => {
            commands.push(createDeleteCommand(entity));
          });
        }
      } else {
        // Create new entities for deletes
        const entitiesToDelete = createEntities(type, deleteCount);
        entitiesToDelete.forEach(entity => {
          commands.push(createDeleteCommand(entity));
        });
      }
    }
  });
  
  // Shuffle commands to mix operations and entity types
  return shuffleArray(commands);
}

/**
 * Generate changes by executing change commands
 */
export function generateChanges(
  count: number,
  options: {
    createPercentage?: number;
    updatePercentage?: number;
    entityDistribution?: Partial<Record<EntityType, number>>;
    useExistingIds?: boolean;
    existingIds?: Record<EntityType, string[]>;
  } = {}
): TableChange[] {
  // Generate commands
  const commands = generateChangeCommands(count, options);
  
  // Execute commands to get changes
  return commands.map(command => command.execute());
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