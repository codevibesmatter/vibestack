/**
 * Change operations for entity changes
 * Handles change generation and application to the database
 */

import { v4 as uuidv4 } from 'uuid';
import { In } from 'typeorm';
import { faker } from '@faker-js/faker';
import { TableChange } from '@repo/sync-types';
import { 
  TaskStatus, 
  TaskPriority,
  ProjectStatus,
  UserRole,
  User, 
  Project, 
  Task, 
  Comment
} from '@repo/dataforge/server-entities';

import { createLogger } from '../logger.ts';
import { 
  EntityType, 
  EntityTypeMapping, 
  ENTITY_TO_TABLE_MAP, 
  TABLE_TO_ENTITY_MAP, 
  ORDERED_ENTITY_TYPES,
  getEntityClassForType,
  getRandomEnum 
} from './entity-definitions.ts';
import { 
  getDataSource, 
  fetchExistingEntityIds,
  applyBatchChanges
} from './db-utils.ts';
import { generateEntity, generateEntities } from './generators.ts';
import { ChangeTracker, ChangeTrackerReport } from './change-tracker.ts';

// Import the validation functions that we need for internal use
import {
  getCurrentLSN,
  initializeReplication,
  queryChangeHistory,
  queryWALDirectly,
  listReplicationSlots as getReplicationSlots,
  getReplicationSlotInfo,
  validateEntityChanges
} from './validation.ts';

// Initialize logger
const logger = createLogger('EntityChanges:Changes');

/**
 * Options for change generation
 */
export interface ChangeGenOptions {
  distribution?: Partial<Record<EntityType, number>>;
  operations?: {
    create: number;
    update: number;
    delete: number;
  };
  mode?: 'seed' | 'mixed'; // 'seed' = insert only, 'mixed' = normal distribution
  useExistingIds?: boolean;
  // Add duplication options
  duplication?: {
    enabled: boolean;
    percentage?: number; // Percentage of updates that should be duplicates (0-1), default 0.3
    duplicateCount?: number; // How many duplicates per entity, default 2
  };
  // Minimum counts per entity type to ensure we have parent entities
  minCounts?: Partial<Record<EntityType, number>>;
}

/**
 * Structure of generated changes
 */
export interface GeneratedChanges {
  [entityType: string]: {
    create: Partial<any>[];
    update: Partial<any>[];
    delete: string[];
  };
}

/**
 * Generate a comprehensive set of changes across entity types
 */
