import { Hono } from 'hono';
import type { Env } from '../types/env';
import { syncLogger } from '../middleware/logger';
import { initializeAuth } from '../lib/auth';

const sync = new Hono<{ Bindings: Env }>();

// WebSocket endpoint for sync
sync.get('/ws', async (c) => {
  const clientId = c.req.query('clientId');
  const authToken = c.req.query('auth');
  
  if (!clientId) {
    return c.json({ error: 'Client ID is required' }, 400);
  }

  // Verify authentication if auth token is provided
  if (authToken) {
    try {
      // Initialize auth directly
      const auth = initializeAuth(c.env);
      
      // Use 'any' type to bypass linter errors
      const authAny = auth as any;
      
      if (authAny.jwt && typeof authAny.jwt.verify === 'function') {
        try {
          // Verify JWT token with Better Auth
          const result = await authAny.jwt.verify(authToken);
          
          if (!result.valid || !result.payload?.sub) {
            syncLogger.error('Invalid JWT token for sync connection', {
              clientId,
              valid: result.valid,
              sub: result.payload?.sub
            });
            return c.json({ error: 'No valid session found' }, 401);
          }
          
          syncLogger.info('Valid JWT authentication for sync connection', {
            clientId,
            userId: result.payload.sub
          });
        } catch (jwtError) {
          syncLogger.error('JWT verification error', {
            clientId,
            error: jwtError instanceof Error ? jwtError.message : String(jwtError)
          });
          return c.json({ error: 'Authentication error' }, 401);
        }
      } else {
        // Check if we can use the api.getSession method as a fallback
        try {
          if (authAny.api && typeof authAny.api.validateJWT === 'function') {
            const isValid = await authAny.api.validateJWT(authToken);
            
            if (!isValid) {
              syncLogger.error('JWT validation failed', { clientId });
              return c.json({ error: 'No valid session found' }, 401);
            }
            
            syncLogger.info('JWT validated successfully', { clientId });
          } else {
            syncLogger.error('JWT validation not available', { clientId });
            return c.json({ error: 'Authentication method not available' }, 500);
          }
        } catch (apiError) {
          syncLogger.error('API JWT validation error', {
            clientId,
            error: apiError instanceof Error ? apiError.message : String(apiError)
          });
          return c.json({ error: 'Authentication error' }, 401);
        }
      }
    } catch (authErr) {
      syncLogger.error('Auth initialization error', {
        clientId,
        error: authErr instanceof Error ? authErr.message : String(authErr)
      });
      return c.json({ error: 'Authentication error' }, 401);
    }
  } else {
    syncLogger.warn('No authentication token provided for sync connection', { clientId });
    return c.json({ error: 'No valid session found' }, 401);
  }

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