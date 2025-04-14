/**
 * Change Applier V2
 * 
 * Handles applying TableChanges to the database.
 * Improved from the original version with better error handling,
 * reduced code duplication, and more efficient operations.
 */

import { DataSource, Repository, In, ObjectLiteral, LessThan, Not } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TableChangeTest } from './types.ts';
import { validate } from 'class-validator';
import { serverDataSource } from '@repo/dataforge';

import { createLogger } from '../logger.ts';
import { EntityType, getEntityClass, TABLE_TO_ENTITY, DEPENDENCY_ORDER, getEntityCascadeGraph, getCascadeRelationships } from './entity-adapter.ts';
import { entityToChange } from './change-builder.ts';

// Initialize logger
const logger = createLogger('entity-changes.applier');

// Custom DataSource instance, if provided
let customDataSource: DataSource | null = null;

/**
 * Ensure the data source is initialized
 */
async function ensureDataSourceInitialized(dataSource: DataSource): Promise<DataSource> {
  if (!dataSource.isInitialized) {
    try {
      await dataSource.initialize();
    } catch (error) {
      logger.error(`Error initializing DataSource: ${error}`);
      throw error;
    }
  }
  return dataSource;
}

/**
 * Initialize with optional custom DataSource
 */
export async function initialize(dataSource?: DataSource): Promise<boolean> {
  if (dataSource) {
    customDataSource = dataSource;
    logger.info('Using custom DataSource for database operations');
    return (await ensureDataSourceInitialized(customDataSource)).isInitialized;
  }
  
  logger.info('Using default serverDataSource from @repo/dataforge');
  return (await ensureDataSourceInitialized(serverDataSource)).isInitialized;
}

/**
 * Get active DataSource for database operations
 */
