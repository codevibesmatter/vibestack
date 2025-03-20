import { 
  ServerMessage,
  ClientMessage,
  CltMessageType,
  ClientChangesMessage,
  ClientReceivedMessage,
  ClientAppliedMessage,
  ClientHeartbeatMessage,
  TableChange
} from '@repo/sync-types';
import { syncLogger } from '../middleware/logger';
import { SERVER_DOMAIN_TABLES } from '@repo/dataforge/server-entities';
import type { Env } from '../types/env';
import type { MinimalContext } from '../types/hono';
import { SyncStateManager } from './state-manager';
import type { DurableObjectState, WebSocket } from '../types/cloudflare';
import { performInitialSync } from './initial-sync';
import { getDBClient } from '../lib/db';

const MODULE_NAME = 'websocket';
const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
} as const;

/**
 * Context for WebSocket handlers
 */
export interface WebSocketContext {
  stateManager: SyncStateManager;
  context: MinimalContext;
  env: Env;
  init: () => Promise<void>;
}

type MessageHandlerFn<T extends ClientMessage> = (message: T) => Promise<void>;

type MessageHandlers = {
  'clt_send_changes': MessageHandlerFn<ClientChangesMessage>;
  'clt_changes_received': MessageHandlerFn<ClientReceivedMessage>;
  'clt_changes_applied': MessageHandlerFn<ClientAppliedMessage>;
  'clt_heartbeat': MessageHandlerFn<ClientHeartbeatMessage>;
  'clt_error': MessageHandlerFn<ClientMessage & { type: 'clt_error' }>;
  'clt_init_received': MessageHandlerFn<ClientMessage & { type: 'clt_init_received' }>;
  'clt_init_processed': MessageHandlerFn<ClientMessage & { type: 'clt_init_processed' }>;
  'clt_sync_request': MessageHandlerFn<ClientMessage & { type: 'clt_sync_request' }>;
};

/**
 * Central WebSocket message handler that provides type-safe message routing
 */
export class WebSocketMessageHandler {
  private handlers = new Map<CltMessageType, MessageHandlerFn<ClientMessage>>();

  constructor(
    private ws: WebSocket,
    private clientId: string
  ) {
    // Set up the message listener
    this.ws.addEventListener('message', async (event) => {
      const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      let parsedMessage: ClientMessage | undefined;
      
      try {
        parsedMessage = JSON.parse(data) as ClientMessage;
        const handler = this.handlers.get(parsedMessage.type);
        if (handler) {
          await handler(parsedMessage);
        } else {
          syncLogger.warn('No handler for message type:', { 
            type: parsedMessage.type 
          }, MODULE_NAME);
        }
      } catch (err) {
        syncLogger.error('Failed to process message:', {
          error: err instanceof Error ? err.message : String(err),
          messageType: parsedMessage?.type,
          rawData: data
        }, MODULE_NAME);
      }
    });
  }

  /**
   * Send a message to the client
   */
  async send(message: ServerMessage): Promise<void> {
    if (this.isConnected()) {
      syncLogger.debug('Sent message to client:', {
        type: message.type,
        messageId: message.messageId
      }, MODULE_NAME);
      this.ws.send(JSON.stringify(message));
    } else {
      syncLogger.warn('Cannot send message, WebSocket not open:', {
        type: message.type,
        messageId: message.messageId,
        connected: this.isConnected()
      }, MODULE_NAME);
    }
  }

  /**
   * Register a handler for a specific message type
   */
  onMessage<T extends CltMessageType>(
    type: T,
    handler: MessageHandlers[T]
  ): void {
    this.handlers.set(type, handler as MessageHandlerFn<ClientMessage>);
    syncLogger.debug('Registered message handler:', { type }, MODULE_NAME);
  }

  /**
   * Remove a message handler
   */
  removeHandler(type: CltMessageType): void {
    this.handlers.delete(type);
    syncLogger.debug('Removed message handler:', { type }, MODULE_NAME);
  }

  /**
   * Remove all message handlers
   */
  clearHandlers(): void {
    this.handlers.clear();
    syncLogger.debug('Cleared all message handlers', undefined, MODULE_NAME);
  }

  /**
   * Close the WebSocket connection
   */
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
    this.clearHandlers();
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.ws.readyState === WS_READY_STATE.OPEN;
  }
}

/**
 * Handle WebSocket upgrade and connection setup
 */
export async function handleWebSocketUpgrade(
  context: WebSocketContext,
  request: Request,
  state: DurableObjectState
): Promise<{ response: Response; webSocket?: WebSocket }> {
  syncLogger.info('WebSocket upgrade request received', {
    url: request.url,
    headers: Object.fromEntries(request.headers)
  }, MODULE_NAME);

  // Get client info from URL
  const url = new URL(request.url);
  const clientId = url.searchParams.get('clientId');
  
  if (!clientId) {
    syncLogger.error('Client ID missing in request', undefined, MODULE_NAME);
    return {
      response: new Response('Client ID is required', { status: 400 })
    };
  }
  
  const { 0: client, 1: server } = new WebSocketPair();
  
  // Accept the WebSocket and make it hibernatable
  state.acceptWebSocket(server);
  
  // Create message handler
  const messageHandler = new WebSocketMessageHandler(server, clientId);
    
  return {
    response: new Response(null, {
      status: 101,
      webSocket: client
    }),
    webSocket: server
  };
}

// Re-export message types for convenience
export type { 
  ServerMessage,
  ClientMessage,
  MessageHandlerFn,
  MessageHandlers
}; 