export async function generateChanges(
  count: number,
  options: ChangeGenOptions = {}
): Promise<GeneratedChanges> {
  logger.info(`Generating ${count} changes across entity types`);
  
  // Default distribution - equal across all entity types
  const entityTypes = ORDERED_ENTITY_TYPES;
  const defaultDistribution: Record<EntityType, number> = {
    task: 0.25,
    project: 0.25,
    user: 0.25,
    comment: 0.25
  };
  
  // Use provided distribution or default
  const distribution: Record<EntityType, number> = {
    ...defaultDistribution,
    ...options.distribution as Record<EntityType, number>
  };
  
  // Normalize distribution
  const totalWeight = Object.values(distribution).reduce((sum, weight) => sum + weight, 0);
  const normalizedDistribution: Record<EntityType, number> = {
    task: 0,
    project: 0,
    user: 0,
    comment: 0
  };
  
  Object.entries(distribution).forEach(([type, weight]) => {
    normalizedDistribution[type as EntityType] = weight / totalWeight;
  });
  
  // Hold tracking of IDs for references
  let existingIds: Record<EntityType, string[]> = {
    task: [],
    project: [],
    user: [],
    comment: []
  };
  
  // If useExistingIds is true, fetch IDs from the database first
  // This is needed to check if we have enough parent entities
  if (options.useExistingIds) {
    // Fetch existing IDs from the database
    const maxIdsToFetch = Math.max(50, count * 2);
    existingIds = await fetchExistingEntityIds(entityTypes, maxIdsToFetch);
    
    // Check if we have enough parent entities for all required types
    const minCounts = options.minCounts || {};
    const haveEnoughParents = entityTypes.every(type => 
      !minCounts[type] || existingIds[type].length >= (minCounts[type] || 0)
    );
    
    // If we have enough parent entities, adjust distribution to favor child entities
    if (haveEnoughParents) {
      // Find the child-most entity type (usually 'comment' in our hierarchy)
      // which is the last one in the ORDERED_ENTITY_TYPES list
      const childEntityType = entityTypes[entityTypes.length - 1];
      
      logger.info(`Have enough parent entities, favoring ${childEntityType} entities in distribution`);
      
      // Reset distribution to strongly favor the child type
      // Only allocate a small percentage to parent types for diversity
      const adjustedDistribution: Record<EntityType, number> = {
        task: 0.05,
        project: 0.05,
        user: 0.05,
        comment: 0.85  // Heavily favor the child entity
      };
      
      // Recalculate normalized distribution
      const adjustedTotalWeight = Object.values(adjustedDistribution).reduce((sum, weight) => sum + weight, 0);
      
      // Override the normalized distribution
      Object.entries(adjustedDistribution).forEach(([type, weight]) => {
        normalizedDistribution[type as EntityType] = weight / adjustedTotalWeight;
      });
      
      logger.info(`Adjusted distribution to favor child entities: ${JSON.stringify(normalizedDistribution)}`);
    }
  }
  
  // Default operation distribution
  let operations = options.operations || { create: 0.6, update: 0.3, delete: 0.1 };
  
  // Apply predefined modes if specified
  if (options.mode === 'seed') {
    operations = { create: 1, update: 0, delete: 0 };
    logger.info('Using seed mode: 100% inserts');
  }
  
  // Get duplication options
  const duplication = options.duplication || { enabled: false };
  const isDuplicationEnabled = duplication.enabled === true;
  const duplicationPercentage = duplication.percentage || 0.3; // Default 30% of updates become duplicates
  const duplicateCount = duplication.duplicateCount || 2; // Default 2 duplicates per entity
  
  // Adjust operations if duplication is enabled to reserve some updates for duplicates
  let adjustedOperations = { ...operations };
  
  if (isDuplicationEnabled && operations.update > 0) {
    // Calculate how many updates will be used for duplicates
    const totalDuplicateUpdates = Math.floor(count * operations.update * duplicationPercentage * (duplicateCount - 1));
    
    // Remove these from the total count to stay within the requested total changes
    const adjustedCount = Math.max(1, count - totalDuplicateUpdates);
    count = adjustedCount;
    
    logger.info(`Duplication enabled. Reserved ${totalDuplicateUpdates} changes for duplicates. Adjusted count: ${adjustedCount}`);
  }
  
  // Normalize operations
  const totalOperations = adjustedOperations.create + adjustedOperations.update + adjustedOperations.delete;
  const normalizedOperations = {
    create: adjustedOperations.create / totalOperations,
    update: adjustedOperations.update / totalOperations,
    delete: adjustedOperations.delete / totalOperations
  };
  
  // Calculate counts per entity type and operation
  const entityCounts: Record<EntityType, number> = {
    task: 0,
    project: 0,
    user: 0,
    comment: 0
  };
  let remainingCount = count;
  
  // Apply minimum counts if specified
  const minCounts = options.minCounts || {};
  let totalMinCount = 0;
  
  // First, allocate minimum counts to ensure we have enough parent entities
  // but only if we don't already have enough existing IDs
  for (const entityType of entityTypes) {
    if (minCounts[entityType] && minCounts[entityType] > 0) {
      // If we're using existing IDs and already have enough, don't allocate minimum counts
      if (options.useExistingIds && existingIds[entityType].length >= minCounts[entityType]) {
        logger.info(`Found ${existingIds[entityType].length} existing ${entityType} IDs, skipping minimum count allocation`);
      } else {
        // We don't have enough existing IDs, so allocate the minimum count
        const neededCount = options.useExistingIds ? 
          Math.max(0, minCounts[entityType] - existingIds[entityType].length) : 
          minCounts[entityType];
        
        if (neededCount > 0) {
          entityCounts[entityType] = neededCount;
          totalMinCount += neededCount;
          logger.info(`Allocating ${neededCount} ${entityType} entities to meet minimum count requirement`);
        }
      }
    }
  }
  
  // Adjust remaining count
  remainingCount = Math.max(0, count - totalMinCount);
  
  // Then distribute the remaining count according to the distribution
  entityTypes.forEach((type, i) => {
    // Skip if this type has already been allocated its minimum count
    if (entityCounts[type] > 0) {
      remainingCount -= entityCounts[type];
      return;
    }
    
    if (i === entityTypes.length - 1) {
      // Last entity type gets all remaining count
      entityCounts[type] = remainingCount;
    } else {
      const typeCount = Math.floor(remainingCount * normalizedDistribution[type]);
      entityCounts[type] = typeCount;
      remainingCount -= typeCount;
    }
  });
  
  // Check if we need to adjust the last entity type to account for any rounding errors
  if (remainingCount > 0) {
    entityCounts[entityTypes[entityTypes.length - 1]] += remainingCount;
  }
  
  // Log the final distribution
  logger.info(`Entity count distribution: ${JSON.stringify(entityCounts)}`);
  
  // Generate changes for each entity type based on the calculated distribution
  const generatedChanges: GeneratedChanges = {};
  
  // Process entity types in dependency order
  for (const entityType of entityTypes) {
    if (!entityCounts[entityType] || entityCounts[entityType] <= 0) {
      continue;
    }
    
    const typeCount = entityCounts[entityType];
    logger.info(`Generating ${typeCount} changes for ${entityType}`);
    
    // Initialize change containers
    if (!generatedChanges[entityType]) {
      generatedChanges[entityType] = {
        create: [],
        update: [],
        delete: []
      };
    }
    
    // Calculate counts for each operation
    const createCount = Math.floor(typeCount * normalizedOperations.create);
    const updateCount = Math.floor(typeCount * normalizedOperations.update);
    const deleteCount = typeCount - createCount - updateCount;
    
    // Generate creates
    if (createCount > 0) {
      const newEntities = generateEntities(entityType, createCount, existingIds);
      
      // Store creates with IDs
      generatedChanges[entityType].create = newEntities.map((entity: EntityTypeMapping[typeof entityType]) => {
        // Ensure ID is set
        if (!entity.id) {
          entity.id = uuidv4();
        }
        
        // Track ID for relations
        existingIds[entityType].push(entity.id);
        
        return entity;
      });
    }
    
    // Generate updates - if we have existing IDs
    if (updateCount > 0) {
      // Only try to update if we have IDs
      if (existingIds[entityType]?.length > 0) {
        // Generate update entities
        const updatedEntities = existingIds[entityType]
          .slice(0, Math.min(updateCount, existingIds[entityType].length))
          .map(id => {
            const entity = generateEntity(entityType, existingIds);
            entity.id = id;
            entity.updatedAt = new Date();
            
            // Add type-specific updates
            switch (entityType) {
              case 'task':
                (entity as any).status = getRandomEnum(TaskStatus);
                (entity as any).title = `Updated ${(entity as any).title}`;
                break;
              case 'project':
                (entity as any).status = getRandomEnum(ProjectStatus);
                (entity as any).name = `Updated ${(entity as any).name}`;
                break;
              case 'user':
                (entity as any).name = `Updated ${(entity as any).name}`;
                break;
              case 'comment':
                (entity as any).content = `Updated ${(entity as any).content}`;
                break;
            }
            
            return entity;
          });
        
        generatedChanges[entityType].update = updatedEntities;
      } else {
        // Convert some create operations to updates if no existing IDs
        logger.warn(`No existing ${entityType} IDs found for updates, will generate new entities instead`);
        
        // Create additional entities to compensate for the lack of updates
        const additionalCreate = updateCount;
        if (additionalCreate > 0) {
          const newEntities = generateEntities(entityType, additionalCreate, existingIds);
          
          // Add to creates
          newEntities.forEach((entity: EntityTypeMapping[typeof entityType]) => {
            if (!entity.id) {
              entity.id = uuidv4();
            }
            
            // Track ID
            existingIds[entityType].push(entity.id);
            generatedChanges[entityType].create.push(entity);
          });
        }
      }
    }
    
    // Generate deletes - use a subset of the IDs we're tracking
    if (deleteCount > 0 && existingIds[entityType]?.length > 0) {
      // Take IDs from the end to avoid conflicts with updates
      const deleteIds = [...existingIds[entityType]].splice(-deleteCount);
      generatedChanges[entityType].delete = deleteIds;
      
      // Remove these IDs from the tracked IDs
      existingIds[entityType] = existingIds[entityType].filter(
        id => !deleteIds.includes(id)
      );
    }
  }
  
  // Generate duplicate updates if enabled
  if (isDuplicationEnabled) {
    logger.info('Generating duplicate updates for deduplication testing');
    
    for (const entityType of entityTypes) {
      // Skip if no updates for this type
      if (!generatedChanges[entityType]?.update?.length) continue;
      
      // Calculate how many entities will have duplicates
      const updates = generatedChanges[entityType].update;
      const entitiesToDuplicate = Math.max(1, Math.floor(updates.length * duplicationPercentage));
      
      // Select random entities to duplicate
      const entityIndices: number[] = [];
      for (let i = 0; i < entitiesToDuplicate; i++) {
        // Find a random entity that hasn't been selected yet
        let index: number;
        do {
          index = Math.floor(Math.random() * updates.length);
        } while (entityIndices.includes(index));
        
        entityIndices.push(index);
      }
      
      // Generate duplicates for each selected entity
      for (const index of entityIndices) {
        const originalEntity = updates[index];
        
        // Generate duplicates
        for (let i = 0; i < duplicateCount - 1; i++) {
          // Create a duplicate with slightly different values
          const duplicate = { ...originalEntity };
          
          // Make some small changes for each duplicate
          switch (entityType) {
            case 'task':
              (duplicate as any).status = getRandomEnum(TaskStatus);
              (duplicate as any).title = `${(duplicate as any).title} (Duplicate ${i + 1})`;
              break;
            case 'project':
              (duplicate as any).status = getRandomEnum(ProjectStatus);
              (duplicate as any).name = `${(duplicate as any).name} (Duplicate ${i + 1})`;
              break;
            case 'user':
              (duplicate as any).name = `${(duplicate as any).name} (Duplicate ${i + 1})`;
              break;
            case 'comment':
              (duplicate as any).content = `${(duplicate as any).content} (Duplicate ${i + 1})`;
              break;
          }
          
          // Ensure updatedAt is slightly different
          duplicate.updatedAt = new Date(duplicate.updatedAt.getTime() + (i + 1) * 100);
          
          // Add to update list
          updates.push(duplicate);
        }
      }
      
      logger.info(`Added ${entityIndices.length * (duplicateCount - 1)} duplicate updates for ${entityType}`);
    }
  }
  
  logger.info('Finished generating changes');
  return generatedChanges;
}