export async function getDataSource(): Promise<DataSource> {
  // Return custom DataSource if provided
  if (customDataSource) {
    return ensureDataSourceInitialized(customDataSource);
  }
  
  // Fallback to default
  if (!serverDataSource) {
    throw new Error('Database connection not available');
  }
  
  return ensureDataSourceInitialized(serverDataSource);
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
  maxIdsPerType: number = 50,
  minAgeInSeconds: number = 300,
  excludeIds: Record<EntityType, Set<string>> = {
    user: new Set<string>(),
    project: new Set<string>(),
    task: new Set<string>(),
    comment: new Set<string>()
  },
  currentBatchId?: string
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
    
    // Calculate cutoff time to exclude recently created entities
    const cutoffTime = new Date(Date.now() - (minAgeInSeconds * 1000));
    
    for (const entityType of entityTypes) {
      const EntityClass = getEntityClass(entityType);
      const repository = dataSource.getRepository(EntityClass);
      
      // Build where clause
      const whereClause: any = {
        createdAt: LessThan(cutoffTime)
      };
      
      // Exclude specific IDs if provided
      const idsToExclude = excludeIds[entityType];
      if (idsToExclude && idsToExclude.size > 0) {
        whereClause.id = Not(In([...idsToExclude]));
      }
      
      // Exclude entities from current batch if provided
      if (currentBatchId) {
        whereClause.__batchId = Not(currentBatchId);
      }
      
      // More deterministic ordering by ID and exclude recently created entities
      const entities = await repository.find({
        select: ['id'],
        where: whereClause,
        take: maxIdsPerType,
        order: { id: 'ASC' }  // Order by ID, not createdAt
      });
      
      result[entityType] = entities.map(e => e.id);
      
      logger.debug(`Found ${result[entityType].length} existing ${entityType} entities older than ${minAgeInSeconds} seconds`);
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
 * Validate multiple entities and collect errors
 */
async function validateEntities(entities: any[]): Promise<Record<string, string[]>> {
  const validationErrors: Record<string, string[]> = {};
  
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    const errors = await validateEntity(entity);
    
    if (errors.length > 0) {
      const idOrIndex = entity.id || `index_${i}`;
      validationErrors[idOrIndex] = errors;
    }
  }
  
  return validationErrors;
}

/**
 * Group changes by entity type and operation
 */
function groupChangesByTypeAndOperation(changes: TableChangeTest[]): Record<EntityType, Record<string, TableChangeTest[]>> {
  const changesByType: Record<EntityType, Record<string, TableChangeTest[]>> = {
    user: { insert: [], update: [], delete: [] },
    project: { insert: [], update: [], delete: [] },
    task: { insert: [], update: [], delete: [] },
    comment: { insert: [], update: [], delete: [] }
  };
  
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
  
  return changesByType;
}

/**
 * Apply changes to the database
 */
export async function applyChanges(changes: TableChangeTest[]): Promise<TableChangeTest[]> {
  if (!changes.length) {
    logger.info('No changes to apply');
    return [];
  }
  
  logger.info(`Applying ${changes.length} changes to database`);
  
  // Group changes by entity type and operation
  const changesByType = groupChangesByTypeAndOperation(changes);
  
  // Log summary of changes to apply
  const changesSummary = Object.entries(changesByType)
    .map(([entityType, operations]) => {
      const counts = Object.entries(operations)
        .filter(([_, changes]) => changes.length > 0)
        .map(([op, changes]) => `${op}:${changes.length}`)
        .join(',');
      return counts ? `${entityType}(${counts})` : null;
    })
    .filter(Boolean)
    .join(' ');
    
  logger.info(`\x1b[33mChanges summary: ${changesSummary}\x1b[0m`);
  
  // Get data source
  const dataSource = await getDataSource();
  const appliedChanges: TableChangeTest[] = [];
  
  // Apply changes in a transaction
  await dataSource.transaction(async (transactionManager) => {
    // Collect operation summaries for logging
    const deleteOps = Object.entries(changesByType)
      .filter(([_, ops]) => ops.delete.length > 0)
      .map(([type, ops]) => `${type}:${ops.delete.length}`)
      .join(', ');
      
    const insertOps = Object.entries(changesByType)
      .filter(([_, ops]) => ops.insert.length > 0)
      .map(([type, ops]) => `${type}:${ops.insert.length}`)
      .join(', ');
      
    const updateOps = Object.entries(changesByType)
      .filter(([_, ops]) => ops.update.length > 0)
      .map(([type, ops]) => `${type}:${ops.update.length}`)
      .join(', ');
    
    // Log operation summaries
    if (deleteOps) logger.info(`\x1b[33mDeleting entities: ${deleteOps}\x1b[0m`);
    if (insertOps) logger.info(`\x1b[33mInserting entities: ${insertOps}\x1b[0m`);
    if (updateOps) logger.info(`\x1b[33mUpdating entities: ${updateOps}\x1b[0m`);
    
    // First deletes in reverse dependency order
    for (const entityType of [...DEPENDENCY_ORDER].reverse()) {
      const deleteChanges = changesByType[entityType].delete;
      if (deleteChanges.length > 0) {
        await processDeletes(entityType, deleteChanges, transactionManager, appliedChanges);
      }
    }
    
    // Then inserts in dependency order
    for (const entityType of DEPENDENCY_ORDER) {
      const insertChanges = changesByType[entityType].insert;
      if (insertChanges.length > 0) {
        await processInserts(entityType, insertChanges, transactionManager, appliedChanges);
      }
    }
    
    // Finally updates in dependency order
    for (const entityType of DEPENDENCY_ORDER) {
      const updateChanges = changesByType[entityType].update;
      if (updateChanges.length > 0) {
        await processUpdates(entityType, updateChanges, transactionManager, appliedChanges);
      }
    }
  });
  
  logger.info(`\x1b[34mSuccessfully applied ${appliedChanges.length} changes\x1b[0m`);
  return appliedChanges;
}

/**
 * Process insert operations
 */
async function processInserts(
  entityType: EntityType, 
  changes: TableChangeTest[], 
  transactionManager: any,
  appliedChanges: TableChangeTest[]
): Promise<void> {
  if (!changes.length) return;
  
  const EntityClass = getEntityClass(entityType);
  const repository = transactionManager.getRepository(EntityClass);
  
  try {
    // Process entities individually to handle errors per entity
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      
      try {
        // Create entity from change
        const entity = new EntityClass();
        Object.assign(entity, change.data);
        
        // Add batch ID to entity if present in the change
        if (change.batchId) {
          (entity as any).__batchId = change.batchId;
        }
        
        // Validate entity before saving
        const errors = await validateEntity(entity);
        if (errors.length > 0) {
          throw new Error(`Validation failed: ${errors.join(', ')}`);
        }
        
        // Insert the entity
        await repository.save(entity);
        
        // Add to applied changes
        appliedChanges.push(change);
      } catch (e) {
        // Log error but continue with other changes
        const error = e as Error;
        logger.error(`Error inserting ${entityType} entity ${change.data?.id}: ${error.message}`);
      }
    }
  } catch (error) {
    logger.error(`Error batch inserting ${entityType} entities: ${error}`);
    // Don't rethrow to continue with other entity types
  }
}

/**
 * Process update operations
 */
