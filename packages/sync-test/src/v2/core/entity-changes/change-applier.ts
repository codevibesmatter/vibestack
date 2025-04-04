/**
 * Change Applier
 * 
 * Handles applying TableChanges to the database.
 * Simplified from the original db-utils.ts to focus on core functionality.
 */

import { DataSource, Repository, In, ObjectLiteral } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TableChange } from '@repo/sync-types';
import { validate } from 'class-validator';
import { serverDataSource } from '@repo/dataforge';

import { createLogger } from '../logger.ts';
import { EntityType, getEntityClass, TABLE_TO_ENTITY, DEPENDENCY_ORDER, CASCADE_RELATIONS } from './entity-adapter.ts';
import { entityToChange } from './change-builder.ts';

// Initialize logger
const logger = createLogger('EntityChanges:Applier');

// Custom DataSource instance, if provided
let customDataSource: DataSource | null = null;

/**
 * Initialize with optional custom DataSource
 */
export async function initialize(dataSource?: DataSource): Promise<boolean> {
  if (dataSource) {
    customDataSource = dataSource;
    logger.info('Using custom DataSource for database operations');
    
    if (!customDataSource.isInitialized) {
      await customDataSource.initialize();
    }
    
    return customDataSource.isInitialized;
  }
  
  logger.info('Using default serverDataSource from @repo/dataforge');
  
  // Initialize default dataSource if needed
  if (!serverDataSource.isInitialized) {
    try {
      await serverDataSource.initialize();
    } catch (error) {
      logger.error(`Error initializing default dataSource: ${error}`);
      return false;
    }
  }
  
  return serverDataSource.isInitialized;
}

/**
 * Get active DataSource for database operations
 */
export async function getDataSource(): Promise<DataSource> {
  // Return custom DataSource if provided
  if (customDataSource) {
    if (!customDataSource.isInitialized) {
      await customDataSource.initialize();
    }
    return customDataSource;
  }
  
  // Fallback to default
  if (!serverDataSource) {
    throw new Error('Database connection not available');
  }
  
  if (!serverDataSource.isInitialized) {
    await serverDataSource.initialize();
  }
  
  return serverDataSource;
}

/**
 * Get repository for entity type
 */
export async function getRepository(entityType: EntityType): Promise<Repository<any>> {
  const dataSource = await getDataSource();
  const EntityClass = getEntityClass(entityType);
  return dataSource.getRepository(EntityClass);
}

/**
 * Fetch existing entity IDs for testing
 */
export async function fetchExistingIds(
  entityTypes: EntityType[] = DEPENDENCY_ORDER,
  maxIdsPerType: number = 50
): Promise<Record<EntityType, string[]>> {
  const result: Record<EntityType, string[]> = {
    user: [],
    project: [],
    task: [],
    comment: []
  };
  
  try {
    // Get data source and fetch IDs for each type
    const dataSource = await getDataSource();
    
    for (const entityType of entityTypes) {
      const EntityClass = getEntityClass(entityType);
      const repository = dataSource.getRepository(EntityClass);
      
      const entities = await repository.find({
        select: ['id'],
        take: maxIdsPerType,
        order: { createdAt: 'DESC' }
      });
      
      result[entityType] = entities.map(e => e.id);
      
      if (result[entityType].length > 0) {
        logger.debug(`Found ${result[entityType].length} existing ${entityType} entities`);
      }
    }
  } catch (error) {
    logger.warn(`Error fetching existing IDs: ${error}`);
  }
  
  return result;
}

/**
 * Validate entity using class-validator
 */
async function validateEntity(entity: any): Promise<string[]> {
  try {
    const errors = await validate(entity);
    if (errors.length > 0) {
      return errors.map(error => 
        `${error.property}: ${Object.values(error.constraints || {}).join(', ')}`
      );
    }
    return [];
  } catch (error) {
    logger.error(`Error validating entity: ${error}`);
    return [`Validation error: ${error}`];
  }
}

/**
 * Apply changes to the database
 */
