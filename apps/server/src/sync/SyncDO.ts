import type { TableChange } from '@repo/sync-types';
import type { Env, ExecutionContext } from '../types/env';
import type { DurableObjectState, WebSocket } from '../types/cloudflare';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import { createMinimalContext } from '../types/hono';
import { SyncStateManager } from './state-manager';
import { performInitialSync } from './initial-sync';
import { performCatchupSync } from './server-changes';
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
  // Add a separate map for temporary handlers used by waitForMessage
  private tempMessageHandlers = new Map<string, (message: any) => void>();

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
   * Initialize replication if needed and wait for initial poll
   */
  private async init() {
    try {
      const id = this.env.REPLICATION.idFromName('replication');
      const replication = this.env.REPLICATION.get(id);
      const response = await replication.fetch(new Request('http://internal/api/replication/init'));
      
      if (!response.ok) {
        throw new Error(`Failed to start replication: ${response.statusText}`);
      }
      
      // Wait for initial poll to complete
      const waitResponse = await replication.fetch(new Request('http://internal/api/replication/wait-for-initial-poll'));
      
      if (!waitResponse.ok) {
        throw new Error(`Failed to wait for initial poll: ${waitResponse.statusText}`);
      }
      
      syncLogger.info('Replication initialization and initial poll completed', {
        syncId: this.syncId
      }, MODULE_NAME);
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
   * Wait for a message of a specific type with optional filter
   */
  waitForMessage(
    type: CltMessageType,
    filter?: (msg: any) => boolean,
    timeoutMs: number = 30000 // Default timeout of 30 seconds
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.webSocket || this.webSocket.readyState !== WS_READY_STATE.OPEN) {
        return reject(new Error('WebSocket not open'));
      }
      
      // Flag to track if the promise has been resolved/rejected
      let isCompleted = false;
      
      // Create a unique handler ID for this specific wait operation
      const handlerId = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Create timeout to avoid hanging indefinitely
      const timeoutId = setTimeout(() => {
        if (isCompleted) return;
        isCompleted = true;
        
        // Remove the temporary message handler
        this.tempMessageHandlers.delete(handlerId);
        
        syncLogger.error('Timeout waiting for message', { 
          type,
          timeoutMs 
        }, MODULE_NAME);
        
        reject(new Error(`Timeout waiting for message type: ${type}`));
      }, timeoutMs);

      // Create a temporary message handler for this specific message type
      const messageHandler = (message: any) => {
        // Skip processing if we're already done
        if (isCompleted) return;
        
        // Apply filter if provided
        if (filter && !filter(message)) {
          return; // This message doesn't match our filter criteria
        }
        
        // Message matches what we're waiting for
        clearTimeout(timeoutId);
        isCompleted = true;
        
        // Remove the temporary message handler
        this.tempMessageHandlers.delete(handlerId);
        
        // Resolve with the message
        resolve(message);
      };
      
      // Register temporary message handler
      this.tempMessageHandlers.set(handlerId, messageHandler);
      
      // Also register to actual type so it's processed by the message listener
      const existingHandler = this.messageHandlers.get(type);
      const wrappedHandler: MessageHandlerFn<ClientMessage> = async (message) => {
        // Call existing handler if any
        if (existingHandler) {
          await existingHandler(message);
        }
        
        // Process through all temporary handlers for this type
        for (const [id, handler] of this.tempMessageHandlers.entries()) {
          if (id.startsWith(type)) {
            handler(message);
          }
        }
      };
      
      // Set or update the handler
      this.messageHandlers.set(type, wrappedHandler);
    });
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
            
            syncLogger.debug('Message Received', {
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
            syncLogger.error('Message parse error', {
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

        // Check if the client already has a recent LSN and needs catchup sync
        const needsCatchupSync = lsn !== '0/0';
        
        syncLogger.info('Initiating sync', { 
          clientId,
          lsn,
          syncType: needsCatchupSync ? 'catchup' : 'initial'
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
              
              if (needsCatchupSync) {
                // Perform catchup sync for clients with an existing LSN
                syncLogger.info('Starting catchup sync', { clientId, startLSN: lsn }, MODULE_NAME);
                await performCatchupSync(
                  context,
                  clientId,
                  lsn,
                  this // Pass 'this' as the WebSocketHandler implementation
                );
                
                // Update client sync state to live after catchup completes successfully
                await this.stateManager.updateClientSyncState(clientId, 'live');
              } else {
                // Perform initial sync for new clients
                syncLogger.info('Starting initial sync', { clientId }, MODULE_NAME);
                await performInitialSync(
                  context,
                  this, // Pass 'this' as the WebSocketHandler implementation
                  this.stateManager,
                  clientId
                );
              }
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