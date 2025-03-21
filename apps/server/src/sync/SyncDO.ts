import type { TableChange } from '@repo/sync-types';
import type { Env, ExecutionContext } from '../types/env';
import type { DurableObjectState, WebSocket } from '../types/cloudflare';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import { createMinimalContext } from '../types/hono';
import { SyncStateManager } from './state-manager';
import { performInitialSync } from './initial-sync';
import { 
  ServerMessage,
  ClientMessage,
  CltMessageType,
} from '@repo/sync-types';

// Add type for message handler function
type MessageHandlerFn<T extends ClientMessage> = (message: T) => Promise<void>;

const MODULE_NAME = 'SyncDO';

// WebSocket ready states
const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
} as const;

/**
 * SyncDO (Sync Durable Object) is a thin wrapper that:
 * 1. Handles DO lifecycle (fetch, webSocket events)
 * 2. Coordinates sync process
 * 3. Provides basic error handling
 */
export class SyncDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private syncId: string;
  private webSocket: WebSocket | null = null;
  private stateManager: SyncStateManager;
  private context: MinimalContext;
  // Add message handlers map
  private messageHandlers = new Map<CltMessageType, MessageHandlerFn<ClientMessage>>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.syncId = state.id.toString();
    
    syncLogger.debug('SyncDO initialized', {
      syncId: this.syncId
    }, MODULE_NAME);
    
    // Create execution context
    const executionCtx: ExecutionContext = {
      waitUntil: (promise: Promise<any>) => this.state.waitUntil(promise),
      passThroughOnException: () => {},
      props: undefined
    };
    
    // Initialize context and state manager
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
      syncLogger.error('Replication init failed', {
        syncId: this.syncId,
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Send a message to the client
   */
  private async sendMessage(message: any): Promise<void> {
    if (this.webSocket && this.webSocket.readyState === WS_READY_STATE.OPEN) {
      this.webSocket.send(JSON.stringify(message));
    } else {
      syncLogger.warn('Cannot send message, WebSocket not open', { 
        messageType: message.type 
      }, MODULE_NAME);
    }
  }

  // Create a minimal context for operations
  private getContext(): MinimalContext {
    return this.context;
  }

  /**
   * Send a message to the client using type-safe interface
   */
  async send(message: ServerMessage): Promise<void> {
    if (this.webSocket && this.webSocket.readyState === WS_READY_STATE.OPEN) {
      syncLogger.debug('Sent message to client:', {
        type: message.type,
        messageId: message.messageId
      }, MODULE_NAME);
      this.webSocket.send(JSON.stringify(message));
    } else {
      syncLogger.warn('Cannot send message, WebSocket not open:', {
        type: message.type,
        messageId: message.messageId,
        connected: this.webSocket?.readyState === WS_READY_STATE.OPEN
      }, MODULE_NAME);
    }
  }

  /**
   * Register a handler for a specific message type
   */
  onMessage<T extends CltMessageType>(
    type: T,
    handler: MessageHandlerFn<ClientMessage>
  ): void {
    this.messageHandlers.set(type, handler);
    syncLogger.debug('Registered message handler:', { type }, MODULE_NAME);
  }

  /**
   * Remove a message handler
   */
  removeHandler(type: CltMessageType): void {
    this.messageHandlers.delete(type);
    syncLogger.debug('Removed message handler:', { type }, MODULE_NAME);
  }

  /**
   * Remove all message handlers
   */
  clearHandlers(): void {
    this.messageHandlers.clear();
    syncLogger.debug('Cleared all message handlers', undefined, MODULE_NAME);
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.webSocket?.readyState === WS_READY_STATE.OPEN;
  }

  /**
   * Handle inbound request (HTTP or WebSocket)
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const clientId = url.searchParams.get('clientId');
    const lsn = url.searchParams.get('lsn');
    
    syncLogger.debug('Fetch request', {
      syncId: this.syncId,
      isWebSocket: request.headers.get('Upgrade') === 'websocket',
      clientId: clientId || 'missing',
      hasLSN: !!lsn
    }, MODULE_NAME);

    if (!clientId) {
      syncLogger.error('Client ID missing in request', undefined, MODULE_NAME);
      return new Response('Missing clientId parameter', { status: 400 });
    }

    if (!lsn) {
      syncLogger.error('LSN missing in request', undefined, MODULE_NAME);
      return new Response('Missing lsn parameter', { status: 400 });
    }

    // Validate LSN format (X/Y where X and Y are hexadecimal)
    const isValidLSN = (lsn: string): boolean => /^[0-9A-F]+\/[0-9A-F]+$/i.test(lsn) || lsn === '0/0';
    if (!isValidLSN(lsn)) {
      syncLogger.error('Invalid LSN format', { lsn }, MODULE_NAME);
      return new Response('Invalid LSN format', { status: 400 });
    }

    syncLogger.info('Request parameters', { 
      clientId, 
      lsnFormat: lsn === '0/0' ? 'zero' : 'standard'
    }, MODULE_NAME);

    // Check if it's a WebSocket connection upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      syncLogger.info('WebSocket connection', { 
        clientId,
        status: 'accepting'
      }, MODULE_NAME);
      
      try {
        // Create WebSocket pair
        // @ts-ignore: WebSocketPair is defined in Cloudflare Workers runtime
        const pair = new WebSocketPair();
        const clientSocket = pair[0];
        const serverSocket = pair[1];
        
        // Accept the connection on the server side
        serverSocket.accept();
        
        // Store the WebSocket for later use
        this.webSocket = serverSocket;
        
        syncLogger.debug('WebSocket ready', { 
          clientId,
          readyState: serverSocket.readyState 
        }, MODULE_NAME);

        // Log whenever we receive a message
        serverSocket.addEventListener('message', (event: { data: any }) => {
          try {
            const data = typeof event.data === 'string' 
              ? JSON.parse(event.data) 
              : JSON.parse(new TextDecoder().decode(event.data));
            
            syncLogger.debug('WS message', {
              clientId,
              type: data.type
            }, MODULE_NAME);
            
            // Process the message with registered handlers if available
            const handler = this.messageHandlers.get(data.type);
            if (handler) {
              handler(data).catch(error => {
                syncLogger.error('Message handler error', {
                  clientId,
                  type: data.type,
                  error: error instanceof Error ? error.message : String(error)
                }, MODULE_NAME);
              });
            }
            // If no handler is registered, we just log it but don't warn
            // This allows the modules to use their own message handling logic (like waitForMessage)
          } catch (error) {
            syncLogger.error('WS message parse error', {
              clientId,
              error: error instanceof Error ? error.message : String(error)
            }, MODULE_NAME);
          }
        });

        // Set up close event handler
        serverSocket.addEventListener('close', (event: { code: number, reason: string }) => {
          syncLogger.info('WebSocket closed', { 
            clientId,
            code: event.code
          }, MODULE_NAME);
          
          // Mark client as inactive
          this.state.waitUntil(
            (async () => {
              try {
                syncLogger.debug('Connection cleanup started', { clientId }, MODULE_NAME);
                await this.stateManager.cleanupConnection();
                syncLogger.debug('Connection cleanup completed', { clientId }, MODULE_NAME);
              } catch (error) {
                syncLogger.error('Connection cleanup failed', {
                  clientId,
                  error: error instanceof Error ? error.message : String(error)
                }, MODULE_NAME);
              }
            })()
          );
          
          this.webSocket = null;
        });

        // Set up error event handler
        serverSocket.addEventListener('error', (event: { error: any }) => {
          syncLogger.error('WebSocket error', { 
            clientId,
            error: event.error
          }, MODULE_NAME);
        });

        // Create proper minimal context for operations
        const context = this.getContext();

        // Since the URL already contains clientId and LSN, initiate sync directly
        syncLogger.info('Initiating sync', { 
          clientId,
          lsn: lsn === '0/0' ? '0/0' : 'specified'
        }, MODULE_NAME);
        
        // Immediately register client and start sync process in background
        this.state.waitUntil(
          (async () => {
            try {
              // First register the client and update LSN
              await this.stateManager.registerClient(clientId);
              await this.stateManager.updateClientLSN(clientId, lsn);
              await this.stateManager.initializeConnection();
              await this.init();
              
              // Pass the raw WebSocket to performInitialSync
              // Let the module manage its own message handling
              await performInitialSync(
                context,
                serverSocket,
                this.stateManager,
                clientId
              );
              
              syncLogger.info('Sync completed', { clientId }, MODULE_NAME);
            } catch (error) {
              syncLogger.error('Sync failed', {
                clientId,
                error: error instanceof Error ? error.message : String(error)
              }, MODULE_NAME);
              
              // Try to close the connection with an error code if something went wrong
              try {
                if (serverSocket.readyState === 1) { // Open
                  serverSocket.close(1011, 'Internal server error during sync');
                }
              } catch (closeError) {
                syncLogger.error('Error closing WebSocket connection', {
                  clientId,
                  error: closeError instanceof Error ? closeError.message : String(closeError)
                }, MODULE_NAME);
              }
            }
          })()
        );

        return new Response(null, {
          status: 101,
          webSocket: clientSocket
        });
      } catch (err) {
        syncLogger.error('WebSocket setup failed', {
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

    // All other requests are not supported
    return new Response('This endpoint only supports WebSocket connections', { 
      status: 426, // Upgrade Required 
      headers: { 'Upgrade': 'websocket' } 
    });
  }
} 