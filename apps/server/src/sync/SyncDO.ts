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
import { performCatchupSync, sendLiveChanges, createLiveSyncConfirmation, processLiveUpdateNotification } from './server-changes';
import { processClientChanges } from './client-changes';
import type { 
  ServerMessage, 
  ClientMessage,
  ClientChangesMessage,
  ServerSyncStatsMessage,
  ServerCatchupCompletedMessage
} from '@repo/sync-types';
import type { MinimalContext } from '../types/hono';
import type { Env } from '../types/env';
import { syncLogger } from '../middleware/logger';
import type { WebSocketHandler } from './types';
import { compareLSN, deduplicateChanges, getLatestChangeHistoryLSN } from '../lib/sync-common';
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
  private ctx: DurableObjectState;
  private webSocket: WebSocket | null = null;
  private stateManager: SyncStateManager;
  private clientId: string = '';
  private syncId: string;
  private messageHandlers: Map<ClientMessage['type'], Array<(message: ClientMessage) => Promise<void>>> = new Map();
  private messageQueue: Map<ClientMessage['type'], ClientMessage[]> = new Map();
  private waitingResolvers: Map<string, {
    resolve: (message: any) => void,
    reject: (error: Error) => void,
    timer: NodeJS.Timeout | null,
    filter?: (message: any) => boolean
  }> = new Map();
  private isHandlerRegistered: boolean = false;
  
  // Add processing lock to prevent race conditions
  private isProcessingClientChanges: boolean = false;
  private pendingLiveUpdates: Array<() => Promise<void>> = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.ctx = state;
    
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
    
    // We no longer register handlers in the constructor
    // to prevent duplicate registrations when DO wakes from hibernation
    
    // Initialize replication when SyncDO starts up
    this.state.waitUntil(this.initializeReplication());
    
    // Schedule cleanup alarm if not already set
    this.checkAndSetCleanupAlarm();
  }

  /**
   * Initialize replication by calling the replication init endpoint
   * This ensures the replication system is ready before handling client connections
   */
  private async initializeReplication(): Promise<void> {
    try {
      syncLogger.info('Initializing replication from SyncDO startup', {
        syncId: this.syncId
      }, MODULE_NAME);
      
      // Get the ReplicationDO using the proper Durable Object pattern
      const replicationId = this.env.REPLICATION.idFromName('replication');
      const replicationStub = this.env.REPLICATION.get(replicationId);
      
      // Call the init endpoint directly on the ReplicationDO - using proper URL format
      const response = await replicationStub.fetch('https://internal/api/replication/init');
      
      if (!response.ok) {
        syncLogger.error('Failed to initialize replication', {
          status: response.status,
          statusText: response.statusText
        }, MODULE_NAME);
        return;
      }
      
      const result = await response.json();
      syncLogger.info('Replication initialization successful', {
        result,
        syncId: this.syncId
      }, MODULE_NAME);
    } catch (error) {
      syncLogger.error('Error initializing replication', {
        error: error instanceof Error ? error.message : String(error),
        syncId: this.syncId
      }, MODULE_NAME);
    }
  }

  /**
   * Register message handlers only once
   */
  private registerMessageHandlers(): void {
    if (this.isHandlerRegistered) {
      syncLogger.debug('Message handlers already registered, skipping', {
        clientId: this.clientId,
      }, MODULE_NAME);
      return;
    }

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

    // Add handler for catchup acknowledgments to update client LSN
    this.onMessage('clt_catchup_received', async (message: ClientMessage) => {
      // Cast to any to access the lsn property which is specific to this message type
      const catchupMessage = message as any;
      if (catchupMessage.lsn) {
        // Update the state manager with the LSN from each acknowledgment
        await this.stateManager.updateClientLSN(catchupMessage.clientId || this.clientId, catchupMessage.lsn);
        syncLogger.debug('Updated client LSN from catchup acknowledgment', {
          clientId: catchupMessage.clientId || this.clientId,
          lsn: catchupMessage.lsn
        }, MODULE_NAME);
      }
    });

    this.isHandlerRegistered = true;
    syncLogger.info('Message handlers registered', {
      clientId: this.clientId,
    }, MODULE_NAME);
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
    
    // Store client ID
    this.clientId = clientId;

    // Configure WebSocket with hibernation API
    this.ctx.acceptWebSocket(server);
    
    // Register message handlers only once per clientId
    this.registerMessageHandlers();
    
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
    // When using hibernation API, we don't need event listeners here
    // Event handling will be done via the webSocketMessage, webSocketClose, etc. methods
    
    // Keep track of active WebSocket for sending methods
    this.webSocket = ws;
  }
  
  /**
   * WebSocket message handler for hibernation API
   */
  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    // Register handlers if they aren't registered (DO just woke up from hibernation)
    if (!this.isHandlerRegistered) {
      syncLogger.info('DO woke from hibernation, registering message handlers', {
        clientId: this.clientId,
      }, MODULE_NAME);
      this.registerMessageHandlers();
    }
    
    try {
      // Convert data to string if it's ArrayBuffer
      const messageStr = typeof data === 'string' ? data : new TextDecoder().decode(data);
      const message = JSON.parse(messageStr) as ClientMessage;
      
      // Store in message queue for waitForMessage
      if (!this.messageQueue.has(message.type)) {
        this.messageQueue.set(message.type, []);
      }
      this.messageQueue.get(message.type)!.push(message);
      
      // Check if someone is waiting for this message type
      this.checkWaitingResolvers(message.type, message);
      
      // Check if this is a client changes message, if so, set the processing lock
      if (message.type === 'clt_send_changes') {
        this.isProcessingClientChanges = true;
        syncLogger.info('Client changes processing started - setting processing lock', {
          clientId: this.clientId,
          messageId: message.messageId
        }, MODULE_NAME);
      }
      
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
          
          // If this was a client changes message and it failed, release the lock
          // Note: We're not releasing the lock here anymore - lock will be released
          // after acknowledgments are sent via notifyClientChangesComplete
          if (message.type === 'clt_send_changes' && 
              (handlerError instanceof Error && !handlerError.message.includes('WebSocketUnavailable'))) {
            // For non-WebSocket errors, release lock immediately
            this.isProcessingClientChanges = false;
            syncLogger.info('Client changes processing failed - releasing processing lock', {
              clientId: this.clientId,
              messageId: message.messageId
            }, MODULE_NAME);
            
            // Process any pending updates
            this.processPendingLiveUpdates();
          }
        }
      }
      
      // Note: We no longer automatically release the lock here after processing client changes
      // It will be released via notifyClientChangesComplete after acks are sent
    } catch (error) {
      syncLogger.error('Message parse error', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
    }
  }
  
  /**
   * WebSocket close handler for hibernation API
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Log websocket closure
    syncLogger.info('WebSocket closed', {
      clientId: this.clientId || 'no-client-id',
      code,
      reason: reason || 'No reason specified',
      wasClean
    }, MODULE_NAME);
    
    // Clear WebSocket reference
    this.webSocket = null;
    
    // Mark client as inactive in KV - don't wait for completion
    this.state.waitUntil(this.stateManager.cleanupConnection());
    
    // We don't clear the clientId since it's properly persisted
    // and may be needed for additional operations
  }
  
  /**
   * WebSocket error handler for hibernation API
   */
  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    syncLogger.error('WebSocket error', {
      clientId: this.clientId,
      error: error.message,
      stack: error.stack
    }, MODULE_NAME);
    
    this.webSocket = null;
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
      
      // Check if this resolver has a filter function
      if (resolver.filter) {
        // Only resolve if the message passes the filter
        try {
          if (!resolver.filter(message)) {
            // This message doesn't match the filter criteria
            // Leave the resolver in place for a future message
            continue;
          }
          
          // Message matched the filter - proceed with resolution
          syncLogger.debug('Message passed filter, resolving', { 
            type,
            waitId,
            messageId: message.messageId
          }, MODULE_NAME);
        } catch (filterError) {
          syncLogger.error('Error in message filter function', {
            type,
            waitId,
            error: filterError instanceof Error ? filterError.message : String(filterError)
          }, MODULE_NAME);
          // Continue to next resolver on filter error
          continue;
        }
      }
      
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
   * Handle incoming WebSocket messages - this is replaced by webSocketMessage with hibernation API
   * Keeping the method for backward compatibility but it won't be called
   */
  private async handleWebSocketMessage(event: MessageEvent): Promise<void> {
    // This won't be called with hibernation API
    syncLogger.warn('handleWebSocketMessage called but using hibernation API', {}, MODULE_NAME);
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
    
    // Get the current server LSN from change_history, default to '0/0'
    const context = this.getContext(); // Get context for DB query
    const serverLSN = (await getLatestChangeHistoryLSN(context)) || '0/0';
    
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
        
        // After initial sync completes, get the current client and server LSNs
        // to determine if catchup sync is needed
        const updatedClientLSN = await this.stateManager.getLSN() || '0/0';
        const currentServerLSN = await this.stateManager.getServerLSN();
        
        syncLogger.info('Initial sync completed, checking if catchup sync is needed', {
          clientId,
          updatedClientLSN,
          currentServerLSN
        }, MODULE_NAME);
        
        // If client LSN is still behind server LSN, perform catchup sync
        if (compareLSN(updatedClientLSN, currentServerLSN) < 0) {
          syncLogger.info('Starting automatic catchup sync after initial sync', {
            clientId,
            clientLSN: updatedClientLSN,
            serverLSN: currentServerLSN
          }, MODULE_NAME);
          
          // Update client's sync state in storage
          await this.stateManager.updateClientSyncState(clientId, 'catchup');
          
          // Perform catchup sync with both LSNs
          await performCatchupSync(
            context,
            clientId,
            updatedClientLSN,   // Use updated client LSN after initial sync
            currentServerLSN,   // Use current server LSN
            this,
            this.stateManager
          );
        } else {
          // Client is up to date after initial sync, proceed to live sync
          syncLogger.info('Client is up to date after initial sync, transitioning to live', {
            clientId,
            lsn: updatedClientLSN
          }, MODULE_NAME);
          
          // Update sync state (server-side)
          await this.stateManager.updateClientSyncState(clientId, 'live');
          
          // Send a live start message as the client is now up-to-date
          syncLogger.info('Sending live start message as catchup was skipped', { clientId, lsn: updatedClientLSN }, MODULE_NAME);
          const liveStartMsg = createLiveSyncConfirmation(clientId, updatedClientLSN);
          await this.send(liveStartMsg);
        }
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
    const url = new URL(request.url);
    const clientId = url.searchParams.get('clientId')!;
    const lsnFromUrl = url.searchParams.get('lsn');

    if (!clientId) {
      return new Response('Client ID is required', { status: 400 });
    }

    syncLogger.info('Received new changes notification', {
      clientId,
      lsnFromUrl
    }, MODULE_NAME);

    // Set the client ID if it's not already set
    if (!this.clientId) {
      this.clientId = clientId;
      await this.stateManager.registerClient(clientId);
    }

    // Get server LSN from change_history, default to '0/0'
    const ctx = this.getContext(); // Get context for DB query
    const serverLSN = (await getLatestChangeHistoryLSN(ctx)) || '0/0';
    syncLogger.info('Processing changes notification', {
      clientId,
      serverLSN
    }, MODULE_NAME);

    let clientLSN: string;
    try {
      // Use getLSN from state manager
      clientLSN = await this.stateManager.getLSN() || '0/0';
    } catch (error) {
      syncLogger.error('Failed to get client LSN for notification', { clientId }, MODULE_NAME);
      clientLSN = '0/0';
    }

    // Check if client changes are being processed
    if (this.isProcessingClientChanges) {
      syncLogger.info('Client is currently processing changes, queuing live update', {
        clientId,
        serverLSN
      }, MODULE_NAME);
      
      // Create a promise for the response
      const responsePromise = new Promise<Response>((resolve) => {
        // Add to pending updates queue
        this.pendingLiveUpdates.push(async () => {
          try {
            // Process live update
            const result = await processLiveUpdateNotification(
              ctx,
              clientId,
              clientLSN,
              serverLSN,
              this
            );
            
            // Update client's LSN if successful
            if (result.success && this.clientId === clientId) {
               await this.stateManager.updateClientLSN(clientId, result.finalLSN);
            }
            
            // Resolve with success response
            resolve(new Response(JSON.stringify({
              success: result.success,
              notified: true,
              changeCount: result.changeCount,
              lsn: result.finalLSN,
              queued: true
            }), {
              status: result.success ? 200 : 500,
              headers: { 'Content-Type': 'application/json' }
            }));
          } catch (error) {
            // Check if this is a WebSocket unavailability error
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isWebSocketUnavailable = errorMessage.includes('WebSocketUnavailable') || 
                                        errorMessage.includes('No active WebSocket connections');
            
            if (isWebSocketUnavailable) {
              // Clean up client
              await this.stateManager.cleanupConnection();
              
              // Resolve with WebSocket unavailable response
              resolve(new Response(JSON.stringify({
                success: false,
                notified: false,
                error: 'Client has no active WebSocket connection',
                cleaned: true,
                queued: true
              }), {
                status: 410,
                headers: { 'Content-Type': 'application/json' }
              }));
            } else {
              // Resolve with error response
              resolve(new Response(JSON.stringify({
                success: false,
                error: 'Failed to process queued live update notification',
                details: errorMessage,
                queued: true
              }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
              }));
            }
          }
        });
      });
      
      return responsePromise;
    }

    // Normal (non-queued) processing path
    try {
      // Get all active WebSocket connections
      const webSockets = this.ctx.getWebSockets();
      
      // If there are no active WebSockets, this client is disconnected
      // Handle cleanup here instead of in webSocketClose to avoid errors
      if (webSockets.length === 0) {
        syncLogger.info('Client has no active WebSocket connection, cleaning up', {
          clientId
        }, MODULE_NAME);
        
        // Clean up client registration
        await this.stateManager.cleanupConnection();
        
        return new Response(JSON.stringify({
          success: false,
          notified: false,
          error: 'Client has no active WebSocket connection',
          cleaned: true
        }), {
          status: 410,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Call the dedicated function in server-changes to process the notification
      const result = await processLiveUpdateNotification(
        ctx,
        clientId,
        clientLSN,
        serverLSN,
        this // Pass SyncDO instance as the WebSocketHandler
      );
      
      // Update client's LSN if successful and this is our client
      if (result.success && this.clientId === clientId) {
         await this.stateManager.updateClientLSN(clientId, result.finalLSN);
         syncLogger.debug('Updated client LSN from live sync notification handler', {
            clientId,
            newLSN: result.finalLSN
         }, MODULE_NAME);
      }
      
      // Return success response based on the result
      return new Response(JSON.stringify({
        success: result.success,
        notified: true, // Indicate notification was processed
        changeCount: result.changeCount,
        lsn: result.finalLSN
      }), {
        status: result.success ? 200 : 500, // Use 500 if processing failed
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      // Check if this is a WebSocket unavailability error
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isWebSocketUnavailable = errorMessage.includes('WebSocketUnavailable') || 
                                   errorMessage.includes('No active WebSocket connections');
      
      // If WebSocket is unavailable, clean up the client registration
      if (isWebSocketUnavailable) {
        syncLogger.warn('Client has no active WebSocket connection, cleaning up registration', {
          clientId,
          errorMessage
        }, MODULE_NAME);
        
        try {
          // Clean up this client's registration - be explicit about which client
          await this.stateManager.cleanupConnection();
          
          // Log cleanup success
          syncLogger.info('Successfully cleaned up disconnected client registration', {
            clientId,
            timestamp: Date.now()
          }, MODULE_NAME);
          
          return new Response(JSON.stringify({
            success: false,
            notified: false,
            error: 'Client has no active WebSocket connection',
            cleaned: true
          }), {
            status: 410, // Gone - indicates the resource is no longer available
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (cleanupError) {
          // Log cleanup failure but still return 410
          syncLogger.error('Failed to clean up disconnected client registration', {
            clientId,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }, MODULE_NAME);
          
          return new Response(JSON.stringify({
            success: false,
            notified: false,
            error: 'Client has no active WebSocket connection',
            cleaned: false,
            cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }), {
            status: 410, // Still use Gone status
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // Handle other errors
      syncLogger.error('Unexpected error handling changes notification', {
        clientId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined
      }, MODULE_NAME);
      
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to process changes notification',
        details: errorMessage
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
      // Get all active WebSocket connections
      const webSockets = this.ctx.getWebSockets();
      
      if (webSockets.length === 0) {
        syncLogger.warn('No active WebSocket connections', {
          type: message.type,
          messageId: message.messageId,
          clientId: this.clientId
        }, MODULE_NAME);
        // Throw an error with a consistent message format that's easy to detect
        throw new Error('WebSocketUnavailable: No active WebSocket connections for client ' + this.clientId);
      }
      
      // Enhanced logging for acknowledgment messages (at INFO level)
      const isAcknowledgment = message.type === 'srv_changes_received' || 
                             message.type === 'srv_changes_applied';
      
      if (isAcknowledgment) {
        syncLogger.info('Sending acknowledgment message', {
          type: message.type,
          messageId: message.messageId,
          clientId: this.clientId,
          connectionCount: webSockets.length,
          isProcessingLocked: this.isProcessingClientChanges
        }, MODULE_NAME);
      } else {
        // Regular debug log for other messages
        syncLogger.debug('Sending message', {
          type: message.type,
          messageId: message.messageId,
          clientId: this.clientId,
          connectionCount: webSockets.length
        }, MODULE_NAME);
      }
      
      // Send to all active connections
      for (const ws of webSockets) {
        try {
          ws.send(JSON.stringify(message));
          
          // Log success at different levels based on message type
          if (isAcknowledgment) {
            syncLogger.info('Acknowledgment message sent successfully', {
              type: message.type,
              messageId: message.messageId,
              clientId: this.clientId
            }, MODULE_NAME);
          } else {
            syncLogger.debug('Message sent successfully', {
              type: message.type,
              messageId: message.messageId,
              clientId: this.clientId
            }, MODULE_NAME);
          }
        } catch (sendError) {
          syncLogger.error('Error sending message to WebSocket', {
            type: message.type,
            messageId: message.messageId,
            clientId: this.clientId,
            error: sendError instanceof Error ? sendError.message : String(sendError)
          }, MODULE_NAME);
          throw sendError;
        }
      }
    } catch (error) {
      syncLogger.error('Unexpected error in send method', {
        type: message.type,
        messageId: message.messageId,
        clientId: this.clientId,
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      throw error;
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
    timeoutMs: number = 300000  // Increased timeout to 5 minutes to accommodate larger data processing on client
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
          // Filter is now checked in checkWaitingResolvers
          resolve(message);
        },
        reject,
        timer,
        filter  // Save the filter function for use in checkWaitingResolvers
      });
      
      syncLogger.debug('Waiting for message', { 
        type,
        waitId,
        timeout: timeoutMs,
        hasFilter: filter !== undefined
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

  /**
   * Process any pending live update functions in the queue
   */
  private async processPendingLiveUpdates(): Promise<void> {
    if (this.pendingLiveUpdates.length === 0) {
      return;
    }
    
    syncLogger.info(`Processing ${this.pendingLiveUpdates.length} pending live updates`, {
      clientId: this.clientId
    }, MODULE_NAME);
    
    // Copy and clear the queue 
    const updates = [...this.pendingLiveUpdates];
    this.pendingLiveUpdates = [];
    
    // Process each pending update
    for (const updateFn of updates) {
      try {
        await updateFn();
      } catch (updateError) {
        syncLogger.error('Error processing queued live update', {
          error: updateError instanceof Error ? updateError.message : String(updateError),
          clientId: this.clientId
        }, MODULE_NAME);
      }
    }
  }

  /**
   * Notify that client changes processing is complete (including sending acknowledgments)
   * This is called by processClientChanges after sending the final acknowledgment
   */
  async notifyClientChangesComplete(messageId: string): Promise<void> {
    if (!this.isProcessingClientChanges) {
      // Lock is already released, nothing to do
      syncLogger.info('Lock already released when notifyClientChangesComplete called', {
        clientId: this.clientId,
        messageId
      }, MODULE_NAME);
      return;
    }
    
    // Get WebSockets count to indicate client connection status
    const webSockets = this.ctx.getWebSockets();
    
    // Release the lock
    this.isProcessingClientChanges = false;
    syncLogger.info('Client changes processing fully completed - releasing processing lock', {
      clientId: this.clientId,
      messageId,
      activeConnections: webSockets.length,
      pendingUpdates: this.pendingLiveUpdates.length
    }, MODULE_NAME);
    
    // Process any pending updates now that client changes are fully completed
    await this.processPendingLiveUpdates();
  }

  /**
   * Set up a periodic cleanup alarm if one doesn't exist
   */
  private async checkAndSetCleanupAlarm(): Promise<void> {
    try {
      const hasAlarm = await this.state.storage.getAlarm();
      if (!hasAlarm) {
        // Schedule cleanup in 1 hour
        const ONE_HOUR = 60 * 60 * 1000;
        this.state.storage.setAlarm(Date.now() + ONE_HOUR);
        syncLogger.info('Scheduled cleanup alarm', {}, MODULE_NAME);
      }
    } catch (error) {
      syncLogger.error('Failed to set cleanup alarm', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
    }
  }
  
  /**
   * Alarm handler - called by Cloudflare runtime when an alarm fires
   * Used for regular cleanup of expired clients
   */
  async alarm(): Promise<void> {
    syncLogger.info('Cleanup alarm fired', {}, MODULE_NAME);
    
    try {
      // Perform cleanup of inactive clients
      await this.stateManager.cleanupConnection();
      
      // Reschedule the next cleanup
      const ONE_HOUR = 60 * 60 * 1000;
      this.state.storage.setAlarm(Date.now() + ONE_HOUR);
      
      syncLogger.info('Cleanup completed and rescheduled', {}, MODULE_NAME);
    } catch (error) {
      syncLogger.error('Error during scheduled cleanup', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      
      // Even if cleanup fails, reschedule the alarm
      const ONE_HOUR = 60 * 60 * 1000;
      this.state.storage.setAlarm(Date.now() + ONE_HOUR);
    }
  }
} 