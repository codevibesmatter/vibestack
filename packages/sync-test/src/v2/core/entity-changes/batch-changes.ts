/**
 * Batch Changes
 * 
 * Provides higher-level functions for generating and applying batches of mixed changes
 * for testing and seeding purposes.
 */

import { v4 as uuidv4 } from 'uuid';
import { faker } from '@faker-js/faker';
import { TableChange } from '@repo/sync-types';
import { TaskStatus } from '@repo/dataforge/server-entities';

import { createLogger } from '../logger.ts';

// Direct imports to avoid circular dependencies
import { EntityType, DEPENDENCY_ORDER, TABLE_TO_ENTITY } from './entity-adapter.ts';
import { fetchExistingIds } from './change-applier.ts';
import { applyChanges } from './change-applier.ts';

// Import entity factories
import {
  createUser,
  createProject,
  createTask,
  createComment,
  createEntities
} from './entity-factories.ts';

// Import change builders
import {
  entityToChange,
  generateChanges as generateRawChanges
} from './change-builder.ts';

// Initialize logger
const logger = createLogger('EntityChanges:BatchChanges');

/**
 * Options for mixed change generation
 */
export interface MixedChangesOptions {
  // Special modes
  mode?: 'seed' | 'mixed'; // seed mode is insert-only, mixed has a mix of operations
  
  // Fixed batch size (default is 20)
  batchSize?: number;
  
  // Advanced options (optional)
  distribution?: {
    user?: number;    // Percentage of user operations (0.0-1.0)
    project?: number; // Percentage of project operations (0.0-1.0)
    task?: number;    // Percentage of task operations (0.0-1.0)
    comment?: number; // Percentage of comment operations (0.0-1.0)
  };
  
  // Use existing IDs from database for updates and deletes
  useExistingIds?: boolean;
  
  // Custom seed for the random generator
  seed?: number;
}

/**
 * Result of generating mixed changes, including information about duplicates
 */
export interface MixedChangesResult {
  changes: TableChange[];
  duplicates: {
    original: TableChange;
    duplicate: TableChange;
  }[];
}

// Constants
const DEFAULT_BATCH_SIZE = 20; // Default batch size (fixed at 20)
const MAX_CASCADE_OVERAGE_PERCENT = 10; // Maximum percentage overage allowed for cascading deletes

/**
 * Generate a batch of mixed entity changes
 * 
 * @param count Total number of changes to generate (defaults to 20)
 * @param mode 'seed' for insert-only or 'mixed' for all operations
 * @returns Array of TableChange objects ready to be applied
 */
