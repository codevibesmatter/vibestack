import { Hono } from 'hono';
import {
  type ApiEnv,
  ServiceErrorType,
  createSuccessResponse,
  createErrorResponse
} from '../types/api';
import { getDBClient } from '../lib/db';
import { projectQueries } from '../domains/projects';

// Create projects router
const projects = new Hono<ApiEnv>();

// List projects
projects.get('/', async (c) => {
  const client = getDBClient(c);
  try {
    await client.connect();
    const result = await projectQueries.findAll(client);
    return c.json(createSuccessResponse(result));
  } catch (err) {
    console.error('Error listing projects:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  } finally {
    await client.end();
  }
});

// Create project
projects.post('/', async (c) => {
  const client = getDBClient(c);
  try {
    const body = await c.req.json();
    await client.connect();
    const result = await projectQueries.create(client, body);
    return c.json(createSuccessResponse(result), 201);
  } catch (err) {
    console.error('Error creating project:', err);
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

// Get project by ID
projects.get('/:id', async (c) => {
  const client = getDBClient(c);
  try {
    const id = c.req.param('id');
    await client.connect();
    const project = await projectQueries.findById(client, id);
    if (!project) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Project with id ${id} not found`
        ),
        404
      );
    }
    return c.json(createSuccessResponse(project));
  } catch (err) {
    console.error('Error getting project:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  } finally {
    await client.end();
  }
});

// Update project
projects.patch('/:id', async (c) => {
  const client = getDBClient(c);
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    await client.connect();
    const result = await projectQueries.update(client, id, body);
    if (!result) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Project with id ${id} not found`
        ),
        404
      );
    }
    return c.json(createSuccessResponse(result));
  } catch (err) {
    console.error('Error updating project:', err);
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

// Delete project
projects.delete('/:id', async (c) => {
  const client = getDBClient(c);
  try {
    const id = c.req.param('id');
    await client.connect();
    const success = await projectQueries.delete(client, id);
    if (!success) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Project with id ${id} not found`
        ),
        404
      );
    }
    return c.json(createSuccessResponse({ id }));
  } catch (err) {
    console.error('Error deleting project:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  } finally {
    await client.end();
  }
});

export { projects };