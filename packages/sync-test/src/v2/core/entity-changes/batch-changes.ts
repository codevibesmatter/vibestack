/**
 * Batch Changes V2
 * 
 * Provides higher-level functions for generating and applying batches of mixed changes
 * for testing and seeding purposes.
 */

import { v4 as uuidv4 } from 'uuid';
import { faker } from '@faker-js/faker';
import { TaskStatus } from '@repo/dataforge/server-entities';

import { createLogger } from '../logger.ts';
import { EntityType, DEPENDENCY_ORDER, TABLE_TO_ENTITY } from './entity-adapter.ts';
import { fetchExistingIds, applyChanges, getDataSource } from './change-applier.ts';
import { TableChangeTest, MixedChangesOptions, MixedChangesResult } from './types.ts';
import {
  createUser,
  createProject,
  createTask,
  createComment
} from './entity-factories.ts';
import { entityToChange } from './change-builder.ts';

// Initialize logger
const logger = createLogger('entity-changes.batch');

// Constants
const DEFAULT_BATCH_SIZE = 20;

/**
 * Ensure all date fields in a TableChange are properly converted to Date objects
 */
function ensureChangeDateObjects(change: TableChangeTest): TableChangeTest {
  if (!change.data) return change;
  
  // Common date fields for all entity types
  if (change.data.createdAt && typeof change.data.createdAt === 'string') {
    change.data.createdAt = new Date(change.data.createdAt);
  }
  
  if (change.data.updatedAt && typeof change.data.updatedAt === 'string') {
    change.data.updatedAt = new Date(change.data.updatedAt);
  }
  
  // Entity-specific date fields
  if (change.table === 'tasks') {
    if (change.data.dueDate && typeof change.data.dueDate === 'string') {
      change.data.dueDate = new Date(change.data.dueDate);
    }
    
    if (change.data.completedAt && typeof change.data.completedAt === 'string') {
      change.data.completedAt = new Date(change.data.completedAt);
    }
  }
  
  return change;
}

/**
 * Generate a batch of mixed entity changes with proper relationships
 */
