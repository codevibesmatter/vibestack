/**
 * SyncDO.ts - Improved Sync Durable Object
 * 
 * This is a refactored version of SyncDO with clearer separation of concerns:
 * - Request routing
 * - Connection management
 * - Sync strategy determination
 * - Module delegation
 * - State transitions
 */

import { SyncStateManager } from './state-manager';
import { performInitialSync } from './initial-sync';
import { performCatchupSync, sendLiveChanges, createLiveSyncConfirmation, fetchAndProcessChanges } from './server-changes';
import { processClientChanges } from './client-changes';
import type { 
  ServerMessage, 
  ClientMessage,
  ClientChangesMessage,
  ServerSyncStatsMessage
} from '@repo/sync-types';
import type { MinimalContext } from '../types/hono';
import type { Env } from '../types/env';
import { syncLogger } from '../middleware/logger';
import type { WebSocketHandler } from './types';
import { compareLSN, deduplicateChanges } from '../lib/sync-common';
import { getDBClient } from '../lib/db';
import type { TableChange } from '@repo/sync-types';

// WebSocket ready states
const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
};

const MODULE_NAME = 'SyncDO';

/**
 * Type of sync to perform based on client state
 */
enum SyncStrategy {
  INITIAL = 'initial',
  CATCHUP = 'catchup',
  LIVE = 'live'
}

/**
 * Helper function to extract query parameters from a request
 */
function getQueryParam(request: Request, name: string): string | null {
  const url = new URL(request.url);
  return url.searchParams.get(name);
}

/**
 * Check if LSN is in valid format
 */
function isValidLSN(lsn: string): boolean {
  // LSN is typically in format X/X where X is a hexadecimal number
  return /^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/.test(lsn) || lsn === '0/0';
}

/**
 * SyncDO is responsible for managing WebSocket connections and sync flow
 */
export class SyncDO implements DurableObject, WebSocketHandler {
  private state: DurableObjectState;
  private env: Env;
  private webSocket: WebSocket | null = null;
  private stateManager: SyncStateManager;
  private clientId: string = '';
  private syncId: string;
  private messageHandlers: Map<ClientMessage['type'], Array<(message: ClientMessage) => Promise<void>>> = new Map();
  private messageQueue: Map<ClientMessage['type'], ClientMessage[]> = new Map();
  private waitingResolvers: Map<string, {
    resolve: (message: any) => void,
    reject: (error: Error) => void,
    timer: NodeJS.Timeout | null
  }> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    
    // Create context for state manager
    const context: MinimalContext = {
      env: this.env,
      executionCtx: {
        waitUntil: (promise: Promise<any>) => this.state.waitUntil(promise),
        passThroughOnException: () => {},
        props: undefined
      }
    };
    
    this.stateManager = new SyncStateManager(context, state as any);
    this.syncId = state.id.toString();
    