export async function generateMixedChanges(
  count: number = DEFAULT_BATCH_SIZE,
  mode: 'seed' | 'mixed' = 'mixed'
): Promise<MixedChangesResult> {
  // Enforce batch size of 20 for mixed mode
  // Note: This enforces exactly 20 changes for standard batch processing,
  // but generateAndApplyMixedChanges can override this behavior for remainder batches
  if (mode === 'mixed') {
    // Enforce DEFAULT_BATCH_SIZE unless explicitly told to use a smaller count via options
    if (count > DEFAULT_BATCH_SIZE || !count) {
      count = DEFAULT_BATCH_SIZE;
    }
    // For smaller counts, we'll still use mixed mode but with reduced counts
  }
  
  logger.info(`Generating batch of ${count} ${mode} changes`);
  
  // Default operations based on mode
  const operations = mode === 'seed' 
    ? { create: 1.0, update: 0 }
    : { create: 0.7, update: 0.3 }; // In mixed mode, handle delete separately
  
  // Default entity distribution
  const distribution = {
    user: 0.1,     // 10% users
    project: 0.2,  // 20% projects
    task: 0.3,     // 30% tasks
    comment: 0.4   // 40% comments
  };
  
  // Calculate exact counts per entity type
  const entityCounts: Record<EntityType, number> = {
    user: Math.round(count * distribution.user),
    project: Math.round(count * distribution.project),
    task: Math.round(count * distribution.task),
    comment: Math.round(count * distribution.comment)
  };
  
  // Fix rounding errors to ensure exact count
  const totalCalcCount = Object.values(entityCounts).reduce((sum, val) => sum + val, 0);
  if (totalCalcCount !== count) {
    // Adjust comments (usually most abundant) to match total
    entityCounts.comment += (count - totalCalcCount);
  }
  
  logger.info(
    `Entity distribution: user=${entityCounts.user}, ` +
    `project=${entityCounts.project}, ` +
    `task=${entityCounts.task}, ` +
    `comment=${entityCounts.comment}`
  );
  
  // For mixed mode, handle the delete operation specially
  let exactlyOneDelete: TableChange | null = null;
  let deleteEntityType: EntityType | null = null;
  let cascadeDependencies: TableChange[] = [];
  
  if (mode === 'mixed') {
    // Reserve 1 operation for delete
    const remainingCount = count - 1;
    
    // Recalculate entity counts without delete
    entityCounts.user = Math.round(remainingCount * distribution.user);
    entityCounts.project = Math.round(remainingCount * distribution.project);
    entityCounts.task = Math.round(remainingCount * distribution.task);
    entityCounts.comment = Math.round(remainingCount * distribution.comment);
    
    // Fix rounding errors again
    const totalCalcCount = Object.values(entityCounts).reduce((sum, val) => sum + val, 0);
    if (totalCalcCount !== remainingCount) {
      entityCounts.comment += (remainingCount - totalCalcCount);
    }
    
    logger.info(`Adjusted distribution for exactly one delete operation`);
  }
  
  // Fetch existing IDs for updates and deletes
  let existingIds: Record<EntityType, string[]> = {
    user: [],
    project: [],
    task: [],
    comment: []
  };
  
  if (mode === 'mixed') {
    logger.info('Fetching existing entity IDs for updates and deletes');
    // For mixed mode, request a good number of existing IDs
    const fetchLimit = 100;
    existingIds = await fetchExistingIds(undefined, fetchLimit);
    
    // Log how many existing IDs we found for each entity type
    Object.entries(existingIds).forEach(([type, ids]) => {
      logger.info(`Found ${ids.length} existing ${type} entities for updates/deletes`);
    });
    
    // For mixed mode, choose one entity to delete from the lower hierarchy levels (task or comment)
    // This ensures maximum of one level of dependencies
    const lowLevelEntities: EntityType[] = ['task', 'comment'];
    const availableTypes = lowLevelEntities.filter(type => existingIds[type].length > 0);
    
    if (availableTypes.length > 0) {
      // Randomly select one of the available low-level types
      deleteEntityType = availableTypes[Math.floor(Math.random() * availableTypes.length)];
      
      // Get a random ID from the selected type
      const randomIndex = Math.floor(Math.random() * existingIds[deleteEntityType].length);
      const entityToDeleteId = existingIds[deleteEntityType][randomIndex];
      
      logger.info(`Selected ${deleteEntityType} with ID ${entityToDeleteId} for deletion`);
      
      // Create the delete change
      exactlyOneDelete = entityToChange({
        id: entityToDeleteId,
        __entityType: deleteEntityType
      }, 'delete');
      
      // Analyze cascading dependencies
      try {
        const { cascadeDelete } = await import('./change-applier.ts');
        
        // Get cascade dependencies in dry-run mode
        const cascadeChanges = await cascadeDelete(deleteEntityType, entityToDeleteId, { dryRun: true });
        
        // Filter out the original entity (we already have it)
        cascadeDependencies = cascadeChanges.filter(change => 
          change.data?.id !== entityToDeleteId);
        
        if (cascadeDependencies.length > 0) {
          logger.info(`Found ${cascadeDependencies.length} cascade dependencies for ${deleteEntityType} ${entityToDeleteId}`);
          
          // Sort by dependency order in reverse (delete children before parents)
          // We're using table names for sorting
          const dependencyOrderReverse = ['comments', 'tasks', 'projects', 'users'];
          cascadeDependencies.sort((a, b) => {
            return dependencyOrderReverse.indexOf(a.table) - dependencyOrderReverse.indexOf(b.table);
          });
          
          // Log cascade dependency breakdown
          const byTable = cascadeDependencies.reduce((acc, change) => {
            acc[change.table] = (acc[change.table] || 0) + 1;
            return acc;
          }, {} as Record<string, number>);
          
          Object.entries(byTable).forEach(([table, count]) => {
            logger.info(`- ${count} ${table} will be cascade deleted`);
          });
          
          // Check if cascade dependencies would cause more than 10% overage
          const totalChanges = count + cascadeDependencies.length;
          const overagePercent = ((totalChanges - count) / count) * 100;
          
          if (overagePercent > MAX_CASCADE_OVERAGE_PERCENT) {
            logger.info(`Cascade dependencies would cause ${overagePercent.toFixed(1)}% overage, reducing other changes`);
            
            // Calculate how many changes to keep to stay within 10% overage
            const maxTotalChanges = Math.floor(count * (1 + MAX_CASCADE_OVERAGE_PERCENT / 100));
            const changesToKeep = maxTotalChanges - cascadeDependencies.length - 1; // -1 for the delete itself
            
            // Recalculate entity counts to fit within the new limit
            const newTotal = changesToKeep;
            entityCounts.user = Math.round(newTotal * distribution.user);
            entityCounts.project = Math.round(newTotal * distribution.project);
            entityCounts.task = Math.round(newTotal * distribution.task);
            entityCounts.comment = Math.round(newTotal * distribution.comment);
            
            // Fix rounding errors
            const totalCalcCount = Object.values(entityCounts).reduce((sum, val) => sum + val, 0);
            if (totalCalcCount !== newTotal) {
              entityCounts.comment += (newTotal - totalCalcCount);
            }
            
            logger.info(`Adjusted counts to fit within ${MAX_CASCADE_OVERAGE_PERCENT}% overage limit`);
          }
        }
      } catch (error) {
        logger.warn(`Failed to analyze cascade dependencies: ${error}`);
        // Continue without cascade dependencies
      }
    } else {
      logger.warn(`No low-level entities (task or comment) found for deletion, skipping delete operation`);
    }
  }
  
  // Generate changes
  const tableChanges: TableChange[] = [];
  
  // Keep track of created entities for establishing relationships
  let createdUsers: any[] = [];
  let createdProjects: any[] = [];
  let createdTasks: any[] = [];
  
  // STEP 1: CREATE USERS
  const userCount = entityCounts.user;
  if (userCount > 0) {
    const createUserCount = Math.round(userCount * operations.create);
    const updateUserCount = userCount - createUserCount;
    
    logger.info(`user: ${createUserCount} creates, ${updateUserCount} updates`);
    
    // Create users
    if (createUserCount > 0) {
      const users = await createEntities('user', createUserCount);
      createdUsers = users;
      for (const user of users) {
        tableChanges.push(entityToChange(user, 'insert'));
      }
    }
    
    // Update users
    if (updateUserCount > 0 && existingIds.user.length > 0) {
      // Take a subset of existing users to update
      const idsToUpdate = existingIds.user.slice(0, Math.min(updateUserCount, existingIds.user.length));
      logger.info(`Updating ${idsToUpdate.length} existing users`);
      
      for (const id of idsToUpdate) {
        const updatedUser = {
          id,
          name: `Updated User ${generateRandomString(8)}`,
          email: `updated-${generateRandomString(6)}@example.com`,
          updatedAt: new Date(),
          __entityType: 'user'
        };
        tableChanges.push(entityToChange(updatedUser, 'update'));
      }
    } else if (updateUserCount > 0) {
      logger.warn(`Cannot update users: no existing users found`);
    }
  }
  
  // STEP 2: CREATE PROJECTS
  const projectCount = entityCounts.project;
  if (projectCount > 0) {
    const createProjectCount = Math.round(projectCount * operations.create);
    const updateProjectCount = projectCount - createProjectCount;
    
    logger.info(`project: ${createProjectCount} creates, ${updateProjectCount} updates`);
    
    // Create projects
    if (createProjectCount > 0) {
      const projects = [];
      
      // Try to use created users first
      if (createdUsers.length > 0) {
        for (let i = 0; i < createProjectCount; i++) {
          const randomUserIndex = Math.floor(Math.random() * createdUsers.length);
          const owner = createdUsers[randomUserIndex];
          projects.push(await createProject({ owner }, {}));
        }
      } 
      // Then try existing user IDs
      else if (existingIds.user.length > 0) {
        for (let i = 0; i < createProjectCount; i++) {
          const randomUserIndex = Math.floor(Math.random() * existingIds.user.length);
          const userId = existingIds.user[randomUserIndex];
          projects.push(await createProject({}, { ownerId: userId }));
        }
      }
      // If no users available, log warning and skip
      else {
        logger.warn('No users available for project creation. Using random IDs (may cause FK constraint issues).');
        projects.push(...await createEntities('project', createProjectCount));
      }
      
      // Save created projects and add to changes
      createdProjects = projects;
      for (const project of projects) {
        tableChanges.push(entityToChange(project, 'insert'));
      }
    }
    
    // Update projects
    if (updateProjectCount > 0 && existingIds.project.length > 0) {
      // Take a subset of existing projects to update
      const idsToUpdate = existingIds.project.slice(0, Math.min(updateProjectCount, existingIds.project.length));
      logger.info(`Updating ${idsToUpdate.length} existing projects`);
      
      for (const id of idsToUpdate) {
        const updatedProject = {
          id,
          name: `Updated Project ${generateRandomString(8)}`,
          description: `Updated description ${generateRandomString(15)}`,
          updatedAt: new Date(),
          __entityType: 'project'
        };
        tableChanges.push(entityToChange(updatedProject, 'update'));
      }
    } else if (updateProjectCount > 0) {
      logger.warn(`Cannot update projects: no existing projects found`);
    }
  }
  
  // STEP 3: CREATE TASKS
  const taskCount = entityCounts.task;
  if (taskCount > 0) {
    const createTaskCount = Math.round(taskCount * operations.create);
    const updateTaskCount = taskCount - createTaskCount;
    
    logger.info(`task: ${createTaskCount} creates, ${updateTaskCount} updates`);
    
    // Create tasks
    if (createTaskCount > 0) {
      const tasks = [];
      
      // Try to use created projects and users
      if (createdProjects.length > 0 && (createdUsers.length > 0 || existingIds.user.length > 0)) {
        for (let i = 0; i < createTaskCount; i++) {
          // Get random project
          const randomProjectIndex = Math.floor(Math.random() * createdProjects.length);
          const project = createdProjects[randomProjectIndex];
          
          // Get random assignee (preferring newly created users)
          let assignee = null;
          if (createdUsers.length > 0) {
            const randomUserIndex = Math.floor(Math.random() * createdUsers.length);
            assignee = createdUsers[randomUserIndex];
          } else if (existingIds.user.length > 0) {
            const randomUserIndex = Math.floor(Math.random() * existingIds.user.length);
            const userId = existingIds.user[randomUserIndex];
            assignee = { id: userId };
          }
          
          tasks.push(await createTask({ project, assignee }, {}));
        }
      }
      // If missing projects or users, try with existing IDs
      else if (existingIds.project.length > 0) {
        for (let i = 0; i < createTaskCount; i++) {
          const randomProjectIndex = Math.floor(Math.random() * existingIds.project.length);
          const projectId = existingIds.project[randomProjectIndex];
          
          let assigneeId = null;
          if (existingIds.user.length > 0) {
            const randomUserIndex = Math.floor(Math.random() * existingIds.user.length);
            assigneeId = existingIds.user[randomUserIndex];
          }
          
          tasks.push(await createTask({}, { 
            projectId, 
            assigneeId: assigneeId || undefined 
          }));
        }
      }
      // If no relationships available, log warning and skip
      else {
        logger.warn('No projects/users available for task creation. Using random IDs (may cause FK constraint issues).');
        tasks.push(...await createEntities('task', createTaskCount));
      }
      
      // Save created tasks and add to changes
      createdTasks = tasks;
      for (const task of tasks) {
        tableChanges.push(entityToChange(task, 'insert'));
      }
    }
    
    // Update tasks
    if (updateTaskCount > 0 && existingIds.task.length > 0) {
      // Take a subset of existing tasks to update
      const idsToUpdate = existingIds.task.slice(0, Math.min(updateTaskCount, existingIds.task.length));
      logger.info(`Updating ${idsToUpdate.length} existing tasks`);
      
      for (const id of idsToUpdate) {
        const updatedTask = {
          id,
          title: `Updated Task ${generateRandomString(8)}`,
          description: `Updated task description ${generateRandomString(15)}`,
          status: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.COMPLETED][Math.floor(Math.random() * 3)],
          updatedAt: new Date(),
          __entityType: 'task'
        };
        tableChanges.push(entityToChange(updatedTask, 'update'));
      }
    } else if (updateTaskCount > 0) {
      logger.warn(`Cannot update tasks: no existing tasks found`);
    }
  }
  
  // STEP 4: CREATE COMMENTS
  const commentCount = entityCounts.comment;
  if (commentCount > 0) {
    const createCommentCount = Math.round(commentCount * operations.create);
    const updateCommentCount = commentCount - createCommentCount;
    
    logger.info(`comment: ${createCommentCount} creates, ${updateCommentCount} updates`);
    
    // Create comments
    if (createCommentCount > 0) {
      const comments = [];
      
      // Try to use created users and entities (tasks/projects)
      if ((createdUsers.length > 0 || existingIds.user.length > 0) && 
          (createdTasks.length > 0 || createdProjects.length > 0 || 
           existingIds.task.length > 0 || existingIds.project.length > 0)) {
        
        for (let i = 0; i < createCommentCount; i++) {
          // Get author (preferring newly created users)
          let author = null;
          if (createdUsers.length > 0) {
            const randomUserIndex = Math.floor(Math.random() * createdUsers.length);
            author = createdUsers[randomUserIndex];
          } else if (existingIds.user.length > 0) {
            const randomUserIndex = Math.floor(Math.random() * existingIds.user.length);
            const userId = existingIds.user[randomUserIndex];
            author = { id: userId };
          }
          
          // Get entity to comment on (preferring newly created entities)
          let entity = null;
          const useTask = Math.random() > 0.5; // 50/50 choice between tasks and projects
          
          if (useTask && createdTasks.length > 0) {
            const randomTaskIndex = Math.floor(Math.random() * createdTasks.length);
            entity = createdTasks[randomTaskIndex];
          } else if (!useTask && createdProjects.length > 0) {
            const randomProjectIndex = Math.floor(Math.random() * createdProjects.length);
            entity = createdProjects[randomProjectIndex];
          } else if (useTask && existingIds.task.length > 0) {
            const randomTaskIndex = Math.floor(Math.random() * existingIds.task.length);
            const taskId = existingIds.task[randomTaskIndex];
            entity = { id: taskId, __entityType: 'task' };
          } else if (!useTask && existingIds.project.length > 0) {
            const randomProjectIndex = Math.floor(Math.random() * existingIds.project.length);
            const projectId = existingIds.project[randomProjectIndex];
            entity = { id: projectId, __entityType: 'project' };
          }
          
          if (author && entity) {
            comments.push(await createComment({ author, entity }, {}));
          }
        }
      }
      // If no relationships available, log warning and skip
      else {
        logger.warn('No authors/entities available for comment creation. Using random IDs (may cause FK constraint issues).');
        comments.push(...await createEntities('comment', createCommentCount));
      }
      
      // Add comments to changes
      for (const comment of comments) {
        tableChanges.push(entityToChange(comment, 'insert'));
      }
    }
    
    // Update comments
    if (updateCommentCount > 0 && existingIds.comment.length > 0) {
      // Take a subset of existing comments to update
      const idsToUpdate = existingIds.comment.slice(0, Math.min(updateCommentCount, existingIds.comment.length));
      logger.info(`Updating ${idsToUpdate.length} existing comments`);
      
      for (const id of idsToUpdate) {
        const updatedComment = {
          id,
          content: `Updated comment content ${generateRandomString(20)}`,
          updatedAt: new Date(),
          __entityType: 'comment'
        };
        tableChanges.push(entityToChange(updatedComment, 'update'));
      }
    } else if (updateCommentCount > 0) {
      logger.warn(`Cannot update comments: no existing comments found`);
    }
  }
  
  // Add the delete operation and its cascade dependencies if we're in mixed mode
  if (mode === 'mixed' && exactlyOneDelete) {
    // Add cascading dependencies first (in reverse order)
    tableChanges.push(...cascadeDependencies);
    // Then add the main delete
    tableChanges.push(exactlyOneDelete);
  }
  
  // Add a duplicate operation to test deduplication features (for mixed mode only)
  const duplicates: { original: TableChange; duplicate: TableChange }[] = [];
  
  if (mode === 'mixed' && tableChanges.length > 0) {
    // Select a random change to duplicate, preferring an insert operation so we can make an update for it
    let randomIndex;
    let changeToDuplicate;
    const insertChanges = tableChanges.filter(change => change.operation === 'insert');
    
    if (insertChanges.length > 0) {
      // Prefer an insert we can convert to an update
      randomIndex = Math.floor(Math.random() * insertChanges.length);
      changeToDuplicate = insertChanges[randomIndex];
    } else {
      // Fall back to any change
      randomIndex = Math.floor(Math.random() * tableChanges.length);
      changeToDuplicate = tableChanges[randomIndex];
    }
    
    // Create a variation of the change that tests deduplication but won't violate DB constraints
    const duplicateChange = JSON.parse(JSON.stringify(changeToDuplicate));
    
    // If it was an insert, convert to an update with the same ID
    if (duplicateChange.operation === 'insert') {
      duplicateChange.operation = 'update';
      
      // Add a small modification to a field to test update deduplication
      if (duplicateChange.data) {
        // Mark it as a duplicate for debugging
        duplicateChange.data.__isDuplicate = true;
        
        // Fix Date objects that were converted to strings during JSON serialization
        if ('createdAt' in duplicateChange.data && duplicateChange.data.createdAt) {
          duplicateChange.data.createdAt = new Date(duplicateChange.data.createdAt);
        }
        
        if ('updatedAt' in duplicateChange.data && duplicateChange.data.updatedAt) {
          duplicateChange.data.updatedAt = new Date(duplicateChange.data.updatedAt);
        }
        
        // Also handle task-specific dueDate field
        if (duplicateChange.table === 'tasks' && 'dueDate' in duplicateChange.data && duplicateChange.data.dueDate) {
          duplicateChange.data.dueDate = new Date(duplicateChange.data.dueDate);
        }
      }
    } else {
      // For non-insert operations, just add a marker but keep everything else the same
      if (duplicateChange.data) {
        duplicateChange.data.__isDuplicate = true;
        
        // Fix Date objects that were converted to strings during JSON serialization
        if ('createdAt' in duplicateChange.data && duplicateChange.data.createdAt) {
          duplicateChange.data.createdAt = new Date(duplicateChange.data.createdAt);
        }
        
        if ('updatedAt' in duplicateChange.data && duplicateChange.data.updatedAt) {
          duplicateChange.data.updatedAt = new Date(duplicateChange.data.updatedAt);
        }
        
        // Also handle task-specific dueDate field
        if (duplicateChange.table === 'tasks' && 'dueDate' in duplicateChange.data && duplicateChange.data.dueDate) {
          duplicateChange.data.dueDate = new Date(duplicateChange.data.dueDate);
        }
      }
    }
    
    logger.info(`Adding duplicate ${duplicateChange.operation} operation for ${duplicateChange.table} to test deduplication`);
    
    // Add to duplicates tracking
    duplicates.push({
      original: changeToDuplicate,
      duplicate: duplicateChange
    });
    
    // Add the duplicate to the changes
    tableChanges.push(duplicateChange);
  }
  
  // Shuffle the changes to mix operations and entity types
  // Only do this for mixed mode - for seed mode keep it in dependency order
  const result = mode === 'mixed' ? shuffleArray(tableChanges) : tableChanges;
  
  // For mixed mode, ensure exactly batch size (or slightly more with cascading)
  if (mode === 'mixed') {
    const finalCount = result.length;
    const overagePercent = finalCount > count ? ((finalCount - count) / count) * 100 : 0;
    
    logger.info(`Generated ${finalCount} changes (${count} requested, ${overagePercent.toFixed(1)}% overage)`);
    
    // Only trim if we're way over (shouldn't happen with proper cascade analysis)
    if (finalCount > count * 1.2) {
      logger.warn(`Batch size exceeds 20% overage, trimming to ${Math.round(count * 1.1)} changes`);
      return { 
        changes: result.slice(0, Math.round(count * 1.1)),
        duplicates
      };
    }
    
    return { changes: result, duplicates };
  }
  
  // For seed mode, still enforce the requested count exactly
  if (result.length > count) {
    logger.info(`Generated ${result.length} changes, trimming to requested ${count}`);
    return { 
      changes: result.slice(0, count),
      duplicates 
    };
  }
  
  logger.info(`Generated ${result.length} ${mode} changes`);
  return { changes: result, duplicates };
}