export async function generateMixedChanges(options: MixedChangesOptions = {}): Promise<MixedChangesResult> {
  // Basic setup
  const mode = options.mode || 'mixed';
  const requestedCount = options.batchSize || DEFAULT_BATCH_SIZE;
  const batchId = options.batchId || `batch-${Date.now()}-${uuidv4().substring(0, 8)}`;
  
  // Entity summary to track created/updated/deleted entities
  const entitySummary = {
    created: {
      user: [] as string[],
      project: [] as string[],
      task: [] as string[],
      comment: [] as string[]
    },
    updated: {
      user: [] as string[],
      project: [] as string[],
      task: [] as string[],
      comment: [] as string[]
    },
    deleted: {
      user: [] as string[],
      project: [] as string[],
      task: [] as string[],
      comment: [] as string[]
    }
  };
  
  // Operation distribution - now including deletes
  const createPercent = mode === 'seed' ? 1.0 : 0.6; 
  const updatePercent = mode === 'seed' ? 0.0 : 0.2;
  const deletePercent = mode === 'seed' ? 0.0 : 0.2; // 20% deletes in mixed mode (increased from 10%)
  
  // Distribution - either use provided or default
  const distribution = {
    user: options.distribution?.user ?? 0.25,
    project: options.distribution?.project ?? 0.25,
    task: options.distribution?.task ?? 0.25,
    comment: options.distribution?.comment ?? 0.25
  };
  
  // Reserve 1 for intentional duplicate if enabled
  const duplicateCount = (mode === 'mixed' && options.includeIntentionalDuplicate !== false) ? 1 : 0;
  
  // Calculate remaining changes after accounting for duplicates
  const remainingCount = requestedCount - duplicateCount;
  
  // Calculate operations distribution
  const insertCount = Math.floor(remainingCount * createPercent);
  const updateCount = Math.floor(remainingCount * updatePercent);
  const deleteCount = remainingCount - insertCount - updateCount;
  
  logger.info(`Entity distribution: inserts(${insertCount}) updates(${updateCount}) deletes(${deleteCount}) duplicates(${duplicateCount}) - total: ${requestedCount}`);
  
  // For deletes, we only support task and comment deletions to avoid cascading issues with users and projects
  // Since we need to get existing IDs for both updates and deletes, let's do it once
  let existingIds: Record<EntityType, string[]> = {
    user: [], project: [], task: [], comment: []
  };
  
  // Maps to store task->comment relationships for cascade deletions
  const taskCommentMap: Record<string, string[]> = {};
  
  // Only fetch existing IDs if we need updates or deletes
  if (mode === 'mixed' && (updateCount > 0 || deleteCount > 0)) {
    existingIds = await fetchExistingIds();
    logger.info(`Found existing entities: user(${existingIds.user.length}) project(${existingIds.project.length}) task(${existingIds.task.length}) comment(${existingIds.comment.length})`);
    
    // Filter out excluded IDs
    if (options.excludeFromUpdates) {
      for (const entityType of DEPENDENCY_ORDER) {
        if (options.excludeFromUpdates[entityType]?.length) {
          const excludeSet = new Set(options.excludeFromUpdates[entityType]);
          existingIds[entityType] = existingIds[entityType].filter(id => !excludeSet.has(id));
        }
      }
    }
    
    // For cascade deletes, we need to fetch task->comment relationships
    if (deleteCount > 0) {
      try {
        // Get data source
        const dataSource = await getDataSource();
        
        // Get comments with their task IDs - fix column name from entityId to entity_id
        const commentTaskRelationships = await dataSource.query(`
          SELECT id, entity_id 
          FROM comments 
          WHERE entity_type = 'task'
        `);
        
        // Build the task->comments map
        for (const rel of commentTaskRelationships) {
          if (!taskCommentMap[rel.entity_id]) {
            taskCommentMap[rel.entity_id] = [];
          }
          taskCommentMap[rel.entity_id].push(rel.id);
        }
        
        logger.info(`Found ${Object.keys(taskCommentMap).length} tasks with comments for cascade deletion`);
      } catch (error) {
        logger.error(`Error fetching task-comment relationships: ${error}`);
      }
    }
  }
  
  // Calculate entity counts for inserts
  const entityCounts: Record<EntityType, number> = {
    user: Math.round(insertCount * distribution.user),
    project: Math.round(insertCount * distribution.project),
    task: Math.round(insertCount * distribution.task),
    comment: Math.round(insertCount * distribution.comment)
  };
  
  // Fix rounding errors
  const totalInsertCount = Object.values(entityCounts).reduce((sum, val) => sum + val, 0);
  if (totalInsertCount !== insertCount) {
    // Adjust the last entity type to match exactly
    entityCounts.comment += (insertCount - totalInsertCount);
  }
  
  // Calculate entity counts for updates
  const updateEntityCounts: Record<EntityType, number> = {
    user: Math.round(updateCount * distribution.user),
    project: Math.round(updateCount * distribution.project),
    task: Math.round(updateCount * distribution.task),
    comment: Math.round(updateCount * distribution.comment)
  };
  
  // Fix rounding errors for updates
  const totalUpdateCount = Object.values(updateEntityCounts).reduce((sum, val) => sum + val, 0);
  if (totalUpdateCount !== updateCount) {
    updateEntityCounts.comment += (updateCount - totalUpdateCount);
  }
  
  // For deletes, we only delete tasks and comments to avoid cascading issues
  // We'll distribute the delete count between tasks and comments
  const deleteEntityCounts: Record<EntityType, number> = {
    user: 0, // Don't delete users - would cascade to projects, tasks, comments
    project: 0, // Don't delete projects - would cascade to tasks, comments
    task: 0, // As per user request, focus only on comment deletions to avoid cascading
    comment: deleteCount // 100% of deletes will be comments
  };
  
  // Fix rounding errors for deletes
  const totalDeleteCount = Object.values(deleteEntityCounts).reduce((sum, val) => sum + val, 0);
  if (totalDeleteCount !== deleteCount) {
    deleteEntityCounts.comment += (deleteCount - totalDeleteCount);
  }
  
  // Log all distribution information
  logger.info(
    `Entity distribution: ` +
    `inserts(user=${entityCounts.user}, project=${entityCounts.project}, task=${entityCounts.task}, comment=${entityCounts.comment}) ` +
    `updates(user=${updateEntityCounts.user}, project=${updateEntityCounts.project}, task=${updateEntityCounts.task}, comment=${updateEntityCounts.comment}) ` +
    `deletes(comment=${deleteEntityCounts.comment})`
  );

  // Arrays for collecting results
  const tableChanges: TableChangeTest[] = [];
  const insertUpdatePairs: {insertChange: TableChangeTest, updateChange: TableChangeTest}[] = [];
  
  // Track cascade deletes
  const cascadeDeletedCommentIds: string[] = [];
  let cascadeDeleteCount = 0;
  
  // To ensure proper deletion order (avoid foreign key constraint violations),
  // first collect all comments to delete (both standalone and cascaded)
  const commentsToDelete: string[] = [];
  const tasksToDelete: string[] = [];

  // Skip task deletions as we're focusing only on comments per user request
  
  // Now handle standalone comment deletions
  if (deleteEntityCounts.comment > 0 && existingIds.comment.length > 0) {
    // Get available comments
    const availableComments = existingIds.comment;
    
    if (availableComments.length > 0) {
      const commentCount = Math.min(deleteEntityCounts.comment, availableComments.length);
      // Take from the end to avoid conflicts with updates
      commentsToDelete.push(...availableComments.slice(-commentCount));
      
      // Log selected comments for deletion in a consolidated format
      if (commentsToDelete.length > 0) {
        logger.info(`\x1b[33mSelected ${commentsToDelete.length} comments for deletion\x1b[0m`);
      }
    } else {
      logger.warn(`No existing comments found for deletion`);
    }
  }

  // Step 1: Process deletes first to know how many entities we need to reduce from other operations
  if (mode === 'mixed' && commentsToDelete.length > 0) {
    // Delete comments
    for (const commentId of commentsToDelete) {
      const commentDeleteChange = {
        table: 'comments',
        operation: 'delete',
        data: { id: commentId },
        timestamp: new Date(),
        batchId
      } as any;
      
      tableChanges.push(ensureChangeDateObjects(commentDeleteChange as TableChangeTest));
      entitySummary.deleted.comment.push(commentId);
      
      // Remove from existingIds to avoid using for updates
      existingIds.comment = existingIds.comment.filter(id => id !== commentId);
    }
    
    // Log the actual number of deletes in a concise format
    if (commentsToDelete.length > 0) {
      logger.info(`\x1b[33mGenerated delete changes for ${commentsToDelete.length} comments\x1b[0m`);
    }
  }
  
  // Create entities in proper dependency order
  for (const entityType of DEPENDENCY_ORDER) {
    // Skip if no entities of this type needed
    if (entityCounts[entityType] <= 0) continue;
    
    // Handle different entity types with proper relationships
    if (entityType === 'user') {
      // Users don't have dependencies, create directly
      for (let i = 0; i < entityCounts.user; i++) {
        // Create user with batch ID for database tracking
        const userData = {
          name: `User ${i}`,
          email: `user-${Date.now()}-${i}@example.com`
        };
        const user = await createUser(userData);
        
        // Create change record with batch ID
        const change = entityToChange(user, 'insert', { batchId });
        
        // Ensure dates are handled properly
        tableChanges.push(ensureChangeDateObjects(change as TableChangeTest));
        
        // Track created entity
        entitySummary.created.user.push(user.id);
      }
    }
    else if (entityType === 'project') {
      // Projects need user owners
      if (entitySummary.created.user.length === 0 && existingIds.user.length === 0) {
        logger.warn(`Cannot create projects without user owners, skipping ${entityCounts.project} projects`);
        continue;
      }
      
      for (let i = 0; i < entityCounts.project; i++) {
        // Get owner ID from created users if available, otherwise use existing users
        let ownerId;
        if (entitySummary.created.user.length > 0) {
          const ownerIndex = i % entitySummary.created.user.length;
          ownerId = entitySummary.created.user[ownerIndex];
    } else {
          const ownerIndex = i % existingIds.user.length;
          ownerId = existingIds.user[ownerIndex];
        }
        
        // Create project with owner and batch ID
        const projectData = {};
        const project = await createProject(projectData, { ownerId });
        
        // Create change record with batch ID
        const change = entityToChange(project, 'insert', { batchId });
        tableChanges.push(ensureChangeDateObjects(change as TableChangeTest));
        
        // Track created entity
        entitySummary.created.project.push(project.id);
      }
    }
    else if (entityType === 'task') {
      // Tasks need projects and optionally users as assignees
      if (entitySummary.created.project.length === 0 && existingIds.project.length === 0) {
        logger.warn(`Cannot create tasks without projects, skipping ${entityCounts.task} tasks`);
        continue;
      }
      
      for (let i = 0; i < entityCounts.task; i++) {
        // Get project ID from created projects if available, otherwise use existing projects
        let projectId;
        if (entitySummary.created.project.length > 0) {
          const projectIndex = i % entitySummary.created.project.length;
          projectId = entitySummary.created.project[projectIndex];
        } else {
          const projectIndex = i % existingIds.project.length;
          projectId = existingIds.project[projectIndex];
        }
        
        // Optionally assign to user
        let assigneeId;
        if (entitySummary.created.user.length > 0 && Math.random() > 0.3) { // 70% chance to have assignee
          const userIndex = i % entitySummary.created.user.length;
          assigneeId = entitySummary.created.user[userIndex];
        }
        
        // Create task with project, optional assignee, and batch ID
        const taskData = {};
        const task = await createTask(taskData, { projectId, assigneeId });
        
        // Create change record with batch ID
        const change = entityToChange(task, 'insert', { batchId });
        tableChanges.push(ensureChangeDateObjects(change as TableChangeTest));
        
        // Track created entity
        entitySummary.created.task.push(task.id);
      }
    }
    else if (entityType === 'comment') {
      // Comments need users as authors and a task or project to comment on
      const hasAuthors = entitySummary.created.user.length > 0 || existingIds.user.length > 0;
      const hasEntities = (entitySummary.created.task.length > 0 || existingIds.task.length > 0) || 
                         (entitySummary.created.project.length > 0 || existingIds.project.length > 0);
      
      if (!hasAuthors || !hasEntities) {
        logger.warn(`Cannot create comments without users and tasks/projects, skipping ${entityCounts.comment} comments`);
        continue;
      }
      
      for (let i = 0; i < entityCounts.comment; i++) {
        // Get author ID
        let authorId;
        if (entitySummary.created.user.length > 0) {
        const authorIndex = i % entitySummary.created.user.length;
          authorId = entitySummary.created.user[authorIndex];
        } else {
          const authorIndex = i % existingIds.user.length;
          authorId = existingIds.user[authorIndex];
        }
        
        // Determine comment target (task or project)
        const useTask = i % 2 === 0 || entitySummary.created.project.length === 0;
        
        let entityId, entityType;
        if (useTask && (entitySummary.created.task.length > 0 || existingIds.task.length > 0)) {
          if (entitySummary.created.task.length > 0) {
          const taskIndex = Math.floor(i / 2) % entitySummary.created.task.length;
          entityId = entitySummary.created.task[taskIndex];
          } else {
            const taskIndex = Math.floor(i / 2) % existingIds.task.length;
            entityId = existingIds.task[taskIndex];
          }
          entityType = 'task';
        } else if (!useTask && (entitySummary.created.project.length > 0 || existingIds.project.length > 0)) {
          if (entitySummary.created.project.length > 0) {
          const projectIndex = Math.floor(i / 2) % entitySummary.created.project.length;
          entityId = entitySummary.created.project[projectIndex];
          } else {
            const projectIndex = Math.floor(i / 2) % existingIds.project.length;
            entityId = existingIds.project[projectIndex];
          }
          entityType = 'project';
    } else {
          // Skip this comment if we can't find a valid entity to comment on
          logger.warn(`Skipping comment creation due to lack of valid target entity`);
          continue;
        }
        
        // Create comment with author, entity reference, and batch ID
        const commentData = {};
        const comment = await createComment(commentData, { authorId, entityId, entityType });
        
        // Create change record with batch ID
        const change = entityToChange(comment, 'insert', { batchId });
        tableChanges.push(ensureChangeDateObjects(change as TableChangeTest));
        
        // Track created entity
        entitySummary.created.comment.push(comment.id);
      }
    }
  }
  
  // Process updates for each entity type
  for (const entityType of DEPENDENCY_ORDER) {
    const updateCount = updateEntityCounts[entityType];
    if (updateCount <= 0 || existingIds[entityType].length === 0) continue;
    
    // Limit to available IDs
    const actualUpdateCount = Math.min(updateCount, existingIds[entityType].length);
    
    for (let i = 0; i < actualUpdateCount; i++) {
      const id = existingIds[entityType][i];
      
      // Basic update data
      const updateData = {
        id,
        updatedAt: new Date(),
        __entityType: entityType
      };
      
      // Add field updates based on entity type
      switch (entityType) {
        case 'user':
          Object.assign(updateData, { name: `Updated User ${faker.string.uuid().substring(0, 6)}` });
          break;
        case 'project':
          Object.assign(updateData, { name: `Updated Project ${faker.string.uuid().substring(0, 6)}` });
          break;
        case 'task':
          Object.assign(updateData, { 
            title: `Updated Task ${faker.string.uuid().substring(0, 6)}`,
            status: faker.helpers.arrayElement(Object.values(TaskStatus))
          });
          break;
        case 'comment':
          Object.assign(updateData, { content: `Updated comment ${faker.lorem.sentence()}` });
          break;
      }
      
      // Create update change
      const updateChange = entityToChange(updateData, 'update', { batchId });
      tableChanges.push(ensureChangeDateObjects(updateChange as TableChangeTest));
      
      // Track updated entity
      entitySummary.updated[entityType].push(id);
    }
  }
  
  // Add an intentional duplicate for testing (only in mixed mode)
  if (mode === 'mixed' && duplicateCount > 0 && tableChanges.length > 0) {
    const insertChanges = tableChanges.filter(c => c.operation === 'insert');
    
    if (insertChanges.length > 0) {
      const originalChange = insertChanges[0];
      const entityId = originalChange.data?.id;
      const entityType = TABLE_TO_ENTITY[originalChange.table];

      if (entityId && entityType) {
        // Create an UPDATE operation instead of a duplicate INSERT
        const updateData: Record<string, any> = {
          id: entityId,
          updatedAt: new Date(),
          __entityType: entityType, // Keep track of entity type if needed
          __intentionalUpdateOfInsert: true // Mark for tracking
        };

        // Add some updated fields based on entity type, similar to regular updates
        switch (entityType) {
          case 'user':
            Object.assign(updateData, { name: `Updated Inserted User ${faker.string.uuid().substring(0, 4)}` });
            break;
          case 'project':
            Object.assign(updateData, { name: `Updated Inserted Proj ${faker.string.uuid().substring(0, 4)}` });
            break;
          case 'task':
            Object.assign(updateData, { 
              title: `Updated Inserted Task ${faker.string.uuid().substring(0, 4)}`,
              // Change status only if it exists in the original insert data
              status: originalChange.data?.status ? faker.helpers.arrayElement(Object.values(TaskStatus).filter(s => s !== originalChange.data?.status)) : undefined
            });
            break;
          case 'comment':
            Object.assign(updateData, { content: `Updated inserted comment ${faker.lorem.words(3)}` });
            break;
        }

        // Create the update change object
        const updateChange: TableChangeTest = {
          table: originalChange.table,
          operation: 'update',
          data: { ...updateData, timestamp: updateData.updatedAt },
          updated_at: updateData.updatedAt,
          batchId: originalChange.batchId
        };

        // Ensure dates are Date objects
        const finalUpdateChange = ensureChangeDateObjects(updateChange as TableChangeTest);

        tableChanges.push(finalUpdateChange);
        insertUpdatePairs.push({ insertChange: originalChange, updateChange: finalUpdateChange });

        logger.info(`Added intentional UPDATE for insert of ${entityType} ID ${String(entityId).substring(0,8)}...`);
      } else {
        logger.warn('Could not create intentional update: Insert change missing ID or table invalid.');
      }
    } else {
       logger.warn('Could not create intentional update: No insert operations found in batch.');
    }
  }
  
  // Shuffle the changes in mixed mode
  const result = mode === 'mixed' ? shuffleArray(tableChanges) : tableChanges;
  
  logger.info(`Generated ${result.length} ${mode} changes`);
  
  // Make sure all changes have the batch ID
  for (const change of result) {
    if (!change.batchId) {
      change.batchId = batchId;
    }
  }
  
  return { changes: result, insertUpdatePairs, entitySummary };
}

