import type { TableChange } from '@repo/sync-types';
import type { Env, ExecutionContext } from '../types/env';
import type { DurableObjectState, WebSocket } from '../types/cloudflare';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import { 
  handleWebSocketUpgrade,
  type WebSocketContext,
  WebSocketMessageHandler
} from './websocket-handler';
import { SyncStateManager } from './state-manager';
import { createMinimalContext } from '../types/hono';
import { getDBClient } from '../lib/db';
import { performInitialSync } from './initial-sync';

const MODULE_NAME = 'DO';

/**
 * SyncDO (Sync Durable Object) is a thin wrapper that:
 * 1. Handles DO lifecycle (fetch, webSocket events)
 * 2. Coordinates between modules (WebSocket, Message, State)
 * 3. Provides basic error handling
 */
export class SyncDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private syncId: string;
  private webSocket: WebSocket | null = null;
  private stateManager: SyncStateManager;
  private context: MinimalContext;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.syncId = state.id.toString();
    
    // Create execution context
    const executionCtx: ExecutionContext = {
      waitUntil: (promise: Promise<any>) => this.state.waitUntil(promise),
      passThroughOnException: () => {},
      props: undefined
    };
    
    // Initialize managers with MinimalContext
    this.context = createMinimalContext(env, executionCtx);
    this.stateManager = new SyncStateManager(this.context, state);
  }

  /**
   * Initialize replication if needed
   */
  private async init() {
    try {
      const id = this.env.REPLICATION.idFromName('replication');
      const replication = this.env.REPLICATION.get(id);
      const response = await replication.fetch(new Request('http://internal/api/replication/init'));
      
      if (!response.ok) {
        throw new Error(`Failed to start replication: ${response.statusText}`);
      }
    } catch (err) {
      syncLogger.error('❌ SyncDO lifecycle: Replication init failed', {
        syncId: this.syncId,
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Handle HTTP requests to the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    syncLogger.info('📥 SyncDO lifecycle: Fetch called', {
      syncId: this.syncId,
      isWebSocket: request.headers.get('Upgrade') === 'websocket'
    }, MODULE_NAME);

    const url = new URL(request.url);
    
    // Handle WebSocket connections
    if (request.headers.get('Upgrade') === 'websocket') {
      try {
        const context: WebSocketContext = {
          stateManager: this.stateManager,
          context: this.context,
          env: this.env,
          init: this.init.bind(this)
        };
        
        // Get client info from URL
        const url = new URL(request.url);
        const clientId = url.searchParams.get('clientId');
        const clientLSN = url.searchParams.get('lsn');

        // Validate client ID
        if (!clientId) {
          syncLogger.error('Client ID missing in request', undefined, MODULE_NAME);
          return new Response('Client ID is required', { status: 400 });
        }

        // Validate LSN format
        if (!clientLSN) {
          syncLogger.error('LSN missing in request', undefined, MODULE_NAME);
          return new Response('LSN is required', { status: 400 });
        }

        // LSN format validation (X/Y where X and Y are hexadecimal)
        const isValidLSN = (lsn: string): boolean => /^[0-9A-F]+\/[0-9A-F]+$/i.test(lsn) || lsn === '0/0';
        if (!isValidLSN(clientLSN)) {
          syncLogger.error('Invalid LSN format', { clientLSN }, MODULE_NAME);
          return new Response('Invalid LSN format', { status: 400 });
        }

        const { response, webSocket } = await handleWebSocketUpgrade(
          context,
          request,
          this.state
        );
        
        if (webSocket) {
          this.webSocket = webSocket;
          
          // Initialize client state with provided LSN
          await this.stateManager.registerClient(clientId);
          await this.stateManager.updateClientLSN(clientId, clientLSN);
          await this.stateManager.initializeConnection();
          await this.init();

          // Start sync process
          const messageHandler = new WebSocketMessageHandler(webSocket, clientId);
          this.state.waitUntil(performInitialSync(
            this.context,
            messageHandler,
            this.stateManager,
            clientId
          ));
        }
        
        return response;
      } catch (err) {
        syncLogger.error('❌ SyncDO lifecycle: WebSocket setup failed', {
          syncId: this.syncId,
          error: err instanceof Error ? err.message : String(err)
        }, MODULE_NAME);
        return new Response('Internal Server Error', { status: 500 });
      }
    }

    // Handle metrics request
    if (url.pathname.endsWith('/metrics')) {
      const metrics = await this.stateManager.getMetrics();
      const errors = await this.stateManager.getErrors();
      
      return new Response(JSON.stringify({
        ...metrics,
        errors: errors.map(err => ({
          message: err.message,
          stack: err.stack
        })),
        lastLSN: this.stateManager.getLSN(),
        lastWakeTime: metrics.lastWakeTime
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
} 