import { Hono } from 'hono';
import {
  type ApiEnv,
  ServiceErrorType,
  createSuccessResponse,
  createErrorResponse,
} from '../types/api';
import { getDBClient } from '../lib/db';
import { migrationQueries } from '../domains/migrations';

// Create migrations router
const migrations = new Hono<ApiEnv>();

// List all migrations
migrations.get('/', async (c) => {
  const client = getDBClient(c);
  try {
    await client.connect();
    const result = await migrationQueries.findAll(client);
    return c.json(createSuccessResponse(result));
  } catch (err) {
    console.error('Error listing migrations:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  } finally {
    await client.end();
  }
});

// Get migration by name
migrations.get('/:name', async (c) => {
  const client = getDBClient(c);
  try {
    const name = c.req.param('name');
    await client.connect();
    const migration = await migrationQueries.findByName(client, name);
    if (!migration) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Migration ${name} not found`
        ),
        404
      );
    }
    return c.json(createSuccessResponse(migration));
  } catch (err) {
    console.error('Error getting migration:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  } finally {
    await client.end();
  }
});

export { migrations }; 