/**
 * Generate and apply mixed changes in a single operation
 * 
 * @param count Total number of changes to generate and apply
 * @param mode 'seed' for insert-only or 'mixed' for all operations
 * @returns Object containing applied changes and information about duplicates
 */
export async function generateAndApplyMixedChanges(
  count: number = DEFAULT_BATCH_SIZE,
  mode: 'seed' | 'mixed' = 'mixed'
): Promise<{
  changes: TableChange[];
  duplicates: {
    original: TableChange;
    duplicate: TableChange;
  }[];
}> {
  // For 'mixed' mode, process in batches of maximum 20 changes each
  if (mode === 'mixed') {
    logger.info(`Generating and applying ${count} mixed changes with enhanced dependency handling`);
    
    // Calculate how many full batches we need and any remainder
    const fullBatches = Math.floor(count / DEFAULT_BATCH_SIZE);
    const remainder = count % DEFAULT_BATCH_SIZE;
    
    logger.info(`Processing in ${fullBatches + (remainder > 0 ? 1 : 0)} batches of max ${DEFAULT_BATCH_SIZE} changes each`);
    
    const allAppliedChanges: TableChange[] = [];
    const allDuplicates: { original: TableChange; duplicate: TableChange }[] = [];
    
    // Process full batches first
    for (let i = 0; i < fullBatches; i++) {
      logger.info(`Generating and applying batch ${i + 1}/${fullBatches + (remainder > 0 ? 1 : 0)} (${DEFAULT_BATCH_SIZE} changes)`);
      try {
        // Generate changes for this batch (max 20)
        const result = await generateMixedChanges(DEFAULT_BATCH_SIZE, mode);
        const batchChanges = result.changes;
        
        // Track duplicates from this batch
        allDuplicates.push(...result.duplicates);
        
        // Log breakdown of operations
        const inserts = batchChanges.filter(change => change.operation === 'insert');
        const updates = batchChanges.filter(change => change.operation === 'update');
        const deletes = batchChanges.filter(change => change.operation === 'delete');
        
        logger.info(`Batch breakdown: ${inserts.length} inserts, ${updates.length} updates, ${deletes.length} deletes`);
        
        // Apply all changes in a single batch
        logger.info(`Applying ${batchChanges.length} changes to database for batch ${i + 1}`);
        const appliedChanges = await applyChanges(batchChanges);
        
        logger.info(`Successfully applied ${appliedChanges.length} changes for batch ${i + 1}`);
        allAppliedChanges.push(...appliedChanges);
      } catch (error) {
        // Log the error and rethrow instead of falling back to seed mode
        logger.error(`Error applying changes for batch ${i + 1}: ${error}`);
        throw error; // This will cause the test to fail
      }
    }
    
    // Process any remaining changes
    if (remainder > 0) {
      logger.info(`Generating and applying final batch ${fullBatches + 1}/${fullBatches + 1} (${remainder} changes)`);
      try {
        // Generate changes for the remainder batch, respecting the remainder count
        // while maintaining the mixed mode characteristics
        const result = await generateMixedChanges(remainder, mode);
        const batchChanges = result.changes;
        
        // Track duplicates from this batch
        allDuplicates.push(...result.duplicates);
        
        // Log breakdown of operations
        const inserts = batchChanges.filter(change => change.operation === 'insert');
        const updates = batchChanges.filter(change => change.operation === 'update');
        const deletes = batchChanges.filter(change => change.operation === 'delete');
        
        logger.info(`Batch breakdown: ${inserts.length} inserts, ${updates.length} updates, ${deletes.length} deletes`);
        
        // Apply all changes in a single batch
        logger.info(`Applying ${batchChanges.length} changes to database for final batch`);
        const appliedChanges = await applyChanges(batchChanges);
        
        logger.info(`Successfully applied ${appliedChanges.length} changes for final batch`);
        allAppliedChanges.push(...appliedChanges);
      } catch (error) {
        // Log the error and rethrow instead of falling back to seed mode
        logger.error(`Error applying changes for final batch: ${error}`);
        throw error; // This will cause the test to fail
      }
    }
    
    logger.info(`Completed applying all ${allAppliedChanges.length} changes across ${fullBatches + (remainder > 0 ? 1 : 0)} batches`);
    return { 
      changes: allAppliedChanges,
      duplicates: allDuplicates
    };
  }
  
  // For seed mode, just generate and apply all at once
  logger.info(`Generating and applying ${count} insert-only changes`);
  
  try {
    // Generate changes (for mixed mode with exactly one delete, the function handles cascade dependencies)
    const result = await generateMixedChanges(count, mode);
    const changes = result.changes;
    
    // Log breakdown of operations
    const inserts = changes.filter(change => change.operation === 'insert');
    const updates = changes.filter(change => change.operation === 'update');
    const deletes = changes.filter(change => change.operation === 'delete');
    
    logger.info(`Batch breakdown: ${inserts.length} inserts, ${updates.length} updates, ${deletes.length} deletes`);
    
    // Apply all changes in a single batch
    logger.info(`Applying ${changes.length} changes to database`);
    const appliedChanges = await applyChanges(changes);
    
    logger.info(`Successfully applied ${appliedChanges.length} changes`);
    return { 
      changes: appliedChanges,
      duplicates: result.duplicates
    };
  } catch (error) {
    // Log the error and rethrow instead of falling back to seed mode
    logger.error(`Error applying ${mode} changes: ${error}`);
    throw error; // This will cause the test to fail
  }
}

// --- Helper Functions ---

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

function generateRandomString(length: number): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    result += characters.charAt(randomIndex);
  }
  return result;
} 