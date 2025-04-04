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
 * Options for generating changes
 */
export interface ChangeGenOptions {
  // Entity type distribution
  distribution?: Partial<Record<EntityType, number>>;
  
  // Operation distribution (CRUD)
  operations?: {
    create: number;
    update: number;
    delete: number;
  };
  
  // Predefined operation modes
  mode?: 'seed' | 'mixed';
  
  // Minimum counts to ensure per entity type
  minCounts?: Partial<Record<EntityType, number>>;
  
  // Duplication options
  duplication?: {
    enabled: boolean;
    percentage?: number; // Percentage of updates that should be duplicates (0-1), default 0.3
    duplicateCount?: number; // How many duplicates per entity, default 2
  };
  
  // Use existing entity IDs
  useExistingIds?: boolean;
  
  // Minimum batch size threshold for user deletes
  userDeleteThreshold?: number;
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
 * Generate changes for testing
 * Simplified version that focuses on generating exactly the requested number of changes
 * 
 * @param count Total number of changes to generate
 * @param options Simple options object with mode and distribution fractions
 * @returns Generated changes object
 */
export async function generateChanges(
  count: number,
  options: {
    mode?: 'seed' | 'normal' | 'mixed';
    distribution?: {
      user?: number;
      project?: number;
      task?: number;
      comment?: number;
    };
    useExistingIds?: boolean;
  } = {}
): Promise<GeneratedChanges> {
  logger.info(`Generating exactly ${count} changes across entity types`);

  // Default options
  const mode = options.mode || 'normal';
  const useExistingIds = options.useExistingIds !== false;
  
  // Get data source and fetch existing IDs
  const dataSource = await getDataSource();
  const existingIds = await fetchExistingEntityIds(ORDERED_ENTITY_TYPES);
  
  // If in seed mode, avoid deletes and focus on inserts
  const avoidUserDeletes = mode === 'seed' || count < 20;
  if (avoidUserDeletes) {
    logger.info(`Batch size ${count} is below user delete threshold (20), avoiding user deletes`);
  }
  
  if (mode === 'seed') {
    logger.info('Using seed mode: 100% inserts');
  }
  
  // Define operation distributions
  const operations = {
    create: mode === 'seed' ? 1.0 : 0.7,
    update: mode === 'seed' ? 0.0 : 0.2,
    delete: mode === 'seed' ? 0.0 : 0.1
  };
  
  // Distribute changes across entity types using simple fractions
  // Default distribution if none provided
  const defaultDistribution = {
    user: 0.1,    // 10% users
    project: 0.1,  // 10% projects
    task: 0.3,     // 30% tasks
    comment: 0.5   // 50% comments
  };
  
  // Use provided distribution or default
  const distribution = options.distribution || defaultDistribution;
  
  // Normalize distribution to ensure it adds up to 1.0
  const total = Object.values(distribution).reduce((sum, val) => sum + (val || 0), 0);
  const normalizedDistribution = {
    user: (distribution.user || defaultDistribution.user) / total,
    project: (distribution.project || defaultDistribution.project) / total,
    task: (distribution.task || defaultDistribution.task) / total,
    comment: (distribution.comment || defaultDistribution.comment) / total
  };
  
  // Calculate exact counts for each entity type
  const exactCount: Record<EntityType, number> = {
    user: Math.round(count * normalizedDistribution.user),
    project: Math.round(count * normalizedDistribution.project),
    task: Math.round(count * normalizedDistribution.task),
    comment: Math.round(count * normalizedDistribution.comment)
  };
  
  // Adjust to ensure exact count
  const calculatedTotal = Object.values(exactCount).reduce((sum, val) => sum + val, 0);
  if (calculatedTotal !== count) {
    // Adjust comment count to match total (comments are usually the most abundant)
    exactCount.comment += (count - calculatedTotal);
  }
  
  // Log the exact distribution being used
  logger.info(`Using distribution: user=${exactCount.user}, project=${exactCount.project}, task=${exactCount.task}, comment=${exactCount.comment}`);
  logger.info(`Total: ${Object.values(exactCount).reduce((sum, val) => sum + val, 0)} changes`);
  
  const generatedChanges: GeneratedChanges = {};
  
  // Process entity types in dependency order (from parent to child)
  for (const entityType of ORDERED_ENTITY_TYPES) {
    const typeCount = exactCount[entityType] || 0;
    if (typeCount <= 0) {
      continue;
    }
    
    logger.info(`Generating ${typeCount} changes for ${entityType}`);
    
    // Initialize change containers
    if (!generatedChanges[entityType]) {
      generatedChanges[entityType] = {
        create: [],
        update: [],
        delete: []
      };
    }
    
    // For each entity type, determine how many creates/updates/deletes based on mode
    let createCount, updateCount, deleteCount;
    
    if (mode === 'seed') {
      // In seed mode, do 100% creates
      createCount = typeCount;
      updateCount = 0;
      deleteCount = 0;
    } else {
      // In normal mode, respect the operations distribution
      createCount = entityType === 'user' || existingIds[entityType].length < 2 ? 
        typeCount : Math.round(typeCount * operations.create);
      
      updateCount = existingIds[entityType].length > 0 ? 
        Math.round(typeCount * operations.update) : 0;
      
      deleteCount = !avoidUserDeletes && existingIds[entityType].length > 1 ? 
        typeCount - createCount - updateCount : 0;
      
      // Ensure we get exactly typeCount total operations
      if (createCount + updateCount + deleteCount !== typeCount) {
        // Adjust create count to make up the difference
        createCount += typeCount - (createCount + updateCount + deleteCount);
      }
    }
    
    // Generate creates with relationships
    if (createCount > 0) {
      if (entityType === 'user') {
        // For users, just create them directly
        const newUsers = generateEntities(entityType, createCount, existingIds);
        generatedChanges[entityType].create = newUsers.map((entity: User) => {
          if (!entity.id) entity.id = uuidv4();
          existingIds[entityType].push(entity.id);
          return entity;
        });
      } else if (entityType === 'project') {
        // Projects need owner references
        const newProjects = generateEntities(entityType, createCount, existingIds);
        generatedChanges[entityType].create = newProjects.map((project: Project) => {
          if (!project.id) project.id = uuidv4();
          
          // Always link to an existing user
          if (existingIds.user.length > 0) {
            const userIndex = Math.floor(Math.random() * existingIds.user.length);
            project.ownerId = existingIds.user[userIndex];
          }
          
          existingIds[entityType].push(project.id);
          return project;
        });
      } else if (entityType === 'task') {
        // Tasks need project and assignee references
        const newTasks = generateEntities(entityType, createCount, existingIds);
        generatedChanges[entityType].create = newTasks.map((task: Task) => {
          if (!task.id) task.id = uuidv4();
          
          // Link to project
          if (existingIds.project.length > 0) {
            const projectIndex = Math.floor(Math.random() * existingIds.project.length);
            task.projectId = existingIds.project[projectIndex];
          }
          
          // Link to assignee
          if (existingIds.user.length > 0) {
            const userIndex = Math.floor(Math.random() * existingIds.user.length);
            task.assigneeId = existingIds.user[userIndex];
          }
          
          existingIds[entityType].push(task.id);
          return task;
        });
      } else if (entityType === 'comment') {
        // Comments need author, entity, and sometimes parent references
        const newComments = generateEntities(entityType, createCount, existingIds);
        generatedChanges[entityType].create = newComments.map((comment: Comment) => {
          if (!comment.id) comment.id = uuidv4();
          
          // Link to task or project as entity
          if (existingIds.task.length > 0 && Math.random() > 0.3) {
            const taskIndex = Math.floor(Math.random() * existingIds.task.length);
            comment.entityId = existingIds.task[taskIndex];
            comment.entityType = 'task';
          } else if (existingIds.project.length > 0) {
            const projectIndex = Math.floor(Math.random() * existingIds.project.length);
            comment.entityId = existingIds.project[projectIndex];
            comment.entityType = 'project';
          } else if (existingIds.task.length > 0) {
            // Fallback to task if we have any
            const taskIndex = Math.floor(Math.random() * existingIds.task.length);
            comment.entityId = existingIds.task[taskIndex];
            comment.entityType = 'task';
          }
          
          // Always link to an existing user as author
          if (existingIds.user.length > 0) {
            const userIndex = Math.floor(Math.random() * existingIds.user.length);
            comment.authorId = existingIds.user[userIndex];
          }
          
          // Occasionally link to another comment as parent (25% chance)
          if (existingIds.comment.length > 0 && Math.random() > 0.75) {
            const parentIndex = Math.floor(Math.random() * existingIds.comment.length);
            comment.parentId = existingIds.comment[parentIndex];
          } else {
            comment.parentId = undefined;
          }
          
          existingIds[entityType].push(comment.id);
          return comment;
        });
      }
    }
    
    // Generate updates - if we have existing IDs
    if (updateCount > 0 && existingIds[entityType].length > 0) {
      // Get a subset of existing IDs to update
      const updateIds = [...existingIds[entityType]];
      
      // Shuffle and take subset
      const idsToUpdate = updateCount > updateIds.length ? 
        updateIds : 
        updateIds.sort(() => 0.5 - Math.random()).slice(0, updateCount);
      
      // For each ID, generate an update
      const updates = [];
      for (const id of idsToUpdate) {
        const update: any = { id };
        
        // Add specific updates based on entity type
        if (entityType === 'user') {
          update.name = faker.person.fullName();
          update.email = faker.internet.email();
        } else if (entityType === 'project') {
          update.name = faker.company.name();
          update.description = faker.company.catchPhrase();
        } else if (entityType === 'task') {
          update.title = faker.company.catchPhrase();
          update.status = getRandomEnum(TaskStatus);
          update.priority = getRandomEnum(TaskPriority);
        } else if (entityType === 'comment') {
          update.content = `Updated ${faker.lorem.paragraph()}`;
        }
        
        updates.push(update);
      }
      
      generatedChanges[entityType].update = updates;
    }
    
    // Generate deletes - if we have existing IDs and aren't avoiding deletes
    if (deleteCount > 0 && existingIds[entityType].length > 0 && !avoidUserDeletes) {
      // Get a subset of existing IDs to delete
      const deleteIds = [...existingIds[entityType]];
      
      // Shuffle and take subset
      const idsToDelete = deleteCount > deleteIds.length ? 
        deleteIds : 
        deleteIds.sort(() => 0.5 - Math.random()).slice(0, deleteCount);
      
      generatedChanges[entityType].delete = idsToDelete;
    }
  }
  
  // Validate total count to ensure we generated exactly what was requested
  let actualTotal = 0;
  Object.values(generatedChanges).forEach(entityChanges => {
    actualTotal += entityChanges.create.length + entityChanges.update.length + entityChanges.delete.length;
  });
  
  if (actualTotal !== count) {
    logger.warn(`Generated ${actualTotal} changes, which differs from requested count of ${count}. Adjusting...`);
    
    // Adjust by adding/removing comments (easiest to adjust)
    const diff = count - actualTotal;
    if (diff > 0) {
      // Need to add more changes - create additional comments
      const additionalComments = generateEntities('comment', diff, existingIds);
      
      // Add author and entity references
      additionalComments.forEach(comment => {
        if (!comment.id) comment.id = uuidv4();
        
        // Link to task or project
        if (existingIds.task.length > 0) {
          const taskIndex = Math.floor(Math.random() * existingIds.task.length);
          comment.entityId = existingIds.task[taskIndex];
          comment.entityType = 'task';
        } else if (existingIds.project.length > 0) {
          const projectIndex = Math.floor(Math.random() * existingIds.project.length);
          comment.entityId = existingIds.project[projectIndex];
          comment.entityType = 'project';
        }
        
        // Add author
        if (existingIds.user.length > 0) {
          const userIndex = Math.floor(Math.random() * existingIds.user.length);
          comment.authorId = existingIds.user[userIndex];
        }
        
        existingIds.comment.push(comment.id);
      });
      
      // Add to the generated changes
      if (!generatedChanges.comment) {
        generatedChanges.comment = { create: [], update: [], delete: [] };
      }
      generatedChanges.comment.create.push(...additionalComments);
      
      logger.info(`Added ${diff} additional comments to match requested count`);
    } else if (diff < 0) {
      // Need to remove some changes - remove from comments if possible
      const excessCount = -diff;
      
      if (generatedChanges.comment && generatedChanges.comment.create.length > excessCount) {
        // Remove from comments.create
        generatedChanges.comment.create = generatedChanges.comment.create.slice(0, -excessCount);
        logger.info(`Removed ${excessCount} comments to match requested count`);
      } else {
        // Otherwise remove from wherever possible
        let remaining = excessCount;
        
        for (const entityType of ['comment', 'task', 'project', 'user'] as EntityType[]) {
          if (remaining <= 0) break;
          
          if (generatedChanges[entityType]) {
            // Try to remove from creates first
            if (generatedChanges[entityType].create.length > remaining) {
              generatedChanges[entityType].create = generatedChanges[entityType].create.slice(0, -remaining);
              logger.info(`Removed ${remaining} ${entityType} creates to match requested count`);
              remaining = 0;
              break;
            } else if (generatedChanges[entityType].create.length > 0) {
              const removed = generatedChanges[entityType].create.length;
              generatedChanges[entityType].create = [];
              remaining -= removed;
              logger.info(`Removed ${removed} ${entityType} creates (${remaining} remaining)`);
            }
            
            // Then try updates
            if (remaining > 0 && generatedChanges[entityType].update.length > remaining) {
              generatedChanges[entityType].update = generatedChanges[entityType].update.slice(0, -remaining);
              logger.info(`Removed ${remaining} ${entityType} updates to match requested count`);
              remaining = 0;
              break;
            } else if (remaining > 0 && generatedChanges[entityType].update.length > 0) {
              const removed = generatedChanges[entityType].update.length;
              generatedChanges[entityType].update = [];
              remaining -= removed;
              logger.info(`Removed ${removed} ${entityType} updates (${remaining} remaining)`);
            }
            
            // Finally try deletes
            if (remaining > 0 && generatedChanges[entityType].delete.length > remaining) {
              generatedChanges[entityType].delete = generatedChanges[entityType].delete.slice(0, -remaining);
              logger.info(`Removed ${remaining} ${entityType} deletes to match requested count`);
              remaining = 0;
              break;
            } else if (remaining > 0 && generatedChanges[entityType].delete.length > 0) {
              const removed = generatedChanges[entityType].delete.length;
              generatedChanges[entityType].delete = [];
              remaining -= removed;
              logger.info(`Removed ${removed} ${entityType} deletes (${remaining} remaining)`);
            }
          }
        }
      }
    }
  }
  
  // Final validation
  let finalTotal = 0;
  Object.entries(generatedChanges).forEach(([entityType, entityChanges]) => {
    const entityTotal = entityChanges.create.length + entityChanges.update.length + entityChanges.delete.length;
    finalTotal += entityTotal;
    logger.info(`${entityType}: ${entityTotal} changes (${entityChanges.create.length} create, ${entityChanges.update.length} update, ${entityChanges.delete.length} delete)`);
  });
  
  logger.info(`Finished generating changes: ${finalTotal} total (requested: ${count})`);
  
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
  // Generate changes in memory - the count adjustment is now handled inside generateChanges
  const changes = await generateChanges(count, options);
  
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
 * Apply changes to the database in smaller batches to avoid overloading the database
 * This is particularly useful for large change sets that might exceed database limits
 */
export async function applyChangesInBatches(
  tableChanges: TableChange[],
  options: {
    batchSize?: number;
  } = {}
): Promise<TableChange[]> {
  // Smaller batch size of 10 instead of 50
  const { batchSize = 10 } = options;
  
  if (!tableChanges.length) {
    logger.warn('No changes to apply');
    return [];
  }
  
  logger.info(`Applying ${tableChanges.length} changes to database in batches of ${batchSize}`);
  
  // Split changes into smaller batches
  const batches = [];
  for (let i = 0; i < tableChanges.length; i += batchSize) {
    batches.push(tableChanges.slice(i, i + batchSize));
  }
  
  logger.info(`Split changes into ${batches.length} batches`);
  
  // Process each batch sequentially
  const allAppliedChanges: TableChange[] = [];
  const failedChanges: Array<{change: TableChange, error: any}> = [];
  
  // Helper function to generate a unique key for a change
  const getChangeKey = (change: TableChange): string => {
    const entityId = change.data.id || change.data.entityId || JSON.stringify(change.data);
    return `${change.table}:${change.operation}:${entityId}`;
  };
  
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    logger.info(`Processing batch ${i+1}/${batches.length} with ${batch.length} changes`);
    
    try {
      // Each batch is processed in a single transaction with dependency ordering
      const batchAppliedChanges = await applyBatchChanges(batch);
      allAppliedChanges.push(...batchAppliedChanges);
      
      // Check if any changes were skipped
      if (batchAppliedChanges.length < batch.length) {
        const skippedCount = batch.length - batchAppliedChanges.length;
        logger.warn(`${skippedCount} changes were skipped in batch ${i+1}`);
        
        // Identify which changes were skipped
        const appliedKeys = new Set(batchAppliedChanges.map(getChangeKey));
        const skippedChanges = batch.filter(change => !appliedKeys.has(getChangeKey(change)));
        
        // Log skipped changes for debugging
        skippedChanges.forEach(change => {
          const entityId = change.data.id || 'unknown';
          failedChanges.push({
            change,
            error: new Error(`Change was skipped during batch processing`)
          });
          logger.warn(`Skipped change: ${change.operation} on ${change.table} with ID ${entityId}`);
        });
      }
      
      logger.info(`Completed batch ${i+1}/${batches.length}, applied ${batchAppliedChanges.length} changes`);
    } catch (error) {
      // Log error but continue processing other batches
      logger.error(`Error processing batch ${i+1}/${batches.length}: ${error}`);
      
      // Attempt to apply each change individually
      logger.info(`Attempting to apply changes individually for batch ${i+1}`);
      
      for (const change of batch) {
        try {
          const singleChangeResult = await applyBatchChanges([change]);
          if (singleChangeResult.length > 0) {
            allAppliedChanges.push(...singleChangeResult);
            const entityId = change.data.id || 'unknown';
            logger.info(`Successfully applied individual change: ${change.operation} on ${change.table} with ID ${entityId}`);
          } else {
            const entityId = change.data.id || 'unknown';
            failedChanges.push({
              change,
              error: new Error(`Individual change processing failed with no error`)
            });
            logger.warn(`Failed to apply individual change: ${change.operation} on ${change.table} with ID ${entityId}`);
          }
        } catch (individualError) {
          const entityId = change.data.id || 'unknown';
          failedChanges.push({
            change,
            error: individualError
          });
          logger.warn(`Failed to apply individual change: ${change.operation} on ${change.table} with ID ${entityId}, error: ${individualError}`);
        }
      }
    }
  }
  
  // Log summary of applied and failed changes
  logger.info(`Successfully applied ${allAppliedChanges.length} changes to database in ${batches.length} batches`);
  
  if (failedChanges.length > 0) {
    logger.warn(`${failedChanges.length} changes failed to apply`);
    
    // Group failed changes by entity type and operation
    const failedByTable: Record<string, number> = {};
    failedChanges.forEach(({change}) => {
      failedByTable[change.table] = (failedByTable[change.table] || 0) + 1;
    });
    
    // Log summary of failed changes
    Object.entries(failedByTable).forEach(([table, count]) => {
      logger.warn(`Failed changes for table ${table}: ${count}`);
    });
  }
  
  return allAppliedChanges;
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
  batchSize?: number;
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