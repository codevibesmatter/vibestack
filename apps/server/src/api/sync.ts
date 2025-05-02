import { Hono } from 'hono';
import type { Env } from '../types/env';
import { syncLogger } from '../middleware/logger';
import { initializeAuth } from '../lib/auth';

const sync = new Hono<{ Bindings: Env }>();

// WebSocket endpoint for sync
sync.get('/ws', async (c) => {
  const clientId = c.req.query('clientId');
  
  if (!clientId) {
    return c.json({ error: 'Client ID is required' }, 400);
  }

  // Authenticate using session cookie
  try {
    // Initialize auth
    const auth = initializeAuth(c.env);
    
    // Get session data using cookies from the request
    const sessionData = await auth.api.getSession({ headers: c.req.raw.headers });
    
    if (!sessionData || !sessionData.user) {
      syncLogger.error('No valid session found for sync connection', { clientId });
      return c.json({ error: 'No valid session found' }, 401);
    }
    
    // Session is valid, proceed with WebSocket connection
    syncLogger.info('User authenticated for sync connection via session cookie', {
      clientId,
      userId: sessionData.user.id
    });
    
    // Create and return a Durable Object instance for this client
    try {
      const id = c.env.SYNC.idFromName(`client:${clientId}`);
      const obj = c.env.SYNC.get(id);
      return obj.fetch(c.req.raw);
    } catch (err) {
      syncLogger.error('WebSocket connection failed', {
        clientId,
        error: err instanceof Error ? err.message : String(err)
      });
      return c.json({ error: 'Failed to establish WebSocket connection' }, 500);
    }
  } catch (authErr) {
    syncLogger.error('Authentication error', {
      clientId,
      error: authErr instanceof Error ? authErr.message : String(authErr)
    });
    return c.json({ error: 'Authentication error' }, 401);
  }
});

// Metrics endpoint
sync.get('/metrics', async (c) => {
  try {
    const id = c.env.SYNC.idFromName('metrics');
    const obj = c.env.SYNC.get(id);
    return obj.fetch(c.req.raw);
  } catch (err) {
    syncLogger.error('Failed to get metrics', {
      error: err instanceof Error ? err.message : String(err)
    });
    return c.json({ error: 'Failed to get metrics' }, 500);
  }
});

// HTTP endpoints for init
sync.post('/init', async (c) => {
  const clientId = c.req.query('clientId');
  if (!clientId) {
    return c.json({ error: 'Client ID is required' }, 400);
  }

  try {
    // Forward to SyncDO
    const id = c.env.SYNC.idFromName(`client:${clientId}`);
    const obj = c.env.SYNC.get(id);
    return obj.fetch(c.req.raw);
  } catch (err) {
    syncLogger.error('Init sync failed', {
      clientId,
      error: err instanceof Error ? err.message : String(err)
    });
    return c.json({ error: 'Failed to get table states' }, 500);
  }
});

// Initial sync endpoint for testing
sync.get('/initial', async (c) => {
  const clientId = c.req.query('clientId');
  if (!clientId) {
    return c.json({ error: 'Client ID is required' }, 400);
  }

  try {
    // Forward to SyncDO
    const id = c.env.SYNC.idFromName(`client:${clientId}`);
    const obj = c.env.SYNC.get(id);
    return obj.fetch(c.req.raw);
  } catch (err) {
    syncLogger.error('Initial sync failed', {
      clientId,
      error: err instanceof Error ? err.message : String(err)
    });
    return c.json({ 
      success: false,
      error: err instanceof Error ? err.message : 'Failed to perform initial sync'
    }, 500);
  }
});

export { sync };