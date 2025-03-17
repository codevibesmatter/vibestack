import type { TableChange } from '@repo/sync-types';
import type { Env } from '../types/env';
import type { ExecutionContext } from '@cloudflare/workers-types';
import type { MinimalContext } from '../types/hono';
import { Client } from '@neondatabase/serverless';
import { syncLogger } from '../middleware/logger';
import { 
  handleWebSocketMessage, 
  handleWebSocketClose, 
  handleWebSocketError,
  handleWebSocketUpgrade,
  type WebSocketContext 
} from './websocket-handler';
import { checkAndSendChanges, fetchChangesForClient } from './server-changes';
import { SyncStateManager } from './state-manager';
import { createMinimalContext } from '../types/hono';
import { getDBClient } from '../lib/db';

/**
 * SyncDO (Sync Durable Object) is the main class responsible for handling WebSocket connections
 * and synchronization between clients and the server.
 * 
 * It leverages Cloudflare's Durable Objects and WebSocket Hibernation API to provide:
 * - Real-time synchronization of changes
 * - Efficient resource management through hibernation
 * - Automatic wake-up when messages are received
 * - Connection state management
 * 
 * This implementation has been simplified to:
 * - Store client data directly on the WebSocket object
 * - Use KV for client registration across hibernation
 * - Simplify message processing
 */