export async function applyChanges(changes: TableChange[]): Promise<TableChange[]> {
  if (!changes.length) {
    logger.info('No changes to apply');
    return [];
  }
  
  logger.info(`Applying ${changes.length} changes to database`);
  
  // Group changes by entity type and operation
  const changesByType: Record<EntityType, Record<string, TableChange[]>> = {
    user: { insert: [], update: [], delete: [] },
    project: { insert: [], update: [], delete: [] },
    task: { insert: [], update: [], delete: [] },
    comment: { insert: [], update: [], delete: [] }
  };
  
  // Group changes
  for (const change of changes) {
    const entityType = TABLE_TO_ENTITY[change.table];
    if (!entityType) {
      logger.warn(`Unknown table: ${change.table}, skipping change`);
      continue;
    }
    
    if (!changesByType[entityType][change.operation]) {
      changesByType[entityType][change.operation] = [];
    }
    
    changesByType[entityType][change.operation].push(change);
  }
  
  // Log summary of changes to apply
  Object.entries(changesByType).forEach(([entityType, operations]) => {
    const counts = Object.entries(operations)
      .map(([op, changes]) => `${op}:${changes.length}`)
      .filter(s => !s.endsWith(':0'))
      .join(', ');
      
    if (counts) {
      logger.info(`Changes for ${entityType}: ${counts}`);
    }
  });
  
  // Get data source
  const dataSource = await getDataSource();
  const appliedChanges: TableChange[] = [];
  
  // Apply changes in a transaction
  await dataSource.transaction(async (transactionManager) => {
    // Process in dependency order to avoid foreign key issues
    // First inserts in dependency order
    for (const entityType of DEPENDENCY_ORDER) {
      const insertChanges = changesByType[entityType].insert;
      if (insertChanges.length > 0) {
        await processInserts(entityType, insertChanges, transactionManager, appliedChanges);
      }
    }
    
    // Then updates in dependency order
    for (const entityType of DEPENDENCY_ORDER) {
      const updateChanges = changesByType[entityType].update;
      if (updateChanges.length > 0) {
        await processUpdates(entityType, updateChanges, transactionManager, appliedChanges);
      }
    }
    
    // Finally deletes in reverse dependency order
    for (const entityType of [...DEPENDENCY_ORDER].reverse()) {
      const deleteChanges = changesByType[entityType].delete;
      if (deleteChanges.length > 0) {
        await processDeletes(entityType, deleteChanges, transactionManager, appliedChanges);
      }
    }
  });
  
  logger.info(`Successfully applied ${appliedChanges.length} changes`);
  return appliedChanges;
}

/**
 * Process insert operations
 */
async function processInserts(
  entityType: EntityType, 
  changes: TableChange[], 
  transactionManager: any,
  appliedChanges: TableChange[]
): Promise<void> {
  if (!changes.length) return;
  
  const EntityClass = getEntityClass(entityType);
  const repository = transactionManager.getRepository(EntityClass);
  
  logger.info(`Inserting ${changes.length} ${entityType} entities`);
  
  try {
    // Create entities from changes
    const entities = changes.map(change => {
      const entity = new EntityClass();
      Object.assign(entity, change.data);
      return entity;
    });
    
    // Validate entities before saving
    const validationErrors: Record<string, string[]> = {};
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const errors = await validateEntity(entity);
      if (errors.length > 0) {
        const idOrIndex = entity.id || `index_${i}`;
        validationErrors[idOrIndex] = errors;
      }
    }
    
    if (Object.keys(validationErrors).length > 0) {
      logger.error(`Validation errors for ${entityType} inserts: ${JSON.stringify(validationErrors)}`);
      throw new Error(`Validation failed for ${Object.keys(validationErrors).length} entities`);
    }
    
    // Insert all entities
    await repository.save(entities);
    
    // Add to applied changes
    appliedChanges.push(...changes);
  } catch (error) {
    logger.error(`Error inserting ${entityType} entities: ${error}`);
    throw error;
  }
}

/**
 * Process update operations
 */
async function processUpdates(
  entityType: EntityType, 
  changes: TableChange[], 
  transactionManager: any,
  appliedChanges: TableChange[]
): Promise<void> {
  if (!changes.length) return;
  
  const EntityClass = getEntityClass(entityType);
  const repository = transactionManager.getRepository(EntityClass);
  
  logger.info(`Updating ${changes.length} ${entityType} entities`);
  
  try {
    // Group by ID for efficient updates
    const changesByEntityId = changes.reduce((acc, change) => {
      const id = change.data.id as string;
      acc[id] = change;
      return acc;
    }, {} as Record<string, TableChange>);
    
    // Get entity IDs to update
    const entityIds = Object.keys(changesByEntityId);
    
    // Fetch existing entities
    const existingEntities = await repository.find({
      where: { id: In(entityIds) }
    });
    
    if (existingEntities.length !== entityIds.length) {
      logger.warn(`Found only ${existingEntities.length} of ${entityIds.length} ${entityType} entities to update`);
    }
    
    // Validate entities before updating
    const validationErrors: Record<string, string[]> = {};
    
    // Update each entity
    for (const entity of existingEntities) {
      const change = changesByEntityId[entity.id];
      
      // Apply changes to entity
      Object.assign(entity, change.data);
      
      // Update updatedAt if present
      if ('updatedAt' in entity) {
        entity.updatedAt = new Date();
      }
      
      // Validate entity
      const errors = await validateEntity(entity);
      if (errors.length > 0) {
        validationErrors[entity.id] = errors;
      }
    }
    
    if (Object.keys(validationErrors).length > 0) {
      logger.error(`Validation errors for ${entityType} updates: ${JSON.stringify(validationErrors)}`);
      throw new Error(`Validation failed for ${Object.keys(validationErrors).length} entities`);
    }
    
    // Save all updates
    await repository.save(existingEntities);
    
    // Add to applied changes (only the ones that were actually found and updated)
    for (const entity of existingEntities) {
      appliedChanges.push(changesByEntityId[entity.id]);
    }
  } catch (error) {
    logger.error(`Error updating ${entityType} entities: ${error}`);
    throw error;
  }
}

/**
 * Process delete operations
 */