    // Register message handler for client changes
    this.onMessage('clt_send_changes', async (message: ClientMessage) => {
      syncLogger.info('Received client changes', {
        type: message.type,
        messageId: message.messageId
      }, MODULE_NAME);
      
      try {
        // Process client changes
        await processClientChanges(
          message as ClientChangesMessage,
          this.getContext(),
          this
        );
      } catch (error) {
        syncLogger.error('Error processing client changes', {
          error: error instanceof Error ? error.message : String(error)
        }, MODULE_NAME);
      }
    });
  }

  /**
   * Main handler for all requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    try {
      // Route requests based on path
      if (path === '/api/sync') {
        // This is the main WebSocket connect point from index.ts
        return this.handleWebSocketUpgrade(request);
      } else if (path.startsWith('/api/sync/ws')) {
        // Legacy path, also handle WebSocket
        return this.handleWebSocketUpgrade(request);
      } else if (path === '/api/sync/new-changes' || path === '/new-changes') {
        // Handle both paths for backward compatibility
        return this.handleNewChanges(request);
      } else if (path === '/api/sync/metrics' || path === '/metrics') {
        // Handle both paths for metrics too
        return this.handleMetrics();
      } else if (path === '/sync-stats' || path === '/api/sync/sync-stats') {
        // Handle sync stats messages from process-changes
        return this.handleSyncStats(request);
      } else {
        // No route matched
        return new Response('Not found', { status: 404 });
      }
    } catch (error) {
      syncLogger.error('Request handling error', {
        path,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }, MODULE_NAME);
      
      return new Response(JSON.stringify({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error)
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Handle WebSocket upgrade requests
   */
  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    // Extract parameters
    let clientId = getQueryParam(request, 'clientId');
    let clientLSN = getQueryParam(request, 'lsn');
    
    // Log request parameters
    syncLogger.info('WebSocket connection request', {
      clientId,
      lsn: clientLSN
    }, MODULE_NAME);
    
    // Basic validation
    if (!clientId) {
      return new Response('Missing clientId parameter', { status: 400 });
    }
    
    // Validate LSN if provided
    if (clientLSN && !isValidLSN(clientLSN)) {
      syncLogger.error('Invalid LSN format', {
        clientId,
        lsn: clientLSN
      }, MODULE_NAME);
      return new Response('Invalid LSN format', { status: 400 });
    }
    
    // If LSN is missing, default to initial sync with explicit 0/0
    if (!clientLSN) {
      clientLSN = '0/0';
      syncLogger.info('No LSN provided, will perform initial sync', {
        clientId
      }, MODULE_NAME);
    }
    
    // Set up WebSocket
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    
    // Store WebSocket and client ID
    this.webSocket = server;
    this.clientId = clientId;

    // Configure WebSocket
    server.accept();
    this.setupWebSocketEventHandlers(server);
    
    // Store the client LSN for use after connection is established
    const finalClientId = clientId;
    const finalClientLSN = clientLSN;
    
    // Start sync process AFTER connection is fully established
    this.state.waitUntil((async () => {
      try {
        // Wait a moment to ensure WebSocket connection is established
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Determine sync strategy and perform sync
        const { strategy, serverLSN } = await this.determineSyncStrategy(finalClientId, finalClientLSN);
        await this.performSync({ strategy, serverLSN }, finalClientId, finalClientLSN);
      } catch (error) {
        syncLogger.error('WebSocket sync error', {
          clientId: finalClientId,
          lsn: finalClientLSN,
          error: error instanceof Error ? error.message : String(error)
        }, MODULE_NAME);
        
        // Close WebSocket on error
        if (server.readyState === WS_READY_STATE.OPEN) {
          server.close(1011, 'Internal Server Error');
        }
      }
    })());
    
    // Return the client WebSocket IMMEDIATELY to establish the connection
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
  
  /**
   * Set up WebSocket event handlers
   */
  private setupWebSocketEventHandlers(ws: WebSocket): void {
    ws.addEventListener('message', async (event) => {
      await this.handleWebSocketMessage(event);
    });
    
    ws.addEventListener('close', (event) => {
      syncLogger.info('WebSocket closed', {
        clientId: this.clientId,
        code: event.code,
        reason: event.reason
      }, MODULE_NAME);
      
      // Mark client as inactive when connection closes
      this.state.waitUntil(
        (async () => {
          try {
            await this.stateManager.cleanupConnection();
          } catch (error) {
            syncLogger.error('Connection cleanup failed', {
              clientId: this.clientId,
              error: error instanceof Error ? error.message : String(error)
            }, MODULE_NAME);
          }
        })()
      );
      
      this.webSocket = null;
    });
    
    ws.addEventListener('error', (event) => {
      syncLogger.error('WebSocket error', {
        clientId: this.clientId
      }, MODULE_NAME);
      
      this.webSocket = null;
    });
  }
  
  /**
   * Handle incoming WebSocket messages
   */
  private async handleWebSocketMessage(event: MessageEvent): Promise<void> {
    try {
      const message = JSON.parse(event.data as string) as ClientMessage;
      
      // Store in message queue for waitForMessage
      if (!this.messageQueue.has(message.type)) {
        this.messageQueue.set(message.type, []);
      }
      this.messageQueue.get(message.type)!.push(message);
      
      // Check if someone is waiting for this message type
      this.checkWaitingResolvers(message.type, message);
      
      // Process handlers for this message type
      const handlers = this.messageHandlers.get(message.type) || [];
      for (const handler of handlers) {
        try {
          await handler(message);
        } catch (handlerError) {
          syncLogger.error('Handler error', {
            type: message.type,
            error: handlerError instanceof Error ? handlerError.message : String(handlerError)
          }, MODULE_NAME);
        }
      }
    } catch (error) {
      syncLogger.error('Message parse error', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
    }
  }
  
  /**
   * Check if any waiting resolvers match this message
   */
  private checkWaitingResolvers(type: string, message: ClientMessage): void {
    // Generate waitId
    const waitIds = Array.from(this.waitingResolvers.keys()).filter(id => 
      id.startsWith(`wait_${type}_`)
    );
    
    for (const waitId of waitIds) {
      const resolver = this.waitingResolvers.get(waitId);
      if (!resolver) continue;
      
      // Clear timer if exists
      if (resolver.timer) {
        clearTimeout(resolver.timer);
      }
      
      // Resolve with the message
      resolver.resolve(message);
      
      // Remove from waiting resolvers
      this.waitingResolvers.delete(waitId);
    }
  }
  
  /**
   * Determine which sync strategy to use based on client state
   */
  private async determineSyncStrategy(
    clientId: string, 
    clientLSN: string
  ): Promise<{ strategy: SyncStrategy, serverLSN: string }> {
    // Register the client
    await this.stateManager.registerClient(clientId);
    
    // Store the client's LSN
    await this.stateManager.updateClientLSN(clientId, clientLSN);
    
    // Message handler for client changes is already registered in the constructor
    
    // Get the current server LSN
    const serverLSN = await this.stateManager.getServerLSN();
    
    // If client has no LSN (0/0), it needs initial sync
    if (clientLSN === '0/0') {
      syncLogger.info('Client needs initial sync', {
        clientId
      }, MODULE_NAME);
      return { strategy: SyncStrategy.INITIAL, serverLSN };
    }
    
    // If client LSN is behind server LSN, client needs catchup sync
    if (compareLSN(clientLSN, serverLSN) < 0) {
      syncLogger.info('Client needs catchup sync', {
        clientId,
        clientLSN,
        serverLSN
      }, MODULE_NAME);
      return { strategy: SyncStrategy.CATCHUP, serverLSN };
    }
    
    // Client is up to date
    syncLogger.info('Client is up to date', {
      clientId,
      lsn: clientLSN
    }, MODULE_NAME);
    return { strategy: SyncStrategy.LIVE, serverLSN };
  }
  
  /**
   * Perform the appropriate sync based on determined strategy
   */
  private async performSync(
    { strategy, serverLSN }: { strategy: SyncStrategy, serverLSN: string },
    clientId: string,
    lsn: string
  ): Promise<void> {
    const context = this.getContext();
    
    switch (strategy) {
      case SyncStrategy.INITIAL:
        // Update sync state
        await this.stateManager.updateClientSyncState(clientId, 'initial');
        
        // Perform initial sync
        await performInitialSync(
          context,
          this,  // WebSocketHandler - we implement this interface now
          this.stateManager,
          clientId
        );
        break;
        
      case SyncStrategy.CATCHUP:
        // Update client's sync state in storage (this just updates internal state
        // and doesn't send any WebSocket messages)
        await this.stateManager.updateClientSyncState(clientId, 'catchup');
        
        // Perform catchup sync with both LSNs
        await performCatchupSync(
          context,
          clientId,
          lsn,           // Client LSN
          serverLSN,     // Server LSN - already retrieved by determineSyncStrategy
          this,
          this.stateManager
        );
        break;
        
      case SyncStrategy.LIVE:
        // Update sync state
        await this.stateManager.updateClientSyncState(clientId, 'live');
        
        // Send confirmation message for live sync
        const liveSyncMessage = createLiveSyncConfirmation(clientId, lsn);
        await this.send(liveSyncMessage);
        
        syncLogger.info('Live sync confirmed', {
          clientId,
          lsn
        }, MODULE_NAME);
        break;
    }
  }
  
  /**
   * Handle new changes notification
   */
  private async handleNewChanges(request: Request): Promise<Response> {
    // Extract parameters from request
    const clientId = getQueryParam(request, 'clientId');
    const lsnFromUrl = getQueryParam(request, 'lsn');

    syncLogger.info('Received new changes notification', {
      clientId,
      lsnFromUrl
    }, MODULE_NAME);

    // Basic validation
    if (!clientId) {
      return new Response('Missing clientId parameter', { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate LSN if provided
    if (lsnFromUrl && !isValidLSN(lsnFromUrl)) {
      syncLogger.error('Invalid LSN format in request', {
        clientId,
        lsn: lsnFromUrl
      }, MODULE_NAME);
      return new Response(JSON.stringify({
        error: 'Invalid LSN format'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Parse the request body to get the serverLSN
    let requestData;
    let serverLSN;
    try {
      requestData = await request.json() as { 
        lsn?: string
      };
      
      // Extract server LSN from request data
      serverLSN = requestData.lsn;
      
      if (!serverLSN) {
        throw new Error('No server LSN provided');
      }
      
      if (!isValidLSN(serverLSN)) {
        throw new Error('Invalid server LSN format');
      }
      
      syncLogger.info('Processing changes notification', {
        clientId,
        serverLSN,
        connectionActive: this.isConnected()
      }, MODULE_NAME);
    } catch (error) {
      return new Response(JSON.stringify({
        error: 'Invalid request format',
        details: error instanceof Error ? error.message : String(error)
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // If we don't have an active WebSocket connection, can't notify
    if (!this.isConnected()) {
      syncLogger.warn('Cannot notify client, no active connection', {
        clientId
      }, MODULE_NAME);
      
      return new Response(JSON.stringify({
        success: false,
        error: 'No active WebSocket connection for client'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get client's last known LSN
    let clientLSN: string;
    try {
      // Use getLSN from state manager if this SyncDO is for the requested clientId
      if (this.clientId === clientId) {
        clientLSN = this.stateManager.getLSN() || '0/0';
      } else {
        syncLogger.warn('Client ID mismatch, cannot get LSN from state manager', {
          requestClientId: clientId,
          currentClientId: this.clientId
        }, MODULE_NAME);
        // Default to 0/0 if we can't get the client's LSN
        clientLSN = '0/0';
      }
    } catch (error) {
      syncLogger.error('Failed to get client LSN', {
        clientId,
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      clientLSN = '0/0';
    }

    syncLogger.debug('Using LSNs for sync', {
      clientId,
      clientLSN,
      serverLSN
    }, MODULE_NAME);

    const ctx = this.getContext();

    try {
      // Use the new unified fetchAndProcessChanges function
      const result = await fetchAndProcessChanges(
        ctx,
        clientId,
        clientLSN,
        serverLSN,
        this,
        true // This is a live sync
      );
      
      // Update client's LSN if successful and this is our client
      if (result.success && this.clientId === clientId) {
        await this.stateManager.updateClientLSN(clientId, result.finalLSN);
      }
      
      return new Response(JSON.stringify({
        success: result.success,
        notified: result.success,
        changeCount: result.changeCount,
        lsn: result.finalLSN
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      syncLogger.error('Failed to process changes notification', {
        clientId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }, MODULE_NAME);
      
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to process changes',
        details: error instanceof Error ? error.message : String(error)
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  /**
   * Handle metrics request
   */
  private async handleMetrics(): Promise<Response> {
    const metrics = await this.stateManager.getMetrics();
    const errors = await this.stateManager.getErrors();
    
    return new Response(JSON.stringify({
      ...metrics,
      errors: errors.map(err => ({
        message: err.message,
        stack: err.stack
      })),
      lastLSN: this.stateManager.getLSN(),
      lastWakeTime: metrics.lastWakeTime,
      connections: this.webSocket ? 1 : 0,
      id: this.syncId
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  /**
   * Create a minimal context for use with other modules
   */
  private getContext(): MinimalContext {
    return {
      env: this.env,
      executionCtx: {
        waitUntil: (promise: Promise<any>) => this.state.waitUntil(promise),
        passThroughOnException: () => {},
        props: undefined
      }
    };
  }
  
  // WebSocketHandler implementation
  
  /**
   * Send a message to the client using type-safe interface
   */
  async send(message: ServerMessage): Promise<void> {
    try {
      if (this.webSocket && this.webSocket.readyState === WS_READY_STATE.OPEN) {
        // Minimal logging for acknowledgment messages
        if (message.type === 'srv_changes_received' || message.type === 'srv_changes_applied') {
          syncLogger.info(`Sending ${message.type}`, {
            type: message.type,
            messageId: message.messageId
          }, MODULE_NAME);
        }
        
        // Use try-catch specifically for the send operation
        try {
          this.webSocket.send(JSON.stringify(message));
          
          // Only log type and messageId on success
          syncLogger.debug('Sent message', {
            type: message.type,
            messageId: message.messageId
          }, MODULE_NAME);
        } catch (sendError) {
          // Log specific send error with minimal info
          syncLogger.error(`Error sending message`, {
            type: message.type,
            messageId: message.messageId,
            error: sendError instanceof Error ? sendError.message : String(sendError)
          }, MODULE_NAME);
          throw sendError; // Re-throw for caller to handle
        }
      } else {
        // WebSocket not available or not open
        syncLogger.warn('Cannot send message, WebSocket not open', {
          type: message.type,
          messageId: message.messageId,
          readyState: this.webSocket?.readyState
        }, MODULE_NAME);
        
        // For acknowledgments, this is a critical error
        if (message.type === 'srv_changes_received' || message.type === 'srv_changes_applied') {
          syncLogger.error(`Failed to send acknowledgment`, {
            type: message.type,
            messageId: message.messageId
          }, MODULE_NAME);
          throw new Error(`Cannot send acknowledgment - WebSocket not open (state: ${this.webSocket?.readyState})`);
        }
      }
    } catch (error) {
      // Catch-all for any other errors
      syncLogger.error(`Unexpected error in send method: ${error instanceof Error ? error.message : String(error)}`, {
        type: message.type,
        error: error instanceof Error ? error.stack : String(error)
      }, MODULE_NAME);
      throw error; // Re-throw for caller to handle
    }
  }
  
  /**
   * Register a message handler for a specific message type
   */
  onMessage<T extends ClientMessage['type']>(
    type: T, 
    handler: (message: ClientMessage) => Promise<void>
  ): void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, []);
    }
    
    this.messageHandlers.get(type)!.push(handler);
    
    syncLogger.debug('Registered message handler', { 
      type,
      handlersCount: this.messageHandlers.get(type)!.length
    }, MODULE_NAME);
  }
  
  /**
   * Remove a message handler for a specific type
   */
  removeHandler(type: ClientMessage['type']): void {
    this.messageHandlers.delete(type);
    syncLogger.debug('Removed all handlers for type', { type }, MODULE_NAME);
  }
  
  /**
   * Clear all message handlers
   */
  clearHandlers(): void {
    this.messageHandlers.clear();
    syncLogger.debug('Cleared all message handlers', {}, MODULE_NAME);
  }
  
  /**
   * Check if the WebSocket is connected
   */
  isConnected(): boolean {
    return this.webSocket !== null && this.webSocket.readyState === WS_READY_STATE.OPEN;
  }
  
  /**
   * Wait for a specific message type from client
   */
  async waitForMessage(
    type: ClientMessage['type'], 
    filter?: ((msg: any) => boolean) | undefined, 
    timeoutMs: number = 30000
  ): Promise<any> {
    // Check if we already have a message of this type in the queue
    const existingMessages = this.messageQueue.get(type) || [];
    
    // If we have messages and no filter, return the first one
    if (existingMessages.length > 0 && !filter) {
      const message = existingMessages.shift();
      return message;
    }
    
    // If we have messages and a filter, check if any match
    if (existingMessages.length > 0 && filter) {
      const index = existingMessages.findIndex(msg => filter(msg));
      if (index >= 0) {
        const message = existingMessages.splice(index, 1)[0];
        return message;
      }
    }
    
    // Otherwise, we need to wait for a new message
    return new Promise((resolve, reject) => {
      const waitId = `wait_${type}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      // Set up timeout
      const timer = setTimeout(() => {
        if (this.waitingResolvers.has(waitId)) {
          this.waitingResolvers.delete(waitId);
          reject(new Error(`Timeout waiting for message of type ${type}`));
        }
      }, timeoutMs);
      
      // Store resolver
      this.waitingResolvers.set(waitId, {
        resolve: (message: any) => {
          // If there's a filter and the message doesn't match, continue waiting
          if (filter && !filter(message)) {
            return;
          }
          
          resolve(message);
        },
        reject,
        timer
      });
      
      syncLogger.debug('Waiting for message', { 
        type,
        waitId,
        timeout: timeoutMs
      }, MODULE_NAME);
    });
  }

  /**
   * Handle sync stats messages
   * This is used by the replication module to send detailed processing statistics
   */
  private async handleSyncStats(request: Request): Promise<Response> {
    // Extract client ID from query params
    const clientId = getQueryParam(request, 'clientId');
    
    if (!clientId) {
      return new Response('Missing clientId parameter', { status: 400 });
    }
    
    try {
      // Parse the request body to get the stats message
      const statsMessage = await request.json() as ServerSyncStatsMessage;
      
      // Ensure client ID is set in the message (should already be from process-changes)
      if (!statsMessage.clientId) {
        statsMessage.clientId = clientId;
      }
      
      // Forward stats message to connected WebSocket client
      if (this.webSocket && this.webSocket.readyState === WS_READY_STATE.OPEN) {
        this.webSocket.send(JSON.stringify(statsMessage));
        
        syncLogger.debug('Forwarded sync stats to client', {
          clientId,
          syncType: statsMessage.syncType,
          deduped: statsMessage.deduplicationStats?.reduction || 0,
          filtered: statsMessage.filteringStats?.filtered || 0
        }, MODULE_NAME);
        
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        syncLogger.warn('Could not forward sync stats - WebSocket not connected', {
          clientId
        }, MODULE_NAME);
        
        return new Response(JSON.stringify({ 
          success: false,
          error: 'WebSocket not connected'
        }), {
          status: 200, // Still return 200 to avoid retries
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (error) {
      syncLogger.error('Error handling sync stats', {
        clientId,
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      
      return new Response(JSON.stringify({ 
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
} 