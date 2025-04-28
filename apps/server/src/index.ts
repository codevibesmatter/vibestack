/// <reference path="../worker-configuration.d.ts" />

// Set up node polyfills first
import 'reflect-metadata';

// Import other dependencies
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import api from './api';
import { serverLogger } from './middleware/logger';
import { createStructuredLogger } from './middleware/logger';
import type { AppBindings } from './types/hono';
import type { Env, ExecutionContext } from './types/env';
import { SyncDO } from './sync/SyncDO';
import { ReplicationDO } from './replication/ReplicationDO';
import internalAuthApp from './auth/internal';

/**
 * Main API router for PUBLIC endpoints
 * Handles all HTTP routes under the /api path
 */
const apiApp = new Hono<AppBindings>().basePath('/api');

// Use our structured logger middleware
apiApp.use('*', createStructuredLogger());

// Mount public API routes
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
    console.log('Environment check:', {
      environment: env.ENVIRONMENT,
      isDevelopment: env.ENVIRONMENT === 'development',
      isProduction: env.ENVIRONMENT === 'production'
    });
    
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
      serverLogger.debug(`Routing to public API app for path: ${url.pathname}`);
      try {
        return await apiApp.fetch(request, env, ctx);
      } catch (error) {
        serverLogger.error('Error handling request', error);
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
      serverLogger.debug(`Routing to internal app for path: ${url.pathname}`);
      try {
        return await internalApp.fetch(request, env, ctx);
      } catch (error) {
        serverLogger.error('Error handling internal request', error);
        return new Response(JSON.stringify({ ok: false, error: { type: 'InternalServerError', message: 'Internal communication error' }}), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // No route matched
    serverLogger.debug('No route matched, returning 404');
    return new Response('Not Found', { status: 404 });
  }
};

export { SyncDO, ReplicationDO };
export default worker; 