import { Hono } from 'hono';
import type { ApiEnv } from '../types/api';

/**
 * Sync API Router
 * 
 * This router handles synchronization-related HTTP endpoints by forwarding them to the appropriate SyncDO instance.
 * Each client gets its own SyncDO instance to manage its state and WebSocket connection.
 */
const sync = new Hono<ApiEnv>();

// Forward all requests to the appropriate SyncDO instance
sync.all('*', async (c) => {
  const clientId = c.req.query('clientId');
  
  if (!clientId) {
    return c.json({ error: 'clientId parameter is required' }, 400);
  }

  // Create unique SyncDO instance for this client
  const id = c.env.SYNC.idFromName(`client:${clientId}`);
  const obj = c.env.SYNC.get(id);

  // Forward the request to the Durable Object
  const response = await obj.fetch(c.req.url);
  const data = await response.json();
  
  // Let Hono handle the response and headers
  return c.json(data, response.status);
});

export { sync }; 