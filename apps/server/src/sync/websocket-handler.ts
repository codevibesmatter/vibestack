import type { Env } from '../types/env';
import type { MinimalContext } from '../types/hono';
import type { 
  SrvMessageType,
  CltMessageType,
  TableChange
} from '@repo/sync-types';
import { syncLogger } from '../middleware/logger';
import { processMessage, type MessageContext, type MessageSender } from './message-handler';
import { SyncStateManager } from './state-manager';
import type { DurableObjectState } from '@cloudflare/workers-types';

/**
 * Context for WebSocket handlers
 */
export interface WebSocketContext {
  stateManager: SyncStateManager;
  context: MinimalContext;
  env: Env;
  init: () => Promise<void>;
}

/**
 * WebSocket implementation of MessageSender
 */
export class WebSocketMessageSender implements MessageSender {
  private ws: WebSocket;
  private clientId: string;

  constructor(ws: WebSocket, clientId: string) {
    this.ws = ws;
    this.clientId = clientId;
  }

  async send(message: { type: SrvMessageType; messageId: string; timestamp: number }): Promise<void> {
    const isConnected = this.isConnected();
    syncLogger.info('Attempting to send message', {
      messageType: message.type,
      clientId: this.clientId,
      isConnected,
      readyState: this.ws.readyState
    });

    if (isConnected) {
      try {
        this.ws.send(JSON.stringify(message));
        syncLogger.info('Message sent successfully', {
          messageType: message.type,
          clientId: this.clientId
        });
      } catch (err) {
        syncLogger.error('Failed to send message', {
          messageType: message.type,
          clientId: this.clientId,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err;
      }
    } else {
      syncLogger.warn('Cannot send message - WebSocket not connected', {
        messageType: message.type,
        clientId: this.clientId,
        readyState: this.ws.readyState
      });
    }
  }

  isConnected(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}

/**
 * Handle WebSocket upgrade and connection setup
 */
export async function handleWebSocketUpgrade(
  context: WebSocketContext,
  request: Request,
  state: DurableObjectState
): Promise<{ response: Response; webSocket: WebSocket | null }> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('clientId');
  
  if (!clientId) {
    return {
      response: new Response('Client ID is required', { status: 400 }),
      webSocket: null
    };
  }
  
  const { 0: client, 1: server } = new WebSocketPair();
  
  // Accept the WebSocket and make it hibernatable
  state.acceptWebSocket(server);
  
  // Register client in state manager
  await context.stateManager.registerClient(clientId);
  
  // Initialize sync state
  await context.init();

  // Create message sender for initial sync
  const sender = new WebSocketMessageSender(server, clientId);
  
  // Send initial sync message
  try {
    const serverLSN = await context.stateManager.getLSN() || '0/0';
    const initMessage = {
      type: 'srv_sync_init' as SrvMessageType,
      clientId,
      messageId: `srv_${Date.now()}`,
      timestamp: Date.now(),
      serverLSN
    };
    
    await sender.send(initMessage);
    syncLogger.info('Sent sync init message', { clientId, serverLSN });
  } catch (err) {
    syncLogger.error('Failed to send sync init message:', {
      clientId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  
  return {
    response: new Response(null, {
      status: 101,
      webSocket: client
    }),
    webSocket: server
  };
}

/**
 * Handle WebSocket message events
 */
export async function handleWebSocketMessage(
  context: WebSocketContext,
  ws: WebSocket,
  message: string | ArrayBuffer
): Promise<void> {
  try {
    const data = JSON.parse(message as string) as { type: CltMessageType; messageId: string; timestamp: number };
    const clientId = await context.stateManager.getClientId();
    
    if (!clientId) {
      syncLogger.error('No client ID in state manager');
      return;
    }

    // Create message context
    const messageContext: MessageContext = {
      clientId,
      context: context.context,
      lastLSN: await context.stateManager.getLSN(),
      updateLSN: (lsn: string) => context.stateManager.setLSN(lsn)
    };

    // Process the message
    await processMessage(
      data,
      messageContext,
      new WebSocketMessageSender(ws, clientId)
    );
  } catch (err) {
    syncLogger.error('Failed to process message:', {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Handle WebSocket close events
 */
export async function handleWebSocketClose(
  context: WebSocketContext,
  ws: WebSocket,
  code: number,
  reason: string,
  wasClean: boolean
): Promise<void> {
  const clientId = await context.stateManager.getClientId();
  
  if (clientId) {
    syncLogger.info('WebSocket closed:', {
      clientId,
      code,
      reason: reason || 'no reason given',
      wasClean
    });
    
    // Unregister client when connection closes
    await context.stateManager.unregisterClient();
  }
}

/**
 * Handle WebSocket error events
 */
export async function handleWebSocketError(
  context: WebSocketContext,
  ws: WebSocket,
  error: Error
): Promise<void> {
  syncLogger.error('WebSocket error', error);
  
  const clientId = await context.stateManager.getClientId();
  if (clientId) {
    syncLogger.info('Client disconnected due to error', { clientId });
    // Unregister client when connection errors
    await context.stateManager.unregisterClient();
  } else {
    syncLogger.info('WebSocket error for unknown client');
  }
  
  // Track error
  context.stateManager.trackError(error);
} 