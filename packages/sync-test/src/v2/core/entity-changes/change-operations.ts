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
 * Generate a comprehensive set of changes across entity types
 */
export async function generateChanges(
  count: number,
  options: ChangeGenOptions = {}
): Promise<GeneratedChanges> {
  logger.info(`Generating exactly ${count} changes across entity types`);
  
  // Additional safety option: avoid deleting users in small batches to prevent
  // large cascading deletes that complicate testing 
  const userDeleteThreshold = options.userDeleteThreshold || 20;
  const avoidUserDeletes = count < userDeleteThreshold;
  
  if (avoidUserDeletes) {
    logger.info(`Batch size ${count} is below user delete threshold (${userDeleteThreshold}), avoiding user deletes`);
  }
  
  // Hold tracking of IDs for references
  let existingIds: Record<EntityType, string[]> = {
    task: [],
    project: [],
    user: [],
    comment: []
  };
  
  // If useExistingIds is true, fetch IDs from the database first
  if (options.useExistingIds) {
    // Only fetch a limited number of existing IDs
    const maxIdsToFetch = Math.min(Math.max(30, Math.floor(count * 0.5)), 100); // Increase fetch limit for large counts
    existingIds = await fetchExistingEntityIds(ORDERED_ENTITY_TYPES, maxIdsToFetch);
    logger.info(`Found existing IDs: users=${existingIds.user.length}, projects=${existingIds.project.length}, tasks=${existingIds.task.length}, comments=${existingIds.comment.length}`);
  }
  
  // Default operation distribution or use seed mode if specified
  let operations = options.operations || { create: 0.7, update: 0.2, delete: 0.1 };
  
  // Apply predefined modes if specified
  if (options.mode === 'seed') {
    operations = { create: 1, update: 0, delete: 0 };
    logger.info('Using seed mode: 100% inserts');
  }

  // Get duplication options
  const duplication = options.duplication || { enabled: false };
  const isDuplicationEnabled = duplication.enabled === true && count >= 10; // Only enable duplication if count >= 10
  const duplicationPercentage = duplication.percentage || 0.3; // Default 30% of updates become duplicates
  const duplicateCount = duplication.duplicateCount || 2; // Default 2 duplicates per entity
  
  if (isDuplicationEnabled) {
    logger.info(`Duplication enabled with ${duplicateCount} duplicates per entity for ${Math.round(duplicationPercentage * 100)}% of updates`);
  }
  
  // For very small counts, just create the exact entities needed
  const exactCount = options.minCounts || getFixedDistribution(count);
  
  // Validate that the distribution adds up to the requested count
  const totalExactCount = Object.values(exactCount).reduce((sum, val) => sum + val, 0);
  if (Math.abs(totalExactCount - count) > 1) { // Allow for rounding error of 1
    logger.warn(`Generated distribution total (${totalExactCount}) does not match requested count (${count}). Adjusting...`);
    
    // Adjust the largest category to make up the difference
    let largestCategory: EntityType = 'comment';
    let largestValue = exactCount.comment || 0;
    
    for (const [category, value] of Object.entries(exactCount) as [EntityType, number][]) {
      if (value > largestValue) {
        largestCategory = category;
        largestValue = value;
      }
    }
    
    // Ensure the category exists before adjusting
    if (typeof exactCount[largestCategory] === 'number') {
      const originalValue = exactCount[largestCategory] as number;
      exactCount[largestCategory] = originalValue + (count - totalExactCount);
      logger.info(`Adjusted ${largestCategory} from ${originalValue} to ${exactCount[largestCategory]}`);
    } else {
      // If somehow the largest category is undefined, add to comments as fallback
      exactCount.comment = (exactCount.comment || 0) + (count - totalExactCount);
      logger.info(`Adjusted comment from ${exactCount.comment - (count - totalExactCount)} to ${exactCount.comment}`);
    }
  }
  
  logger.info(`Using fixed distribution: ${JSON.stringify(exactCount)}`);
  
  // Generate changes for each entity type
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
    
    // For each entity type, determine how many creates/updates/deletes
    const createCount = entityType === 'user' || existingIds[entityType].length < 2 ? 
      typeCount : Math.floor(typeCount * operations.create);
    
    const updateCount = existingIds[entityType].length > 0 ? 
      Math.floor(typeCount * operations.update) : 0;
    
    const deleteCount = !avoidUserDeletes && existingIds[entityType].length > 1 ? 
      typeCount - createCount - updateCount : 0;
    
    // Generate creates with efficient relationships
    if (createCount > 0) {
      // For users, just create them directly
      if (entityType === 'user') {
        const newUsers = generateEntities(entityType, createCount, existingIds);
        generatedChanges[entityType].create = newUsers.map((entity: User) => {
          if (!entity.id) entity.id = uuidv4();
          existingIds[entityType].push(entity.id);
          return entity;
        });
      }
      // For projects, ensure they reference existing users
      else if (entityType === 'project') {
        // Make sure we have at least one user
        if (existingIds.user.length === 0) {
          const user = generateEntity('user', existingIds);
          user.id = uuidv4();
          existingIds.user.push(user.id);
          
          if (!generatedChanges.user) {
            generatedChanges.user = { create: [], update: [], delete: [] };
          }
          generatedChanges.user.create.push(user);
        }
        
        const newProjects = Array(createCount).fill(null).map(() => {
          const project = generateEntity(entityType, existingIds) as Project;
          project.id = uuidv4();
          
          // Always link to an existing user
          const userIndex = Math.floor(Math.random() * existingIds.user.length);
          project.ownerId = existingIds.user[userIndex];
          
          existingIds[entityType].push(project.id);
          return project;
        });
        
        generatedChanges[entityType].create = newProjects;
      }
      // For tasks, ensure they reference existing projects
      else if (entityType === 'task') {
        // Make sure we have at least one project
        if (existingIds.project.length === 0) {
          // And we need a user for the project
          if (existingIds.user.length === 0) {
            const user = generateEntity('user', existingIds);
            user.id = uuidv4();
            existingIds.user.push(user.id);
            
            if (!generatedChanges.user) {
              generatedChanges.user = { create: [], update: [], delete: [] };
            }
            generatedChanges.user.create.push(user);
          }
          
          const project = generateEntity('project', existingIds) as Project;
          project.id = uuidv4();
          project.ownerId = existingIds.user[0];
          existingIds.project.push(project.id);
          
          if (!generatedChanges.project) {
            generatedChanges.project = { create: [], update: [], delete: [] };
          }
          generatedChanges.project.create.push(project);
        }
        
        const newTasks = Array(createCount).fill(null).map(() => {
          const task = generateEntity(entityType, existingIds) as Task;
          task.id = uuidv4();
          
          // Always link to an existing project and user
          const projectIndex = Math.floor(Math.random() * existingIds.project.length);
          task.projectId = existingIds.project[projectIndex];
          
          const userIndex = Math.floor(Math.random() * existingIds.user.length);
          task.assigneeId = existingIds.user[userIndex];
          
          existingIds[entityType].push(task.id);
          return task;
        });
        
        generatedChanges[entityType].create = newTasks;
      }
      // For comments, ensure they reference existing tasks/projects
      else if (entityType === 'comment') {
        // Make sure we have at least one task and one user
        if (existingIds.task.length === 0) {
          // We need a project for the task
          if (existingIds.project.length === 0) {
            // And we need a user for the project
            if (existingIds.user.length === 0) {
              const user = generateEntity('user', existingIds);
              user.id = uuidv4();
              existingIds.user.push(user.id);
              
              if (!generatedChanges.user) {
                generatedChanges.user = { create: [], update: [], delete: [] };
              }
              generatedChanges.user.create.push(user);
            }
            
            const project = generateEntity('project', existingIds) as Project;
            project.id = uuidv4();
            project.ownerId = existingIds.user[0];
            existingIds.project.push(project.id);
            
            if (!generatedChanges.project) {
              generatedChanges.project = { create: [], update: [], delete: [] };
            }
            generatedChanges.project.create.push(project);
          }
          
          const task = generateEntity('task', existingIds) as Task;
          task.id = uuidv4();
          task.projectId = existingIds.project[0];
          task.assigneeId = existingIds.user[0];
          existingIds[entityType].push(task.id);
          
          if (!generatedChanges.task) {
            generatedChanges.task = { create: [], update: [], delete: [] };
          }
          generatedChanges.task.create.push(task);
        }
        
        const newComments = Array(createCount).fill(null).map(() => {
          const comment = generateEntity(entityType, existingIds) as Comment;
          comment.id = uuidv4();
          
          // Decide whether to link to a task or project
          const commentOnTask = Math.random() > 0.5 || existingIds.project.length === 0;
          
          if (commentOnTask && existingIds.task.length > 0) {
            const taskIndex = Math.floor(Math.random() * existingIds.task.length);
            comment.entityId = existingIds.task[taskIndex];
            comment.entityType = 'task';
          } else if (existingIds.project.length > 0) {
            const projectIndex = Math.floor(Math.random() * existingIds.project.length);
            comment.entityId = existingIds.project[projectIndex];
            comment.entityType = 'project';
          } else {
            // Fallback
            comment.entityId = existingIds.task[0];
            comment.entityType = 'task';
          }
          
          // Always link to an existing user as author
          const userIndex = Math.floor(Math.random() * existingIds.user.length);
          comment.authorId = existingIds.user[userIndex];
          
          // Occasionally link to another comment as parent
          if (existingIds.comment.length > 0 && Math.random() > 0.75) {
            const parentIndex = Math.floor(Math.random() * existingIds.comment.length);
            comment.parentId = existingIds.comment[parentIndex];
          } else {
            comment.parentId = undefined;
          }
          
          existingIds[entityType].push(comment.id);
          return comment;
        });
        
        generatedChanges[entityType].create = newComments;
      }
    }
    
    // Generate updates - if we have existing IDs
    if (updateCount > 0 && existingIds[entityType].length > 0) {
      // Only try to update a subset of the available IDs
      const updateCount = Math.min(typeCount - createCount - deleteCount, existingIds[entityType].length);
      
      if (updateCount > 0) {
        const updatedEntities = existingIds[entityType]
          .slice(0, updateCount)
          .map(id => {
            const entity = generateEntity(entityType, existingIds);
            entity.id = id;
            entity.updatedAt = new Date();
            
            // Add type-specific updates with minimal changes
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
      }
    }
    
    // Generate deletes - use a subset of the IDs we're tracking
    if (deleteCount > 0 && existingIds[entityType].length > deleteCount) {
      // Don't delete all our entities - keep at least a few
      const safeDeleteCount = Math.min(deleteCount, Math.max(0, existingIds[entityType].length - 2));
      
      if (safeDeleteCount > 0) {
        // Take IDs from the end to avoid conflicts with updates
        const deleteIds = [...existingIds[entityType]].splice(-safeDeleteCount);
        generatedChanges[entityType].delete = deleteIds;
        
        // Remove these IDs from the tracked IDs
        existingIds[entityType] = existingIds[entityType].filter(
          id => !deleteIds.includes(id)
        );
      }
    }
  }

  // Generate duplicate updates if enabled, but WITHIN the original count
  if (isDuplicationEnabled) {
    logger.info('Generating duplicate updates for deduplication testing');
    
    // Track duplicates we'll create
    let duplicatesCreated = 0;
    const duplicatesNeeded = count - Object.values(exactCount).reduce((sum, count) => sum + count, 0);
    
    for (const entityType of ORDERED_ENTITY_TYPES) {
      // Skip if no updates for this type
      if (!generatedChanges[entityType]?.update?.length) continue;
      
      // Calculate how many entities will have duplicates
      const updates = generatedChanges[entityType].update;
      const entitiesToDuplicate = Math.max(1, Math.floor(updates.length * duplicationPercentage));
      
      // Select random entities to duplicate
      const entityIndices: number[] = [];
      for (let i = 0; i < entitiesToDuplicate && duplicatesCreated < duplicatesNeeded; i++) {
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
        for (let i = 0; i < duplicateCount - 1 && duplicatesCreated < duplicatesNeeded; i++) {
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
          duplicatesCreated++;
        }
      }
      
      logger.info(`Added ${duplicatesCreated} duplicate updates within the original count of ${count}`);
    }
  }
  
  // If we're protecting users from deletion in small batches
  if (avoidUserDeletes && generatedChanges.user) {
    const userOps = generatedChanges.user;
    if (userOps.delete.length > 0) {
      // Get the count of user deletes
      const deleteCount = userOps.delete.length;
      
      // Save the delete IDs before clearing
      const deletedIds = [...userOps.delete];
      
      // Clear the delete array
      userOps.delete = [];
      
      logger.info(`Avoided ${deleteCount} user deletes in small batch (threshold: ${userDeleteThreshold})`);
      
      // Convert deletes to creates to maintain the count
      if (deleteCount > 0) {
        const additionalCreate = deleteCount;
        const newEntities = generateEntities('user', additionalCreate, existingIds);
        
        // Add to creates
        newEntities.forEach((entity: User) => {
          if (!entity.id) {
            entity.id = uuidv4();
          }
          
          // Track ID
          existingIds.user.push(entity.id);
          userOps.create.push(entity);
        });
        
        logger.info(`Converted ${deleteCount} user deletes to creates to maintain exact count`);
      }
    }
  }
  
  logger.info('Finished generating changes');
  return generatedChanges;
}

/**
 * Helper function to get a fixed distribution for small change counts
 */
function getFixedDistribution(count: number): Record<EntityType, number> {
  // For very small counts, optimize for minimal entity creation
  if (count <= 10) {
    // Create one user and one project, use the rest for tasks and comments
    const remainingCount = count - 2;
    const tasks = Math.floor(remainingCount / 2);
    const comments = remainingCount - tasks;
    
    return {
      user: 1,
      project: 1,
      task: tasks,
      comment: comments
    };
  }
  
  // For medium counts, use a slightly more balanced distribution
  if (count <= 20) {
    const users = Math.max(1, Math.floor(count * 0.15));
    const projects = Math.max(1, Math.floor(count * 0.15));
    const tasks = Math.max(1, Math.floor(count * 0.3));
    const comments = count - users - projects - tasks;
    
    return {
      user: users,
      project: projects,
      task: tasks,
      comment: comments
    };
  }
  
  // For larger counts (21-100), use a balanced distribution
  if (count <= 100) {
    const users = Math.max(2, Math.floor(count * 0.15));
    const projects = Math.max(2, Math.floor(count * 0.15));
    const tasks = Math.max(3, Math.floor(count * 0.2));
    const comments = count - users - projects - tasks;
    
    return {
      user: users,
      project: projects,
      task: tasks,
      comment: comments
    };
  }
  
  // For very large counts (>100), use a more optimized distribution
  // with fewer parent entities relative to the total
  const users = Math.max(5, Math.floor(count * 0.1));
  const projects = Math.max(5, Math.floor(count * 0.1));
  const tasks = Math.max(10, Math.floor(count * 0.15));
  const comments = count - users - projects - tasks;
  
  return {
    user: users,
    project: projects,
    task: tasks,
    comment: comments
  };
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