import { Task, TaskStatus, TaskPriority } from '@repo/typeorm/client-entities';
import { validateEntityOrThrow } from '@repo/typeorm';
import { changesLogger } from '../../utils/logger';
import { getDatabase } from '../../db/core';
import { dbMessageBus } from '../../db/message-bus';
import { workerManager } from '../../sync/worker-manager';
import { getLSNManager } from '../../sync/lsn-manager';

/**
 * Task API Module
 * 
 * This module provides functions for interacting with Task entities.
 * It handles database operations and validation.
 * The UI updates are handled by the store directly with optimistic updates.
 */

// Track task IDs that are currently being updated to prevent duplicate operations
const taskUpdateLocks = new Set<string>();

// Initialize LSN manager
const lsnManager = getLSNManager();
lsnManager.initialize().catch(err => {
  changesLogger.logServiceError('Failed to initialize LSN manager', err);
});

/**
 * Generate a UUID using PostgreSQL's uuid_generate_v4() function
 */
async function generateUUID(db: any): Promise<string> {
  const result = await db.query('SELECT uuid_generate_v4() as uuid');
  return result.rows[0].uuid;
}

/**
 * Get a task by ID
 * @param taskId The task ID
 * @returns Promise that resolves to the task or null if not found
 */
export async function getTaskById(taskId: string): Promise<Task | null> {
  changesLogger.logServiceEvent(`getTaskById called for ${taskId}`);
  
  try {
    // Get database connection
    const db = await getDatabase();
    
    // Execute the query
    const result = await db.query(`
      SELECT * FROM tasks WHERE id = $1
    `, [taskId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0] as Task;
  } catch (error) {
    changesLogger.logServiceError(`Error getting task ${taskId}`, error);
    throw error;
  }
}

/**
 * Get all tasks
 * @param options Optional filtering options
 * @returns Promise that resolves to an array of tasks
 */
export async function getAllTasks(options: {
    projectId?: string;
    assigneeId?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
} = {}): Promise<Task[]> {
  changesLogger.logServiceEvent(`getAllTasks called with options: ${JSON.stringify(options)}`);
  
  try {
    // Get database connection
    const db = await getDatabase();
    
    // Build the query
    let query = `SELECT * FROM task WHERE 1=1`;
    const params: any[] = [];
    let paramIndex = 1;
    
    if (options.projectId) {
      query += ` AND project_id = $${paramIndex}`;
      params.push(options.projectId);
      paramIndex++;
    }
    
    if (options.assigneeId) {
      query += ` AND assignee_id = $${paramIndex}`;
      params.push(options.assigneeId);
      paramIndex++;
    }
    
    if (options.status) {
      query += ` AND status = $${paramIndex}`;
      params.push(options.status);
      paramIndex++;
    }
    
    if (options.priority) {
      query += ` AND priority = $${paramIndex}`;
      params.push(options.priority);
      paramIndex++;
    }
    
    query += ` ORDER BY updated_at DESC`;
    
    // Execute the query
    const result = await db.query(query, params);
    
    return result.rows as Task[];
  } catch (error) {
    changesLogger.logServiceError('Error getting all tasks', error);
    throw error;
  }
}

/**
 * Create a new task
 * @param taskData The task data
 * @returns Promise that resolves to the created task
 */
export async function createTask(taskData: Partial<Task>): Promise<Task> {
  changesLogger.logServiceEvent(`createTask called`);
  
  try {
    // Validate task data
    await validateEntityOrThrow(taskData, Task);
    
    // Get database connection
    const db = await getDatabase();
    
    // Start transaction
    await db.query(`BEGIN`);
    
    try {
      // Generate UUID if not provided
      const taskId = taskData.id || await generateUUID(db);
      
      // Set timestamps
      const now = new Date();
      
      // Execute the insert query
      const result = await db.query(`
        INSERT INTO tasks (
          id, title, description, status, priority, project_id, assignee_id,
          due_date, completed_at, time_estimate, time_spent, tags, dependency_ids,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
        )
        RETURNING *
      `, [
        taskId,
        taskData.title || 'New Task',
        taskData.description || '',
        taskData.status || TaskStatus.OPEN,
        taskData.priority || TaskPriority.MEDIUM,
        taskData.projectId || null,
        taskData.assigneeId || null,
        taskData.dueDate || null,
        taskData.completedAt || null,
        taskData.timeEstimate || 0,
        taskData.timeSpent || 0,
        taskData.tags || [],
        taskData.dependencyIds || [],
        now,
        now
      ]);
      
      if (result.rows.length === 0) {
        throw new Error('Failed to create task');
      }
      
      const newTask = result.rows[0] as Task;
      changesLogger.logServiceEvent(`Task created successfully: ${newTask.id}`);
      
      // Send change to sync worker
      workerManager.sendMessage('client_change', {
        type: 'client_change',
        change: {
          table: 'task',
          operation: 'insert',
          data: newTask
        }
      });

      // Also publish change event
      dbMessageBus.publish('change_recorded', {
        entity_type: 'task',
        entity_id: newTask.id,
        operation: 'insert',
        data: newTask,
        old_data: null,
        timestamp: Date.now()
      });
      
      // Commit transaction
      await db.query(`COMMIT`);
      
      return newTask;
    } catch (error) {
      // Rollback transaction on error
      await db.query(`ROLLBACK`);
      changesLogger.logServiceError(`Error in transaction for task`, error);
      throw error;
    }
  } catch (error) {
    changesLogger.logServiceError('Failed to create task', error);
    throw error;
  }
}

/**
 * Update a task
 * @param taskId The task ID
 * @param taskData The task data to update
 * @returns Promise that resolves to the updated task
 */
export async function updateTask(taskId: string, taskData: Partial<Task>): Promise<Task> {
  changesLogger.logServiceEvent(`updateTask called for ${taskId}`);
  
  // Check if this task is already being updated
  if (taskUpdateLocks.has(taskId)) {
    changesLogger.logServiceEvent(`Update for task ${taskId} is already in progress, skipping duplicate update`);
    throw new Error(`Update for task ${taskId} is already in progress`);
  }
  
  // Add task ID to locks
  taskUpdateLocks.add(taskId);
  
  try {
    // Validate task data
    await validateEntityOrThrow(taskData, Task);
    
    // Get database connection
    const db = await getDatabase();
    
    // Start transaction
    await db.query(`BEGIN`);
    
    try {
      // Get current task data for old_data
      const current = await db.query<Task>(
        `SELECT * FROM task WHERE id = $1`,
        [taskId]
      );

      if (current.rows.length === 0) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const oldData = current.rows[0];
      
      // Build the update query dynamically based on provided fields
      const updateFields = [];
      const queryParams = [];
      let paramIndex = 1;
      
      if (taskData.title !== undefined) {
        updateFields.push(`title = $${paramIndex}`);
        queryParams.push(taskData.title);
        paramIndex++;
      }
      
      if (taskData.description !== undefined) {
        updateFields.push(`description = $${paramIndex}`);
        queryParams.push(taskData.description);
        paramIndex++;
      }
      
      if (taskData.status !== undefined) {
        updateFields.push(`status = $${paramIndex}`);
        queryParams.push(taskData.status);
        paramIndex++;
      }
      
      if (taskData.priority !== undefined) {
        updateFields.push(`priority = $${paramIndex}`);
        queryParams.push(taskData.priority);
        paramIndex++;
      }
      
      if (taskData.projectId !== undefined) {
        updateFields.push(`project_id = $${paramIndex}`);
        queryParams.push(taskData.projectId);
        paramIndex++;
      }
      
      if (taskData.assigneeId !== undefined) {
        updateFields.push(`assignee_id = $${paramIndex}`);
        queryParams.push(taskData.assigneeId);
        paramIndex++;
      }
      
      if (taskData.dueDate !== undefined) {
        updateFields.push(`due_date = $${paramIndex}`);
        queryParams.push(taskData.dueDate);
        paramIndex++;
      }
      
      if (taskData.completedAt !== undefined) {
        updateFields.push(`completed_at = $${paramIndex}`);
        queryParams.push(taskData.completedAt);
        paramIndex++;
      }
      
      if (taskData.timeEstimate !== undefined) {
        updateFields.push(`time_estimate = $${paramIndex}`);
        queryParams.push(taskData.timeEstimate);
        paramIndex++;
      }
      
      if (taskData.timeSpent !== undefined) {
        updateFields.push(`time_spent = $${paramIndex}`);
        queryParams.push(taskData.timeSpent);
        paramIndex++;
      }
      
      if (taskData.tags !== undefined) {
        updateFields.push(`tags = $${paramIndex}`);
        queryParams.push(taskData.tags);
        paramIndex++;
      }
      
      if (taskData.dependencyIds !== undefined) {
        updateFields.push(`dependency_ids = $${paramIndex}`);
        queryParams.push(taskData.dependencyIds);
        paramIndex++;
      }
      
      // Always update the updatedAt timestamp
      const updatedAt = new Date();
      updateFields.push(`updated_at = $${paramIndex}`);
      queryParams.push(updatedAt);
      paramIndex++;
      
      // Add the taskId as the last parameter
      queryParams.push(taskId);
      
      // Execute the update query
      const updateQuery = `
        UPDATE tasks
        SET ${updateFields.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;
      
      changesLogger.logServiceEvent(`Executing update query: ${updateQuery}`);
      changesLogger.logServiceEvent(`Query parameters: ${JSON.stringify(queryParams)}`);
      
      const result = await db.query(updateQuery, queryParams);
      
      if (result.rows.length === 0) {
        throw new Error(`Failed to update task ${taskId}`);
      }
      
      const updatedTask = result.rows[0] as Task;
      changesLogger.logServiceEvent(`Task updated successfully: ${taskId}`);
      
      // Send change to sync worker
      workerManager.sendMessage('client_change', {
        type: 'client_change',
        change: {
          table: 'task',
          operation: 'update',
          data: updatedTask,
          old_data: oldData
        }
      });

      // Also publish change event
      dbMessageBus.publish('change_recorded', {
        entity_type: 'task',
        entity_id: taskId,
        operation: 'update',
        data: updatedTask,
        old_data: oldData,
        timestamp: Date.now()
      });
      
      // Commit transaction
      await db.query(`COMMIT`);
      
      return updatedTask;
    } catch (error) {
      // Rollback transaction on error
      await db.query(`ROLLBACK`);
      changesLogger.logServiceError(`Error in transaction for task ${taskId}`, error);
      throw error;
    }
  } catch (error) {
    changesLogger.logServiceError(`Error updating task ${taskId}`, error);
    throw error;
  } finally {
    // Remove task ID from locks regardless of success or failure
    taskUpdateLocks.delete(taskId);
    changesLogger.logServiceEvent(`Released update lock for task ${taskId}`);
  }
}

/**
 * Delete a task
 * @param taskId The task ID
 * @param fromServer Whether this operation is triggered from server sync
 * @returns Promise that resolves to the deleted task
 */
export async function deleteTask(taskId: string, fromServer: boolean = false): Promise<Task> {
  changesLogger.logServiceEvent(`deleteTask called for ${taskId}${fromServer ? ' (from server)' : ''}`);
  
  // Check if this task is already being updated
  if (taskUpdateLocks.has(taskId)) {
    changesLogger.logServiceEvent(`Update for task ${taskId} is already in progress, skipping delete operation`);
    throw new Error(`Update for task ${taskId} is already in progress`);
  }
  
  // Add task ID to locks
  taskUpdateLocks.add(taskId);
  
  try {
    // Get database connection
    const db = await getDatabase();
    
    // Start transaction
    await db.query(`BEGIN`);
    
    try {
      // Get the task before deleting it
      const getTaskResult = await db.query(`
        SELECT * FROM tasks WHERE id = $1
      `, [taskId]);
      
      if (getTaskResult.rows.length === 0) {
        throw new Error(`Task with ID ${taskId} not found`);
      }
      
      const taskToDelete = getTaskResult.rows[0] as Task;
      
      // Delete the task
      const deleteResult = await db.query(`
        DELETE FROM tasks WHERE id = $1 RETURNING *
      `, [taskId]);
      
      if (deleteResult.rows.length === 0) {
        throw new Error(`Failed to delete task ${taskId}`);
      }
      
      changesLogger.logServiceEvent(`Task deleted successfully: ${taskId}`);
      
      // Send change to sync worker
      workerManager.sendMessage('client_change', {
        type: 'client_change',
        change: {
          table: 'task',
          operation: 'delete',
          old_data: taskToDelete
        }
      });

      // Also publish change event
      dbMessageBus.publish('change_recorded', {
        entity_type: 'task',
        entity_id: taskId,
        operation: 'delete',
        data: null,
        old_data: taskToDelete,
        timestamp: Date.now()
      });
      
      // Commit transaction
      await db.query(`COMMIT`);
      
      return taskToDelete;
    } catch (error) {
      // Rollback transaction on error
      await db.query(`ROLLBACK`);
      changesLogger.logServiceError(`Error in transaction for task ${taskId}`, error);
      throw error;
    }
  } catch (error) {
    changesLogger.logServiceError(`Error deleting task ${taskId}`, error);
    throw error;
  } finally {
    // Remove task ID from locks regardless of success or failure
    taskUpdateLocks.delete(taskId);
    changesLogger.logServiceEvent(`Released update lock for task ${taskId}`);
  }
}

/**
 * Upsert a task (create if it doesn't exist, update if it does)
 * @param taskId The task ID
 * @param taskData The task data
 * @param fromServer Whether this operation is triggered from server sync
 * @returns Promise that resolves to the upserted task
 */
export async function upsertTask(taskId: string, taskData: Partial<Task>, fromServer: boolean = false): Promise<Task> {
  changesLogger.logServiceEvent(`upsertTask called for ${taskId}${fromServer ? ' (from server)' : ''}`);
  
  // Check if this task is already being updated
  if (taskUpdateLocks.has(taskId)) {
    changesLogger.logServiceEvent(`Update for task ${taskId} is already in progress, skipping duplicate update`);
    throw new Error(`Update for task ${taskId} is already in progress`);
  }
  
  // Add task ID to locks
  taskUpdateLocks.add(taskId);
  
  try {
    // Validate task data
    await validateEntityOrThrow(taskData, Task);
    
    // Get database connection
    const db = await getDatabase();
    
    // Start transaction
    await db.query(`BEGIN`);
    
    try {
      // Check if task exists
      const checkResult = await db.query(`
        SELECT id FROM task WHERE id = $1
      `, [taskId]);
      
      const taskExists = checkResult.rows.length > 0;
      
      let result;
      
      if (taskExists) {
        // Task exists, update it
        changesLogger.logServiceEvent(`Task exists, updating: ${taskId}`);
        
        // Set the updatedAt timestamp
        const updatedAt = new Date();
        
        // Build the update query dynamically based on provided fields
        const updateFields = [];
        const queryParams = [];
        let paramIndex = 1;
        
        if (taskData.title !== undefined) {
          updateFields.push(`title = $${paramIndex}`);
          queryParams.push(taskData.title);
          paramIndex++;
        }
        
        if (taskData.description !== undefined) {
          updateFields.push(`description = $${paramIndex}`);
          queryParams.push(taskData.description);
          paramIndex++;
        }
        
        if (taskData.status !== undefined) {
          updateFields.push(`status = $${paramIndex}`);
          queryParams.push(taskData.status);
          paramIndex++;
        }
        
        if (taskData.priority !== undefined) {
          updateFields.push(`priority = $${paramIndex}`);
          queryParams.push(taskData.priority);
          paramIndex++;
        }
        
        if (taskData.projectId !== undefined) {
          updateFields.push(`project_id = $${paramIndex}`);
          queryParams.push(taskData.projectId);
          paramIndex++;
        }
        
        if (taskData.assigneeId !== undefined) {
          updateFields.push(`assignee_id = $${paramIndex}`);
          queryParams.push(taskData.assigneeId);
          paramIndex++;
        }
        
        if (taskData.dueDate !== undefined) {
          updateFields.push(`due_date = $${paramIndex}`);
          queryParams.push(taskData.dueDate);
          paramIndex++;
        }
        
        if (taskData.completedAt !== undefined) {
          updateFields.push(`completed_at = $${paramIndex}`);
          queryParams.push(taskData.completedAt);
          paramIndex++;
        }
        
        if (taskData.timeEstimate !== undefined) {
          updateFields.push(`time_estimate = $${paramIndex}`);
          queryParams.push(taskData.timeEstimate);
          paramIndex++;
        }
        
        if (taskData.timeSpent !== undefined) {
          updateFields.push(`time_spent = $${paramIndex}`);
          queryParams.push(taskData.timeSpent);
          paramIndex++;
        }
        
        if (taskData.tags !== undefined) {
          updateFields.push(`tags = $${paramIndex}`);
          queryParams.push(taskData.tags);
          paramIndex++;
        }
        
        if (taskData.dependencyIds !== undefined) {
          updateFields.push(`dependency_ids = $${paramIndex}`);
          queryParams.push(taskData.dependencyIds);
          paramIndex++;
        }
        
        // Always update the updatedAt timestamp
        updateFields.push(`updated_at = $${paramIndex}`);
        queryParams.push(updatedAt);
        paramIndex++;
        
        // Add the taskId as the last parameter
        queryParams.push(taskId);
        
        // Execute the update query
        const updateQuery = `
          UPDATE tasks
          SET ${updateFields.join(', ')}
          WHERE id = $${paramIndex}
          RETURNING *
        `;
        
        changesLogger.logServiceEvent(`Executing update query: ${updateQuery}`);
        changesLogger.logServiceEvent(`Query parameters: ${JSON.stringify(queryParams)}`);
        
        result = await db.query(updateQuery, queryParams);
        
        if (result.rows.length === 0) {
          throw new Error(`Failed to update task ${taskId}`);
        }
      } else {
        // Task doesn't exist, create it
        changesLogger.logServiceEvent(`Task doesn't exist, creating: ${taskId}`);
        
        // Set timestamps
        const now = new Date();
        
        // Execute the insert query
        result = await db.query(`
          INSERT INTO tasks (
            id, title, description, status, priority, project_id, assignee_id,
            due_date, completed_at, time_estimate, time_spent, tags, dependency_ids,
            created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
          )
          RETURNING *
        `, [
          taskId,
          taskData.title || 'New Task',
          taskData.description || '',
          taskData.status || TaskStatus.OPEN,
          taskData.priority || TaskPriority.MEDIUM,
          taskData.projectId || null,
          taskData.assigneeId || null,
          taskData.dueDate || null,
          taskData.completedAt || null,
          taskData.timeEstimate || 0,
          taskData.timeSpent || 0,
          taskData.tags || [],
          taskData.dependencyIds || [],
          now,
          now
        ]);
        
        if (result.rows.length === 0) {
          throw new Error('Failed to create task');
        }
      }
      
      const upsertedTask = result.rows[0] as Task;
      changesLogger.logServiceEvent(`Task ${taskExists ? 'updated' : 'created'} successfully: ${taskId}`);
      
      // Send change to sync worker
      workerManager.sendMessage('client_change', {
        type: 'client_change',
        change: {
          table: 'task',
          operation: taskExists ? 'update' : 'insert',
          data: upsertedTask,
          old_data: taskExists ? null : null
        }
      });

      // Also publish change event
      dbMessageBus.publish('change_recorded', {
        entity_type: 'task',
        entity_id: taskId,
        operation: taskExists ? 'update' : 'insert',
        data: upsertedTask,
        old_data: taskExists ? null : null,
        timestamp: Date.now()
      });
      
      // Commit transaction
      await db.query(`COMMIT`);
      
      return upsertedTask;
    } catch (error) {
      // Rollback transaction on error
      await db.query(`ROLLBACK`);
      changesLogger.logServiceError(`Error in transaction for task ${taskId}`, error);
      throw error;
    }
  } catch (error) {
    changesLogger.logServiceError(`Error upserting task ${taskId}`, error);
    throw error;
  } finally {
    // Remove task ID from locks regardless of success or failure
    taskUpdateLocks.delete(taskId);
    changesLogger.logServiceEvent(`Released update lock for task ${taskId}`);
  }
} 