/**
 * Convert generated changes to TableChange format for the database
 */
export function convertToTableChanges(changes: GeneratedChanges): TableChange[] {
  const tableChanges: TableChange[] = [];
  
  Object.entries(changes).forEach(([entityType, operations]) => {
    const tableName = ENTITY_TO_TABLE_MAP[entityType as EntityType];
    
    // Process creates
    operations.create.forEach(entity => {
      tableChanges.push({
        table: tableName,
        operation: 'insert',
        data: entity,
        updated_at: new Date().toISOString()
      });
    });
    
    // Process updates
    operations.update.forEach(entity => {
      tableChanges.push({
        table: tableName,
        operation: 'update',
        data: entity,
        updated_at: new Date().toISOString()
      });
    });
    
    // Process deletes
    operations.delete.forEach(id => {
      tableChanges.push({
        table: tableName,
        operation: 'delete',
        data: { id },
        updated_at: new Date().toISOString()
      });
    });
  });
  
  return tableChanges;
}

/**
 * Generate and apply changes in a single operation
 */
export async function generateAndApplyChanges(
  count: number,
  options: ChangeGenOptions = {}
): Promise<TableChange[]> {
  // To accurately hit the target count, we need to determine how many
  // changes we'll actually generate with our current distribution and options
  
  // First, check if we can make a small test batch to calculate the ratio
  let estimatedRatio = 1;
  if (options.useExistingIds && options.minCounts) {
    logger.info(`Estimating actual change count based on distribution and options`);
    
    // Generate a small sample batch to see how many changes it produces
    const sampleSize = 5; // Small batch to check ratio
    const sampleChanges = await generateChanges(sampleSize, options);
    const sampleTableChanges = convertToTableChanges(sampleChanges);
    
    if (sampleTableChanges.length > sampleSize) {
      // We're generating more changes than requested
      estimatedRatio = sampleTableChanges.length / sampleSize;
      logger.info(`Sample batch generated ${sampleTableChanges.length} changes with ${sampleSize} requested (ratio: ${estimatedRatio.toFixed(2)})`);
    }
  }
  
  // If we have a ratio > 1, we need to adjust our count downward
  let adjustedCount = count;
  if (estimatedRatio > 1) {
    adjustedCount = Math.floor(count / estimatedRatio);
    logger.info(`Adjusting requested count from ${count} to ${adjustedCount} to hit target of ~${count} actual changes`);
  }
  
  // Generate changes in memory with the adjusted count
  const changes = await generateChanges(adjustedCount, options);
  
  // Convert to TableChange format
  const tableChanges = convertToTableChanges(changes);
  
  if (!tableChanges.length) {
    logger.warn('No changes to apply after conversion');
    return [];
  }
  
  const actualCount = tableChanges.length;
  if (Math.abs(actualCount - count) > count * 0.1) { // If off by more than 10%
    logger.info(`Generated ${actualCount} changes, which differs from target count of ${count} by ${Math.abs(actualCount - count)}`);
  }
  
  // Apply changes to database
  return await applyBatchChanges(tableChanges);
}