async function processUpdates(
  entityType: EntityType, 
  changes: TableChangeTest[], 
  transactionManager: any,
  appliedChanges: TableChangeTest[]
): Promise<void> {
  if (!changes.length) return;
  
  const EntityClass = getEntityClass(entityType);
  const repository = transactionManager.getRepository(EntityClass);
  
  try {
    // Group by ID for efficient updates
    const changesByEntityId = changes.reduce((acc, change) => {
      const id = change.data.id as string;
      acc[id] = change;
      return acc;
    }, {} as Record<string, TableChangeTest>);
    
    // Get entity IDs to update
    const entityIds = Object.keys(changesByEntityId);
    
    // Fetch existing entities in one query
    const existingEntities = await repository.find({
      where: { id: In(entityIds) }
    });
    
    if (existingEntities.length !== entityIds.length) {
      logger.warn(`Found only ${existingEntities.length} of ${entityIds.length} ${entityType} entities to update`);
    }
    
    // Process each entity individually
    for (const entity of existingEntities) {
      try {
        const change = changesByEntityId[entity.id];
        if (!change) continue;
        
        // Apply data changes
        Object.entries(change.data).forEach(([key, value]) => {
          if (key !== 'id') {
            (entity as any)[key] = value;
          }
        });
        
        // Add batch ID to entity if present in the change
        if (change.batchId) {
          (entity as any).__batchId = change.batchId;
        }
        
        // Validate entity before saving
        const errors = await validateEntity(entity);
        if (errors.length > 0) {
          throw new Error(`Validation failed: ${errors.join(', ')}`);
        }
        
        // Save the entity
        await repository.save(entity);
        
        // Add to applied changes
        appliedChanges.push(change);
      } catch (e) {
        // Log error but continue with other entities
        const error = e as Error;
        logger.error(`Error updating ${entityType} entity ${entity.id}: ${error.message}`);
      }
    }
  } catch (error) {
    logger.error(`Error updating ${entityType} entities: ${error}`);
    // Don't rethrow to continue with other entity types
  }
}

/**
 * Analyze cascade delete impact without performing the delete
 * Returns all entities that would be affected by deleting the specified entity
 */
export async function analyzeCascadeDelete(
  entityType: EntityType,
  entityId: string
): Promise<Record<EntityType, string[]>> {
  try {
    // Use the enhanced getEntityCascadeGraph from entity-adapter
    return await getEntityCascadeGraph(entityType, entityId);
  } catch (error) {
    logger.error(`Error analyzing cascade delete for ${entityType} ${entityId}: ${error}`);
    // Return empty sets if analysis fails
    return {
      user: [],
      project: [],
      task: [],
      comment: []
    };
  }
}

/**
 * Process delete operations
 */
async function processDeletes(
  entityType: EntityType, 
  changes: TableChangeTest[], 
  transactionManager: any,
  appliedChanges: TableChangeTest[]
): Promise<void> {
  if (!changes.length) return;
  
  const EntityClass = getEntityClass(entityType);
  const repository = transactionManager.getRepository(EntityClass);
  
  try {
    // Extract entity IDs to delete
    const entityIds = changes.map(change => change.data.id as string);
    
    // Track deleted entities with a Set to avoid duplicates (compatible with performCascadeDelete)
    const deletedEntityIds = new Set<string>();
    
    // For summary reporting, track deleted entities by type
    const deletedEntitiesByType: Record<EntityType, string[]> = {
      user: [],
      project: [],
      task: [],
      comment: []
    };
    
    // Track cascade sources for logging
    const cascadeSources: Record<string, string> = {};
    
    // Process each delete individually
    for (const entityId of entityIds) {
      try {
        // Only process if not already deleted (could be part of a cascade)
        if (!deletedEntityIds.has(entityId)) {
          // Check for cascade relationships
          const cascadeRelationships = getCascadeRelationships(entityType);
          
          // Check if entity exists before deleting
          const entity = await repository.findOneBy({ id: entityId } as any);
          
          if (!entity) {
            logger.warn(`Entity ${entityType} with ID ${entityId} not found for deletion`);
            continue;
          }
          
          // Find the corresponding change
          const change = changes.find(c => c.data?.id === entityId);
          if (!change) {
            logger.warn(`No change found for ${entityType} with ID ${entityId}`);
            continue;
          }
          
          // Handle cascade deletes for entity relationships
          await performCascadeDelete(
            entityType,
            entityId,
            transactionManager,
            appliedChanges,
            deletedEntityIds,
            cascadeSources,
            `Direct delete operation`
          );
          
          // Delete the entity
          await repository.remove(entity);
          
          // Add to applied changes list
          appliedChanges.push(change);
          
          // Mark as deleted in both tracking structures
          deletedEntityIds.add(entityId);
          deletedEntitiesByType[entityType].push(entityId);
        }
      } catch (e) {
        // Log error but continue with other deletes
        const error = e as Error;
        logger.error(`Error deleting ${entityType} entity ${entityId}: ${error.message}`);
      }
    }
    
    // Summary of deletions
    if (entityType === 'comment' && deletedEntitiesByType.comment.length > 0) {
      logger.info(`\x1b[34mSuccessfully deleted ${deletedEntitiesByType.comment.length} comments\x1b[0m`);
    }
  } catch (error) {
    logger.error(`Error batch deleting ${entityType} entities: ${error}`);
    // Don't rethrow to continue with other entity types
  }
}