async function processDeletes(
  entityType: EntityType, 
  changes: TableChange[], 
  transactionManager: any,
  appliedChanges: TableChange[]
): Promise<void> {
  if (!changes.length) return;
  
  const EntityClass = getEntityClass(entityType);
  const repository = transactionManager.getRepository(EntityClass);
  
  logger.info(`Deleting ${changes.length} ${entityType} entities`);
  
  try {
    // Extract entity IDs to delete
    const entityIds = changes.map(change => change.data.id as string);
    
    // Delete by ID
    await repository.delete({ id: In(entityIds) });
    
    // Add to applied changes
    appliedChanges.push(...changes);
  } catch (error) {
    logger.error(`Error deleting ${entityType} entities: ${error}`);
    throw error;
  }
}

/**
 * Perform a cascade delete operation for an entity and its dependencies
 */
export async function cascadeDelete(
  entityType: EntityType,
  entityId: string,
  options: {
    softDelete?: boolean;
    dryRun?: boolean;
  } = {}
): Promise<TableChange[]> {
  const dataSource = await getDataSource();
  const appliedChanges: TableChange[] = [];
  const deletedEntities: Record<EntityType, string[]> = {
    user: [],
    project: [],
    task: [],
    comment: []
  };
  
  logger.info(`Starting cascade delete for ${entityType} with ID ${entityId}`);
  
  if (options.dryRun) {
    logger.info('DRY RUN mode - no actual deletions will be performed');
  }
  
  await dataSource.transaction(async (transactionManager) => {
    await performCascadeDelete(
      entityType,
      entityId,
      transactionManager,
      appliedChanges,
      deletedEntities,
      options
    );
  });
  
  // Log summary of deleted entities
  Object.entries(deletedEntities).forEach(([type, ids]) => {
    if (ids.length > 0) {
      logger.info(`Cascade deleted ${ids.length} ${type} entities`);
    }
  });
  
  return appliedChanges;
}

/**
 * Recursive function to perform cascade delete
 */
async function performCascadeDelete(
  entityType: EntityType,
  entityId: string,
  transactionManager: any,
  appliedChanges: TableChange[],
  deletedEntities: Record<EntityType, string[]>,
  options: {
    softDelete?: boolean;
    dryRun?: boolean;
  } = {}
): Promise<void> {
  // Skip if already processed to avoid circular references
  if (deletedEntities[entityType].includes(entityId)) {
    return;
  }
  
  const EntityClass = getEntityClass(entityType);
  const repository = transactionManager.getRepository(EntityClass);
  
  // Get the cascaded relations for this entity type
  const cascadeRelations = CASCADE_RELATIONS[entityType];
  
  // First find the entity to be deleted
  const entity = await repository.findOne({ where: { id: entityId } });
  if (!entity) {
    logger.warn(`Entity ${entityType} with ID ${entityId} not found for cascade delete`);
    return;
  }
  
  // Map relation names to entity types
  const relationToEntityType: Record<string, EntityType> = {
    'tasks': 'task',
    'comments': 'comment',
    'childComments': 'comment',
    'projects': 'project',
    'users': 'user'
  };
  
  // Find and delete all dependent entities first
  for (const relation of cascadeRelations) {
    const relatedType = relationToEntityType[relation];
    
    if (relatedType) {
      // Find related entities
      const RelatedEntityClass = getEntityClass(relatedType);
      const relatedRepo = transactionManager.getRepository(RelatedEntityClass);
      
      // Create query based on relation
      const query: Record<string, any> = {};
      if (relation === 'tasks') {
        query.projectId = entityId;
      } else if (relation === 'comments' && entityType === 'task') {
        query.entityType = 'task';
        query.entityId = entityId;
      } else if (relation === 'comments' && entityType === 'project') {
        query.entityType = 'project';
        query.entityId = entityId;
      } else if (relation === 'childComments') {
        query.parentId = entityId;
      }
      
      const relatedEntities = await relatedRepo.find({ where: query });
      logger.debug(`Found ${relatedEntities.length} ${relatedType} entities related to ${entityType} ${entityId} via ${relation}`);
      
      // Recursively delete each related entity
      for (const relatedEntity of relatedEntities) {
        await performCascadeDelete(
          relatedType,
          relatedEntity.id,
          transactionManager,
          appliedChanges,
          deletedEntities,
          options
        );
      }
    }
  }
  
  // Track that we've processed this entity
  deletedEntities[entityType].push(entityId);
  
  // Create a change record
  const change = entityToChange(entity, 'delete');
  appliedChanges.push(change);
  
  // Skip actual deletion in dry run mode
  if (options.dryRun) {
    logger.debug(`DRY RUN: Would delete ${entityType} with ID ${entityId}`);
    return;
  }
  
  // Perform the deletion (soft delete if requested)
  if (options.softDelete && 'isDeleted' in entity) {
    entity.isDeleted = true;
    entity.updatedAt = new Date();
    await repository.save(entity);
    logger.debug(`Soft deleted ${entityType} with ID ${entityId}`);
  } else {
    await repository.delete(entityId);
    logger.debug(`Hard deleted ${entityType} with ID ${entityId}`);
  }
} 