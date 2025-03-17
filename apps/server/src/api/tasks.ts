import { Hono } from 'hono';
import {
  type ApiEnv,
  ServiceErrorType,
  createSuccessResponse,
  createErrorResponse
} from '../types/api';
import { getDBClient } from '../lib/db';
import { taskQueries, TaskStatus, TaskPriority } from '../domains/tasks';

// Create tasks router
const tasks = new Hono<ApiEnv>();

// List tasks
tasks.get('/', async (c) => {
  const client = getDBClient(c);
  try {
    await client.connect();
    const { status } = c.req.query();
    
    let result;
    if (status && Object.values(TaskStatus).includes(status as typeof TaskStatus[keyof typeof TaskStatus])) {
      result = await taskQueries.findByStatus(client, status as typeof TaskStatus[keyof typeof TaskStatus]);
    } else {
      result = await taskQueries.findAll(client);
    }
    
    return c.json(createSuccessResponse(result));
  } catch (err) {
    console.error('Error listing tasks:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  } finally {
    await client.end();
  }
});

// Create task
tasks.post('/', async (c) => {
  const client = getDBClient(c);
  try {
    const body = await c.req.json();
    await client.connect();
    const result = await taskQueries.create(client, body);
    return c.json(createSuccessResponse(result), 201);
  } catch (err) {
    console.error('Error creating task:', err);
    if (err instanceof Error && err.message.includes('Validation failed')) {
      return c.json(
        createErrorResponse(ServiceErrorType.VALIDATION, err.message),
        400
      );
    }
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  } finally {
    await client.end();
  }
});

// Get task by ID
tasks.get('/:id', async (c) => {
  const client = getDBClient(c);
  try {
    const id = c.req.param('id');
    await client.connect();
    const task = await taskQueries.findById(client, id);
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
  } finally {
    await client.end();
  }
});

// Update task
tasks.patch('/:id', async (c) => {
  const client = getDBClient(c);
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    await client.connect();
    
    // Handle status updates separately to manage completedAt
    if (body.status) {
      const result = await taskQueries.updateStatus(client, id, body.status);
      if (!result) {
        return c.json(
          createErrorResponse(
            ServiceErrorType.NOT_FOUND,
            `Task with id ${id} not found`
          ),
          404
        );
      }
      delete body.status; // Remove status from body as it's already handled
      
      // If there are other fields to update, continue with regular update
      if (Object.keys(body).length > 0) {
        const updatedResult = await taskQueries.update(client, id, body);
        if (!updatedResult) {
          return c.json(
            createErrorResponse(
              ServiceErrorType.NOT_FOUND,
              `Task with id ${id} not found`
            ),
            404
          );
        }
        return c.json(createSuccessResponse(updatedResult));
      }
      return c.json(createSuccessResponse(result));
    }
    
    // Regular update for non-status changes
    const result = await taskQueries.update(client, id, body);
    if (!result) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Task with id ${id} not found`
        ),
        404
      );
    }
    return c.json(createSuccessResponse(result));
  } catch (err) {
    console.error('Error updating task:', err);
    if (err instanceof Error && err.message.includes('Validation failed')) {
      return c.json(
        createErrorResponse(ServiceErrorType.VALIDATION, err.message),
        400
      );
    }
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  } finally {
    await client.end();
  }
});

// Delete task
tasks.delete('/:id', async (c) => {
  const client = getDBClient(c);
  try {
    const id = c.req.param('id');
    await client.connect();
    const success = await taskQueries.delete(client, id);
    if (!success) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Task with id ${id} not found`
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
  } finally {
    await client.end();
  }
});

export { tasks }; 