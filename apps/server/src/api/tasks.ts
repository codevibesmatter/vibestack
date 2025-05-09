import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  type ApiEnv,
  ServiceErrorType,
  createSuccessResponse,
  createErrorResponse
} from '../types/api';
import { NeonService } from '../lib/neon-orm/neon-service';
import { Task, TaskStatus, TaskPriority } from "@repo/dataforge/server-entities";
import { TaskRepository, TaskCreateInput, TaskUpdateInput } from '../domains/tasks';

// Re-export enums for convenience
export { TaskStatus, TaskPriority };

// Create tasks router
const tasks = new Hono<ApiEnv>();

// List tasks
tasks.get('/', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const neonService = new NeonService(c);
    const taskRepo = new TaskRepository(neonService);
    const { status } = c.req.query();
    
    let result: Task[];
    if (status && Object.values(TaskStatus).includes(status as TaskStatus)) {
      // Use repository for status filtering
      result = await taskRepo.findByStatus(status as TaskStatus);
    } else {
      // Use repository for all tasks
      result = await taskRepo.findAll();
    }
    
    return c.json(createSuccessResponse(result));
  } catch (err) {
    console.error('Error listing tasks:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Create task
tasks.post('/', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const body = await c.req.json();
    const neonService = new NeonService(c);
    const taskRepo = new TaskRepository(neonService);
    
    // The repository will handle validation and defaults
    const result = await taskRepo.create(body);
    
    return c.json(createSuccessResponse(result), 201);
  } catch (err) {
    console.error('Error creating task:', err);
    if (err instanceof Error && err.message.includes('validation')) {
      return c.json(
        createErrorResponse(ServiceErrorType.VALIDATION, err.message),
        400
      );
    }
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Get task by ID
tasks.get('/:id', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const id = c.req.param('id');
    const neonService = new NeonService(c);
    const taskRepo = new TaskRepository(neonService);
    
    const task = await taskRepo.findById(id);
    
    if (!task) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Task with id ${id} not found`
        ),
        404
      );
    }
    
    return c.json(createSuccessResponse(task));
  } catch (err) {
    console.error('Error getting task:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Update task
tasks.patch('/:id', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const neonService = new NeonService(c);
    const taskRepo = new TaskRepository(neonService);
    
    // Find the task first to ensure it exists
    const existingTask = await taskRepo.findById(id);
    if (!existingTask) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Task with id ${id} not found`
        ),
        404
      );
    }
    
    // Handle status updates separately to manage completedAt
    if (body.status && body.status !== existingTask.status) {
      await taskRepo.updateStatus(id, body.status);
      // Remove status from body to avoid duplicate updates
      delete body.status;
    }
    
    // Update the remaining fields if any
    let updatedTask;
    if (Object.keys(body).length > 0) {
      updatedTask = await taskRepo.update(id, body);
    }
    
    // Always fetch the latest task data to return the most recent state
    updatedTask = await taskRepo.findById(id);
    if (!updatedTask) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Task with id ${id} not found after update`
        ),
        404
      );
    }
    
    return c.json(createSuccessResponse(updatedTask));
  } catch (err) {
    console.error('Error updating task:', err);
    if (err instanceof Error && err.message.includes('validation')) {
      return c.json(
        createErrorResponse(ServiceErrorType.VALIDATION, err.message),
        400
      );
    }
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Delete task
tasks.delete('/:id', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const id = c.req.param('id');
    const neonService = new NeonService(c);
    const taskRepo = new TaskRepository(neonService);
    
    // TaskRepository.delete already checks if the task exists
    const deleted = await taskRepo.delete(id);
    
    if (!deleted) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Task with id ${id} not found or could not be deleted`
        ),
        404
      );
    }
    
    return c.json(createSuccessResponse({ id }));
  } catch (err) {
    console.error('Error deleting task:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

export { tasks }; 