export class SyncDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private syncId: string;
  private webSocket: WebSocket | null = null;
  private stateManager: SyncStateManager;
  private context: MinimalContext;
  private static readonly LAST_ACTIVE_KEY = 'last_active_timestamp';
  private lastActive: number;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.syncId = state.id.toString();
    
    // Initialize last active timestamp
    this.lastActive = Date.now();
    
    // Create execution context
    const executionCtx: ExecutionContext = {
      waitUntil: (promise: Promise<any>) => this.state.waitUntil(promise),
      passThroughOnException: () => {},
      props: undefined
    };
    
    // Initialize managers with MinimalContext
    this.context = createMinimalContext(env, executionCtx);
    this.stateManager = new SyncStateManager(this.context, state);
    
    // Initialize storage and check last active time
    this.state.waitUntil(this.initializeStorage());
  }

  private async initializeStorage() {
    // Get last active timestamp from storage
    const storedLastActive = await this.state.storage.get<number>(SyncDO.LAST_ACTIVE_KEY);
    const now = Date.now();
    
    // Log wake-up if we have a last active timestamp
    if (storedLastActive) {
      const sleepDuration = now - storedLastActive;
      syncLogger.info('🌅 SyncDO woken up', {
        syncId: this.syncId,
        sleepDurationMs: sleepDuration,
        sleepDurationSec: Math.round(sleepDuration / 1000)
      });
    }
    
    // Update last active timestamp
    await this.state.storage.put(SyncDO.LAST_ACTIVE_KEY, now);
  }

  /**
   * Initialize the database connection and start replication
   * This is called lazily when needed
   */
  private async init() {
    try {
      // Start replication if not already started
      await this.startReplication();
    } catch (err) {
      syncLogger.error('❌ SyncDO: Failed to initialize instance:', err);
      throw err;
    }
  }

  /**
   * Start the replication process by triggering the ReplicationDO
   * Uses exponential backoff for retries
   */
  private async startReplication() {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Get ReplicationDO instance
        const id = this.env.REPLICATION.idFromName('replication');
        const replication = this.env.REPLICATION.get(id);

        // Trigger replication initialization
        const response = await replication.fetch(new Request('http://internal/api/replication/init'));
        if (!response.ok) {
          throw new Error(`Failed to start replication: ${response.statusText}`);
        }

        syncLogger.info('✅ SyncDO: Replication initialized');
        return;

      } catch (err) {
        const isLastAttempt = attempt === maxRetries - 1;
        if (isLastAttempt) {
          syncLogger.error('❌ SyncDO: Failed to start replication after all retries:', err);
          throw err;
        } else {
          const delay = baseDelay * Math.pow(2, attempt);
          syncLogger.info(`SyncDO: Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
  }

  /**
   * Handle HTTP requests to the Durable Object
   * This includes WebSocket upgrades and API endpoints
   */
  async fetch(request: Request): Promise<Response> {
    syncLogger.info('📥 SyncDO lifecycle: Fetch called', {
      syncId: this.syncId,
      url: request.url,
      method: request.method,
      isWebSocket: request.headers.get('Upgrade') === 'websocket',
      hasWebSocket: !!this.webSocket
    });

    const url = new URL(request.url);
    
    // Handle WebSocket connections
    if (request.headers.get('Upgrade') === 'websocket') {
      try {
        syncLogger.info('SyncDO handling WebSocket connection', {
          syncId: this.syncId,
          clientId: url.searchParams.get('clientId')
        });
        
        // Create a new disposable client
        const dbClient = getDBClient(this.context);
        
        // Create context for the handler
        const context: WebSocketContext = {
          stateManager: this.stateManager,
          context: this.context,
          env: this.env,
          init: this.init.bind(this)
        };
        
        // Use our module to handle the WebSocket upgrade
        const { response, webSocket } = await handleWebSocketUpgrade(
          context,
          request,
          this.state
        );
        
        // Store the WebSocket
        if (webSocket) {
          this.webSocket = webSocket;
          
          // Initialize replication now that we have an active client
          await this.init();
        }
        
        return response;
      } catch (err) {
        syncLogger.error('Failed to handle WebSocket upgrade', err);
        return new Response('Internal Server Error', { status: 500 });
      }
    }

    // Handle metrics request
    if (url.pathname.endsWith('/metrics')) {
      return new Response(JSON.stringify({
        connections: this.stateManager.getMetrics().connections,
        errors: Object.fromEntries(this.stateManager.getMetrics().errors),
        activeClient: this.webSocket?.clientData?.clientId,
        lastLSN: this.stateManager.getLSN()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Test endpoint for fetching changes
    if (url.pathname.endsWith('/test-changes')) {
      const lsn = url.searchParams.get('lsn');
      const clientId = url.searchParams.get('clientId');
      
      if (!lsn || !clientId) {
        return new Response(JSON.stringify({ error: 'LSN and clientId parameters are required' }), { 
          status: 400
        });
      }

      try {
        const result = await fetchChangesForClient(
          this.context,
          lsn as string,
          clientId as string
        );

        syncLogger.info('Test endpoint response:', {
          clientId,
          fromLSN: lsn,
          lastLSN: result.lastLSN,
          changeCount: result.changes.length
        });

        return new Response(JSON.stringify(result));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        syncLogger.error('Error in test endpoint:', { error, clientId, lsn });
        
        return new Response(JSON.stringify({ 
          error: 'Error fetching changes',
          details: error
        }), { 
          status: 500
        });
      }
    }

    // Handle new changes notification
    if (url.pathname.endsWith('/new-changes') && request.method === 'POST') {
      const firstLSN = url.searchParams.get('firstLSN');
      const lastLSN = url.searchParams.get('lastLSN');
      
      // If no active WebSocket, return Gone status
      if (!this.webSocket || this.webSocket.readyState !== WebSocket.OPEN) {
        return new Response('Client disconnected', { status: 410 });
      }
      
      if (!firstLSN || !lastLSN) {
        return new Response('LSN parameters are required', { status: 400 });
      }

      if (!this.webSocket.clientData?.clientId) {
        return new Response('Client ID not found', { status: 400 });
      }
      
      try {
        // Get the pre-processed changes from the request body
        const body = await request.json() as { changes?: TableChange[] };
        if (!body?.changes || !Array.isArray(body.changes)) {
          return new Response('Invalid request body', { status: 400 });
        }
        
        const { changes } = body;
        const success = await checkAndSendChanges(
          this.webSocket,
          changes,
          lastLSN,
          this.stateManager.getLSN() || '0/0',
          this.webSocket.clientData.clientId
        );

        if (success) {
          this.stateManager.setLSN(lastLSN);
        }
        
        return new Response('OK');
      } catch (err) {
        syncLogger.error('Error handling new changes', err);
        return new Response('Error handling changes', { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  }
  
  // WebSocket event handlers for the Hibernation API
  
  /**
   * Handle WebSocket message events
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      // Create a promise for the message processing
      const processingPromise = handleWebSocketMessage(
        { 
          stateManager: this.stateManager,
          context: this.context,
          env: this.env, 
          init: () => this.init()
        },
        ws,
        message
      );

      // Use waitUntil to ensure processing completes
      this.state.waitUntil(processingPromise);

      // Also await the promise to handle any errors
      await processingPromise;
    } catch (err) {
      this.stateManager.trackError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }
  
  /**
   * Handle WebSocket close events
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    try {
      await handleWebSocketClose(
        { 
          stateManager: this.stateManager,
          context: this.context,
          env: this.env, 
          init: () => this.init()
        },
        ws,
        code,
        reason,
        wasClean
      );
      this.webSocket = null;
    } catch (err) {
      this.stateManager.trackError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }
  
  /**
   * Handle WebSocket error events
   */
  async webSocketError(ws: WebSocket, error: Error) {
    try {
      await handleWebSocketError(
        { 
          stateManager: this.stateManager,
          context: this.context,
          env: this.env, 
          init: () => this.init()
        },
        ws,
        error
      );
      this.webSocket = null;
      this.stateManager.trackError(error);
    } catch (err) {
      this.stateManager.trackError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }
} 