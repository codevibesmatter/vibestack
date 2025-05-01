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
import { getAuth, AuthType, initializeAuth } from './lib/auth';
import { serverLogger as log } from './middleware/logger';
import { authMiddleware } from './middleware/auth'; // <-- Import the new middleware
import authRouter from './api/auth';

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
    const allowedOrigins = ['https://127.0.0.1:5173', 'http://127.0.0.1:5173', 'http://localhost:5173'];
    if (!origin) return allowedOrigins[0]; // Default for non-browser requests
    if (allowedOrigins.includes(origin)) {
      return origin;
    } else {
      // Return a default allowed origin or null if none match
      console.warn(`[CORS] Rejected origin: ${origin}`);
      return allowedOrigins[0]; 
    }
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true, // Allow cookies/credentials
  maxAge: 86400, // Cache preflight for 1 day
  exposeHeaders: ['Set-Cookie'], // Expose Set-Cookie header to JavaScript
}));

// Use our structured logger middleware
apiApp.use('*', createStructuredLogger());

// Apply the authentication middleware to check session status on all requests
apiApp.use('*', authMiddleware);

// Mount the auth router
apiApp.route('/auth', authRouter);

// Mount OTHER public API routes 
apiApp.route('/', api);

/**
 * Router for INTERNAL service-to-service communication
 */
const internalApp = new Hono<AppBindings>().basePath('/internal');

// Use logger for internal routes too
internalApp.use('*', createStructuredLogger());

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
      // --- BEGIN CORS CHECK for /api/sync ---
      const origin = request.headers.get('Origin');
      const allowedOrigins = ['https://127.0.0.1:5173', 'http://127.0.0.1:5173', 'http://localhost:5173']; // Match the API allowed origins
      let allowedOrigin = null;

      if (origin && allowedOrigins.includes(origin)) {
        allowedOrigin = origin;
      } else if (origin) {
        // Origin is present but not allowed
        console.warn(`[${requestId}] [Sync CORS] Forbidden origin: ${origin}`);
        return new Response('Forbidden', { status: 403 });
      } else {
        // Origin header is missing - this might be allowed for same-origin or non-browser clients
        // For security, we could reject here, but let's assume allowed for now if credentials aren't strictly needed
        // If cookies are essential, we should probably reject missing origins.
        // For now, let's proceed but not set the Allow-Origin header.
        console.log(`[${requestId}] [Sync CORS] Origin header missing, proceeding.`);
      }
      // --- END CORS CHECK ---

      // --- BEGIN AUTH CHECK for /api/sync ---
      try {
        const auth = initializeAuth(env); // Initialize auth using env
        
        // Check for auth token in query parameters (for WebSocket connections)
        const authToken = url.searchParams.get('auth');
        let sessionData = null;
        
        if (authToken) {
          // Create a modified request with the auth token in the Authorization header
          console.log(`[${requestId}] [Sync Auth] Attempting to authenticate with token parameter`);
          try {
            // Create a new request with the token in the Authorization header
            const modifiedHeaders = new Headers(request.headers);
            modifiedHeaders.set('Cookie', `session_token=${authToken}`);
            
            // Try to get session using the modified headers
            sessionData = await auth.api.getSession({ headers: modifiedHeaders });
          } catch (tokenError) {
            console.error(`[${requestId}] [Sync Auth] Token-based auth failed:`, tokenError);
          }
        }
        
        // If no token or token validation failed, fall back to cookie-based auth
        if (!sessionData && auth.api && typeof auth.api.getSession === 'function') {
          sessionData = await auth.api.getSession({ headers: request.headers });
        }
        
        if (!sessionData) {
          // No valid session, reject the request before WebSocket upgrade
          console.log(`[${requestId}] [Sync Auth] No valid session found`);
          return new Response('Unauthorized: No active session found.', { status: 401 });
        }
        
        // Session is valid, proceed with WebSocket logic
        // Optionally: log user ID or other details from sessionData.user
        console.log(`[${requestId}] [Sync Auth] User ${sessionData.user?.id} authenticated for sync.`);
      } catch (error) {
        console.error(`[${requestId}] [Sync Auth] Error during session check:`, error);
        return new Response('Internal Server Error during authentication.', { status: 500 });
      }
      // --- END AUTH CHECK for /api/sync ---

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
      const doResponse = await obj.fetch(request);

      // Add CORS headers to the DO response if origin was allowed
      if (allowedOrigin) {
        const responseWithCors = new Response(doResponse.body, doResponse);
        responseWithCors.headers.set('Access-Control-Allow-Origin', allowedOrigin);
        responseWithCors.headers.set('Access-Control-Allow-Credentials', 'true');
        // Add Vary header to indicate that the response depends on the Origin header
        responseWithCors.headers.append('Vary', 'Origin'); 
        console.log(`[${requestId}] [Sync CORS] Added CORS headers for origin: ${allowedOrigin}`);
        return responseWithCors;
      } else {
        // Return the original DO response if origin wasn't explicitly allowed (e.g., missing origin header)
        return doResponse;
      }
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