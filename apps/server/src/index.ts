/// <reference path="../worker-configuration.d.ts" />

// Set up node polyfills first
import 'reflect-metadata';

// Import other dependencies
import { Hono, Context } from 'hono';
import { cors } from 'hono/cors'; // Re-add hono/cors import
import api from './api';
import { serverLogger } from './middleware/logger';
import { createStructuredLogger } from './middleware/logger';
// Removed manualCorsHeaders import
import type { AppBindings } from './types/hono';
import type { Env, ExecutionContext } from './types/env';
import { SyncDO } from './sync/SyncDO';
import { ReplicationDO } from './replication/ReplicationDO';
import internalAuthApp from './auth/internal';
import { getAuth, AuthType } from './lib/auth';

// Remove temporary auth instance

/**
 * Main API router for PUBLIC endpoints
 * Handles all HTTP routes under the /api path
 */
const apiApp = new Hono<AppBindings>().basePath('/api');

// Add Hono's CORS middleware FIRST
apiApp.use('*', cors({
  origin: (origin) => {
    // Dynamically allow the specific frontend origin
    // or potentially others in the future
    const allowedOrigins = ['http://localhost:5173'];
    if (allowedOrigins.includes(origin)) {
      return origin;
    } else {
      // Return a default allowed origin or null if none match
      // Returning the first one here for consistency, though ideally, it should match.
      return allowedOrigins[0]; 
    }
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true, // Allow cookies/credentials
  maxAge: 86400, // Cache preflight for 1 day
}));

// Use our structured logger middleware
apiApp.use('*', createStructuredLogger());

// Mount the Better Auth handler using double asterisk pattern for GET/POST
// TEMPORARILY simplified for CORS debugging - Setting headers manually
apiApp.on(["POST", "GET"], "/auth/**", 
  // REMOVED manualCorsHeaders middleware usage
  async (c) => { 
    // Restore original handler logic
    const requestId = c.req.header('cf-request-id') || `local-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    console.log(`[${requestId}] [apiApp .on()] Handling auth path: ${c.req.path}, Method: ${c.req.method}`);
    console.log(`[${requestId}] Request headers:`, Object.fromEntries(c.req.raw.headers.entries()));

    console.log(`[${requestId}] Getting auth instance...`);
    const authInstance = getAuth(c); 
    try {
      console.log(`[${requestId}] Calling auth handler...`);
      const response = await authInstance.handler(c.req.raw);
      console.log(`[${requestId}] Auth handler returned response:`, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries())
      });

      // Return the raw response directly. CORS middleware should handle headers.
      return response;

    } catch (error) {
      console.error(`[${requestId}] Error in Better Auth handler:`, error);
      // Return a simple error response. CORS middleware should handle headers.
      return c.json({ error: "Internal Auth Error" }, 500);
    }
  }
);

// Mount OTHER public API routes 
apiApp.route('/', api);

/**
 * Router for INTERNAL service-to-service communication
 */
const internalApp = new Hono<AppBindings>().basePath('/internal');

// Use logger for internal routes too
internalApp.use('*', createStructuredLogger());

// Mount internal auth routes
internalApp.route('/auth', internalAuthApp);

/**
 * Main worker export
 * 
 * This is the entry point for all requests to the worker.
 * It handles:
 * 1. WebSocket upgrade requests for real-time sync
 * 2. Regular HTTP API requests via the Hono router
 */
const worker = {
  /**
   * Main fetch handler for the worker
   * 
   * @param request - The incoming request
   * @param env - Environment variables and bindings
   * @param ctx - Execution context
   * @returns Response to the request
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = request.headers.get('cf-request-id') || `local-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    // console.log(`[${requestId}] Worker fetch called for: ${request.url}`); // Removed log
    // console.log(`[${requestId}] Request method: ${request.method}`); // Removed log
    // console.log(`[${requestId}] Request headers:`, Object.fromEntries(request.headers.entries())); // Removed log
    
    const url = new URL(request.url);

    /**
     * WebSocket handling for sync
     * 
     * WebSocket connections are handled directly here (not through Hono) because:
     * 1. They need to be routed to specific Durable Object instances
     * 2. They require special response handling (101 status code)
     * 3. They use Cloudflare's WebSocket Hibernation API
     */
    if (url.pathname === '/api/sync') {
      // Check for WebSocket upgrade request
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }

      // Extract client ID from query params or generate a new one
      const clientId = url.searchParams.get('clientId');
      if (!clientId) {
        return new Response('Client ID is required', { status: 400 });
      }
      
      // Create unique SyncDO instance for this client
      // Use a consistent identifier based on clientId to ensure all messages
      // from the same client go to the same DO instance
      const id = env.SYNC.idFromName(`client:${clientId}`);
      const obj = env.SYNC.get(id);
      
      // Forward the request to the Durable Object
      return obj.fetch(request);
    }

    // --- Route to PUBLIC API router ---
    if (url.pathname.startsWith('/api/')) {
      // console.log(`[${requestId}] Routing to public API app for path: ${url.pathname}`); // Removed log
      try {
        // Hono app (apiApp) will handle the actual GET/POST for /api/auth/**
        // including setting CORS headers on the response via the .on() handler
        const response = await apiApp.fetch(request, env, ctx);
        // console.log(`[${requestId}] API response status: ${response.status}`); // Removed log
        // console.log(`[${requestId}] API response headers:`, Object.fromEntries(response.headers.entries())); // Removed log
        return response;
      } catch (error) {
        console.error(`[${requestId}] Error handling request:`, error);
        return new Response(JSON.stringify({
          ok: false,
          error: {
            type: 'InternalServerError',
            message: 'An unexpected error occurred'
          }
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
    }
    
    // --- Route to INTERNAL router ---
    if (url.pathname.startsWith('/internal/')) {
      // serverLogger.debug(`Routing to internal app for path: ${url.pathname}`); // Keep debug log potentially
      try {
        return await internalApp.fetch(request, env, ctx);
      } catch (error) {
        serverLogger.error('Error handling internal request', error);
        return new Response(JSON.stringify({ ok: false, error: { type: 'InternalServerError', message: 'Internal communication error' }}), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // No route matched
    // serverLogger.debug('No route matched, returning 404'); // Keep debug log potentially
    return new Response('Not Found', { status: 404 });
  }
};

export { SyncDO, ReplicationDO };
export default worker; 