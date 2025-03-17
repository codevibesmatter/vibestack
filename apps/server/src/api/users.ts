import { Hono } from 'hono';
import {
  type ApiEnv,
  ServiceErrorType,
  createSuccessResponse,
  createErrorResponse,
} from '../types/api';
import { getDBClient } from '../lib/db';
import { userQueries } from '../domains/users';

// Create users router
const users = new Hono<ApiEnv>();

// List users
users.get('/', async (c) => {
  const client = getDBClient(c);
  try {
    await client.connect();
    const result = await userQueries.findAll(client);
    return c.json(createSuccessResponse(result));
  } catch (err) {
    console.error('Error listing users:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  } finally {
    await client.end();
  }
});

// Create user
users.post('/', async (c) => {
  const client = getDBClient(c);
  try {
    const body = await c.req.json();
    await client.connect();
    const result = await userQueries.create(client, body);
    return c.json(createSuccessResponse(result), 201);
  } catch (err) {
    console.error('Error creating user:', err);
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

// Get user by ID
users.get('/:id', async (c) => {
  const client = getDBClient(c);
  try {
    const id = c.req.param('id');
    await client.connect();
    const user = await userQueries.findById(client, id);
    if (!user) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `User with id ${id} not found`
        ),
        404
      );
    }
    return c.json(createSuccessResponse(user));
  } catch (err) {
    console.error('Error getting user:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  } finally {
    await client.end();
  }
});

// Update user
users.patch('/:id', async (c) => {
  const client = getDBClient(c);
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    await client.connect();
    const result = await userQueries.update(client, id, body);
    if (!result) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `User with id ${id} not found`
        ),
        404
      );
    }
    return c.json(createSuccessResponse(result));
  } catch (err) {
    console.error('Error updating user:', err);
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

// Delete user
users.delete('/:id', async (c) => {
  const client = getDBClient(c);
  try {
    const id = c.req.param('id');
    await client.connect();
    const success = await userQueries.delete(client, id);
    if (!success) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `User with id ${id} not found`
        ),
        404
      );
    }
    return c.json(createSuccessResponse({ id }));
  } catch (err) {
    console.error('Error deleting user:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  } finally {
    await client.end();
  }
});

export { users }; 