/**
 * Seed the database with entities - convenience function for insert-only operations
 */
export async function seedDatabase(
  count: number,
  options: Omit<ChangeGenOptions, 'mode' | 'operations'> = {}
): Promise<TableChange[]> {
  // Set seed mode
  const seedOptions: ChangeGenOptions = {
    ...options,
    mode: 'seed'
  };
  
  // Generate and apply changes in seed mode
  return await generateAndApplyChanges(count, seedOptions);
}

/**
 * Create a ChangeTracker to track and validate changes
 */
export function createChangeTracker(options: { 
  tolerance?: number; 
  deduplicationEnabled?: boolean; 
} = {}): ChangeTracker {
  return new ChangeTracker(options);
}

/**
 * Generate, apply, and track changes with validation
 * This combines change generation, application, and tracking in a single operation
 */
export async function generateAndTrackChanges(
  count: number,
  options: ChangeGenOptions & { 
    clientIds?: string[];
    tolerance?: number;
  } = {}
): Promise<{
  success: boolean;
  changes: TableChange[];
  tracker: ChangeTracker;
  report?: ChangeTrackerReport;
}> {
  const { clientIds = ['default'], tolerance = 0 } = options;
  
  try {
    logger.info(`Generating, applying, and tracking ${count} changes`);
    
    // Create a change tracker
    const tracker = createChangeTracker({ tolerance });
    
    // Register clients with the tracker
    tracker.registerClients(clientIds, count);
    
    // Generate and apply changes
    const changes = await generateAndApplyChanges(count, options);
    
    // Track the changes
    tracker.trackDatabaseChanges(changes);
    
    // Simulate all clients receiving the changes
    for (const clientId of clientIds) {
      tracker.trackChanges(clientId, changes);
    }
    
    // Check completion and get validation report
    const isComplete = tracker.checkCompletion();
    const report = tracker.getValidationReport();
    
    return {
      success: report.success,
      changes,
      tracker,
      report
    };
  } catch (error) {
    logger.error(`Error in generateAndTrackChanges: ${error}`);
    throw error;
  }
}