/**
 * Perform cascade delete for an entity
 * This handles deleting an entity and all its dependent entities based on cascade relationships
 */
async function performCascadeDelete(
  entityType: EntityType,
  entityId: string,
  transactionManager: any,
  appliedChanges: TableChangeTest[],
  deletedEntityIds: Set<string>,
  cascadeSources: Record<string, string>,
  sourceDescription: string,
  options: {
    softDelete?: boolean;
  } = {}
): Promise<void> {
  // Skip if already processed to avoid circular references
  if (deletedEntityIds.has(entityId)) {
    return;
  }
  
  try {
    // Get cascade graph for this entity
    const cascadeGraph = await analyzeCascadeDelete(entityType, entityId);
    
    // Get the entity repository
    const EntityClass = getEntityClass(entityType);
    const repository = transactionManager.getRepository(EntityClass);
    
    // Find the entity
    const entity = await repository.findOne({
      where: { id: entityId }
    });
    
    // Skip if entity doesn't exist
    if (!entity) {
      logger.warn(`Entity ${entityType} with ID ${entityId} not found for cascade delete`);
      return;
    }
    
    // Process cascaded entities in reverse dependency order
    for (const targetType of [...DEPENDENCY_ORDER].reverse()) {
      const targetIds = cascadeGraph[targetType];
      if (targetIds.length === 0 || targetType === entityType) continue;
      
      // Get target entity class and repository
      const TargetClass = getEntityClass(targetType);
      const targetRepo = transactionManager.getRepository(TargetClass);
      
      // Process each target entity
      for (const targetId of targetIds) {
        try {
          // Skip if already deleted
          if (deletedEntityIds.has(targetId)) continue;
          
          // Find the entity
          const targetEntity = await targetRepo.findOne({
            where: { id: targetId }
          });
          
          if (targetEntity) {
            // Create a change record with source information
            const change = entityToChange(targetEntity, 'delete');
            
            // Add metadata about the source of this delete operation
            if (!change.data) {
              change.data = {};
            }
            
            if (typeof change.data === 'object') {
              (change.data as any).__metadata = {
                source: `Cascade from ${entityType} ${entityId}`,
                cascadeDelete: true
              };
            }
            
            // Add the change to applied changes
            appliedChanges.push(change);
            
            // Track cascade source
            cascadeSources[`${targetType}:${targetId}`] = `${entityType}:${entityId}`;
            
            // Delete the entity
            if (options.softDelete && 'isDeleted' in targetEntity) {
              targetEntity.isDeleted = true;
              targetEntity.updatedAt = new Date();
              await targetRepo.save(targetEntity);
              logger.debug(`Soft deleted ${targetType} with ID ${targetId} (cascade from ${entityType} ${entityId})`);
            } else {
              await targetRepo.delete(targetId);
              logger.debug(`Hard deleted ${targetType} with ID ${targetId} (cascade from ${entityType} ${entityId})`);
            }
            
            // Mark as deleted
            deletedEntityIds.add(targetId);
          }
        } catch (e) {
          // Log error but continue with other cascade deletes
          const error = e as Error;
          logger.error(`Error cascade deleting ${targetType} entity ${targetId}: ${error.message}`);
        }
      }
    }
    
    // Create a change record with source information
    const change = entityToChange(entity, 'delete');
    
    // Add metadata about the source of this delete operation
    if (!change.data) {
      change.data = {};
    }
    if (typeof change.data === 'object') {
      (change.data as any).__metadata = {
        source: sourceDescription,
        cascadeDelete: true
      };
    }
    
    // Only add to applied changes if this is a cascade target, not the primary entity
    // This prevents double-counting when called from processDeletes
    if (sourceDescription !== 'Direct delete operation') {
      appliedChanges.push(change);
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
    
    // Mark this entity as deleted
    deletedEntityIds.add(entityId);
  } catch (e) {
    // Log error but don't throw to allow other deletes to continue
    const error = e as Error;
    logger.error(`Error performing cascade delete for ${entityType} ${entityId}: ${error.message}`);
  }
} 