/**
 * Generate and apply mixed changes in a single operation
 */
export async function generateAndApplyMixedChanges(
  count: number = DEFAULT_BATCH_SIZE,
  options: Partial<MixedChangesOptions> = {},
  changeTracker?: any
): Promise<{
  changes: TableChangeTest[], 
  insertUpdatePairs: {insertChange: TableChangeTest, updateChange: TableChangeTest}[],
  entitySummary: Record<string, any>
}> {
  // Generate a unique batch ID
  const batchId = options.batchId || `batch-${Date.now()}-${uuidv4().substring(0, 8)}`;
  
  // Maximum batch size
  const maxBatchSize = 20;
  
  // Track results
  const allAppliedChanges: TableChangeTest[] = [];
  const allInsertUpdatePairs: {insertChange: TableChangeTest, updateChange: TableChangeTest}[] = [];
  const entitySummary: Record<string, any> = {
    created: {
      user: [] as string[],
      project: [] as string[],
      task: [] as string[],
      comment: [] as string[]
    },
    updated: {
      user: [] as string[],
      project: [] as string[],
      task: [] as string[],
      comment: [] as string[]
    },
    deleted: {
      user: [] as string[],
      project: [] as string[],
      task: [] as string[],
      comment: [] as string[]
    },
    totalCount: 0
  };
  
  // Calculate number of batches
  const totalBatches = Math.ceil(count / maxBatchSize);
  logger.info(`Processing ${count} changes in ${totalBatches} batches`);
  
  // Process each batch
  for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
    const batchSize = Math.min(maxBatchSize, count - (batchNum * maxBatchSize));
    if (batchSize <= 0) break;
    
    logger.info(`Processing batch ${batchNum + 1}/${totalBatches} with ${batchSize} changes`);
    
    // Release updated IDs using change tracker if available
    if (changeTracker && options.idReleaseAfterBatches && options.idReleaseAfterBatches > 0) {
      try {
        const releasedCount = changeTracker.releaseUpdatedIds(
          changeTracker.getCurrentBatchNumber(),
          options.idReleaseAfterBatches
        );
        
        if (releasedCount > 0) {
          logger.info(`Released ${releasedCount} entity IDs for updates`);
        }
      } catch (e) {
        logger.warn(`Error releasing updated IDs: ${e}`);
      }
    }
    
    // Get IDs to exclude from updates
    let excludeFromUpdates: Record<EntityType, string[]> = {
      user: [], project: [], task: [], comment: []
    };
    
    if (changeTracker) {
      try {
        for (const entityType of DEPENDENCY_ORDER) {
          const excludeIds = changeTracker.getIdsToExcludeFromUpdates(entityType);
          excludeFromUpdates[entityType] = Array.from(excludeIds);
        }
      } catch (e) {
        logger.warn(`Error getting IDs to exclude from updates: ${e}`);
      }
    }
    
    // Prepare options for this batch
    const batchOptions: MixedChangesOptions = {
      ...options,
      batchSize,
      batchId: `${batchId}-${batchNum+1}`,
      excludeFromUpdates
    };
    
    try {
      // Generate changes for this batch
      const { changes, insertUpdatePairs: batchInsertUpdatePairs, entitySummary: batchSummary } = 
        await generateMixedChanges(batchOptions);
      
      // Log comment deletions before applying changes
      const commentDeletes = changes.filter(c => c.table === 'comments' && c.operation === 'delete');
      if (commentDeletes.length > 0) {
        // Log batch generation in a compact format
        logger.info(`\x1b[33mBatch ${batchNum + 1}: Generated ${commentDeletes.length} comment delete changes\x1b[0m`);
      }
      
      // Apply changes
      const appliedChanges = await applyChanges(changes);
      
      // Track successfully applied comment deletions
      const appliedCommentDeletes = appliedChanges.filter(c => c.table === 'comments' && c.operation === 'delete');
      if (appliedCommentDeletes.length > 0) {
        // Extract the deleted comment IDs from the applied changes
        const deletedCommentIds = appliedCommentDeletes.map(c => c.data?.id).filter(Boolean);
        
        // Add them to the entity summary
        entitySummary.deleted.comment.push(...deletedCommentIds);
        
        // Consolidated log message for successful deletions
        logger.info(`\x1b[34mBatch ${batchNum + 1}: Applied ${appliedCommentDeletes.length}/${commentDeletes.length} comment deletions\x1b[0m`);
      }
      
      // Record in change tracker if available
      if (changeTracker) {
        try {
          changeTracker.recordAppliedChanges(appliedChanges, batchOptions.batchId);
          
          // Track updated entities
          for (const change of appliedChanges) {
            if (change.operation === 'update' && change.data?.id) {
              const entityType = TABLE_TO_ENTITY[change.table];
              if (entityType) {
                const id = String(change.data.id);
                changeTracker.trackSpecificEntityUpdates(entityType, [id]);
              }
            }
          }
        } catch (e) {
          logger.warn(`Error recording changes in tracker: ${e}`);
        }
      }
      
      // Track results
      allAppliedChanges.push(...appliedChanges);
      if (batchInsertUpdatePairs && batchInsertUpdatePairs.length > 0) {
        allInsertUpdatePairs.push(...batchInsertUpdatePairs);
      }
    
      // Update entity summary
      if (batchSummary) {
        for (const actionType of ['created', 'updated', 'deleted'] as const) {
          if (batchSummary[actionType]) {
            for (const entityType of DEPENDENCY_ORDER) {
              if (Array.isArray(batchSummary[actionType][entityType])) {
                entitySummary[actionType][entityType].push(...batchSummary[actionType][entityType]);
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error(`Error in batch ${batchNum + 1}: ${error}`);
      // Continue with next batch
    }
  }
  
  // Final summary of all operations
  let batchSummary = `Successfully applied ${allAppliedChanges.length} changes in ${totalBatches} batches`;

  // Add deletion summary if applicable
  if (entitySummary.deleted.comment.length > 0) {
    batchSummary += ` (${entitySummary.deleted.comment.length} comments deleted)`;
  }

  logger.info(`\x1b[34m${batchSummary}\x1b[0m`);
  
  return { 
    changes: allAppliedChanges, 
    insertUpdatePairs: allInsertUpdatePairs,
    entitySummary
  };
}

/**
 * Seed the database with entities
 */
export async function seedDatabase(
  userCount: number = 10,
  projectCount: number = 20,
  taskCount: number = 50,
  commentCount: number = 100
): Promise<void> {
  // Calculate total
  const total = userCount + projectCount + taskCount + commentCount;
  
  const options: MixedChangesOptions = {
    mode: 'seed',
    batchSize: total,
    distribution: {
      user: userCount / total,
      project: projectCount / total,
      task: taskCount / total,
      comment: commentCount / total
    },
    includeIntentionalDuplicate: false
  };
  
  logger.info(`Seeding database with ${userCount} users, ${projectCount} projects, ${taskCount} tasks, and ${commentCount} comments`);
  
  const { changes } = await generateMixedChanges(options);
  await applyChanges(changes);
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