/**
 * Comprehensive function that combines change generation, tracking, and validation.
 * This provides an end-to-end workflow for testing entity changes:
 * 1. Generate changes in memory
 * 2. Capture the starting LSN
 * 3. Apply changes to the database
 * 4. Capture the ending LSN
 * 5. Track changes with the ChangeTracker
 * 6. Validate that changes were properly recorded in WAL and change_history
 * 
 * @param count The number of changes to generate
 * @param options Options for generation, tracking, and validation
 * @returns Results from all stages of the workflow
 */
export async function generateTrackAndValidateChanges(
  count: number,
  options: ChangeGenOptions & { 
    clientIds?: string[];
    tolerance?: number;
    skipValidation?: boolean;
  } = {}
): Promise<{
  success: boolean;
  changes: TableChange[];
  tracker: ChangeTracker;
  trackingReport?: ChangeTrackerReport;
  validation?: {
    success: boolean;
    lsnAdvanced: boolean;
    entityVerificationSuccess: boolean;
    appliedIdsByTable: Record<string, string[]>;
    foundIdsByTable: Record<string, string[]>;
    missingIdsByTable: Record<string, string[]>;
    startLSN: string;
    endLSN: string;
  };
}> {
  const { clientIds = ['default'], tolerance = 0, skipValidation = false } = options;
  
  try {
    logger.info(`Starting comprehensive entity changes workflow for ${count} changes`);
    
    // Step 1: Create a change tracker
    const tracker = createChangeTracker({ tolerance });
    
    // Step 2: Register clients with the tracker
    tracker.registerClients(clientIds, count);
    
    // Step 3: Get the starting LSN before changes
    const startLSN = await getCurrentLSN();
    logger.info(`Starting LSN before applying changes: ${startLSN}`);
    
    // Step 4: Generate and apply changes - this now handles count adjustment internally
    const changes = await generateAndApplyChanges(count, options);
    logger.info(`Generated and applied ${changes.length} changes (requested ${count})`);
    
    // Step 5: Track the changes in the database
    tracker.trackDatabaseChanges(changes);
    
    // Step 6: Simulate all clients receiving the changes
    for (const clientId of clientIds) {
      tracker.trackChanges(clientId, changes);
    }
    
    // Step 7: Get tracking completion and validation report
    const isComplete = tracker.checkCompletion();
    const trackingReport = tracker.getValidationReport();
    
    // Step 8: Get the ending LSN after changes
    const endLSN = await getCurrentLSN();
    logger.info(`Ending LSN after applying changes: ${endLSN}`);
    
    // Step 9: Validate WAL and change_history (unless explicitly skipped)
    let validationResult;
    if (!skipValidation) {
      logger.info('Validating changes in WAL and change_history');
      validationResult = await validateEntityChanges(changes, startLSN, endLSN);
    }
    
    return {
      success: trackingReport.success && (skipValidation || !!validationResult?.success),
      changes,
      tracker,
      trackingReport,
      validation: validationResult
    };
  } catch (error) {
    logger.error(`Error in generateTrackAndValidateChanges: ${error}`);
    throw error;
  }
} 