import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from './logger.ts';
import { WS_CONFIG } from '../config.ts';
import { ClientProfileManager, ClientProfile } from './client-profile-manager.ts';
import * as apiService from './api-service.ts';
import { messageDispatcher } from './message-dispatcher.ts';
import type { ServerChangesMessage, SrvMessageType, TableChange } from '@repo/sync-types';
import { MessageProcessor } from './message-processor.ts';

// Define client status type
type ClientStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// WebSocket message handler type
type MessageHandler = (message: any) => void;

// Client instance type
interface WSClient {
  id: string;
  ws: WebSocket | null;
  status: ClientStatus;
  profileId: number;
  lsn: string;
  connectionPromise: Promise<void> | null;
  messageHandlers: Set<MessageHandler>;
}

export class WebSocketClientFactory {
  private clients: Map<string, WSClient> = new Map();
  private logger = createLogger('ws-client-factory');
  private wsConfig = { ...WS_CONFIG };
  private profileManager: ClientProfileManager;
  private messageProcessor: MessageProcessor;
  private heartbeatIntervals: Map<string, NodeJS.Timeout> = new Map();
  
  constructor() {
    this.profileManager = new ClientProfileManager();
    this.messageProcessor = new MessageProcessor({ verbose: false });
    this.logger.info('WebSocketClientFactory initialized with MessageProcessor');
  }
  
  /**
   * Create a new WebSocket client with associated profile
   * @param profileId Profile ID to use (creates new profile if needed)
   * @returns The client ID
   */
  async createClient(profileId: number = 1): Promise<string> {
    // Get or reuse client profile
    const { clientId, profile } = await this.profileManager.getOrReuseClient(profileId);
    this.logger.info(`Using profile: ${profile.name} (ID: ${profile.profileId}) with LSN: ${profile.lsn}`);
    
    // Check if we already have this client
    if (this.clients.has(clientId)) {
      this.logger.info(`Client ${clientId} already exists, reusing`);
      return clientId;
    }
    
    // Create client 
    this.clients.set(clientId, {
      id: clientId,
      ws: null,
      status: 'disconnected',
      profileId,
      lsn: profile.lsn,
      connectionPromise: null,
      messageHandlers: new Set(),
    });
    
    this.logger.info(`Created client: ${clientId} with profile ${profileId}`);
    return clientId;
  }
  
  /**
   * Connect a client to the WebSocket server
   * @param clientId The client ID
   * @param serverUrl The WebSocket server URL (defaults to config URL)
   * @param options Additional connection options
   * @returns Promise that resolves when connected
   */
  async connectClient(clientId: string, serverUrl: string = WS_CONFIG.URL, options: any = {}): Promise<void> {
    const client = this.getClient(clientId);
    
    if (client.status === 'connected') {
      this.logger.warn(`Client ${clientId} is already connected`);
      return;
    }
    
    // Update client status
    client.status = 'connecting';
    
    // Configure WebSocket URL with client ID and LSN
    const wsUrl = new URL(serverUrl);
    wsUrl.searchParams.set('clientId', clientId);
    
    // Always include LSN parameter
    const lsn = options.lsn || client.lsn;
    if (lsn) {
      wsUrl.searchParams.set('lsn', lsn);
      this.logger.info(`Connecting with LSN: ${lsn}`);
    }
    
    try {
      // Create WebSocket
      this.logger.info(`Connecting to: ${wsUrl.toString()}`);
      client.ws = new WebSocket(wsUrl.toString());
      
      // Create connection promise
      client.connectionPromise = new Promise<void>((resolve, reject) => {
        // Set timeout for connection
        const timeout = setTimeout(() => {
          reject(new Error(`Connection timeout for client ${clientId}`));
          
          if (client.ws) {
            client.ws.close();
            client.ws = null;
          }
          
          client.status = 'error';
        }, options.timeout || 10000);
        
        // Set up event handlers
        client.ws!.on('open', () => {
          this.logger.info(`Client ${clientId} connected to ${wsUrl.toString()}`);
          client.status = 'connected';
          resolve();
        });
        
        client.ws!.on('error', (error) => {
          clearTimeout(timeout);
          client.status = 'error';
          this.logger.error(`WebSocket connection error for client ${clientId}: ${error}`);
          reject(error);
        });
        
        client.ws!.on('close', () => {
          client.status = 'disconnected';
          this.logger.info(`Client ${clientId} disconnected`);
        });
        
        client.ws!.on('message', async (data: WebSocket.Data) => {
          try {
            // Process the message asynchronously
            await this.processIncomingMessage(clientId, data);
          } catch (error) {
            this.logger.error(`Error processing message for client ${clientId}: ${error}`);
          }
        });
      });
      
      // Start heartbeat for this client
      this.startHeartbeat(clientId);
      
      // Wait for connection
      await client.connectionPromise;
      
      // Return when connected
      return;
    } catch (error) {
      client.status = 'error';
      this.logger.error(`Failed to connect client ${clientId}: ${error}`);
      throw error;
    }
  }
  
  /**
   * Send initial catchup request if needed
   * @param clientId The client ID
   * @param fromLSN Override LSN (uses client's LSN if not provided)
   */
  async sendCatchupRequest(clientId: string, fromLSN?: string): Promise<void> {
    const client = this.getClient(clientId);
    
    if (client.status !== 'connected') {
      throw new Error(`Client ${clientId} is not connected`);
    }
    
    const lsn = fromLSN || client.lsn;
    
    this.logger.info(`Sending catchup request for client ${clientId} from LSN ${lsn}`);
    await this.sendMessage(clientId, {
      type: 'clt_catchup_request',
      clientId,
      fromLSN: lsn
    });
  }
  
  /**
   * Wait for catchup to complete
   * @param clientId The client ID
   * @param timeout Timeout in milliseconds
   */
  async waitForCatchup(clientId: string, timeout: number = 10000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.removeMessageHandler(clientId, catchupHandler);
        reject(new Error('Catchup handshake timed out'));
      }, timeout);
      
      const catchupHandler = (message: any) => {
        if (message.type === 'srv_catchup_completed') {
          clearTimeout(timeoutId);
          this.removeMessageHandler(clientId, catchupHandler);
          this.logger.info(`Catchup completed for client ${clientId}`);
          resolve();
        }
      };
      
      this.addMessageHandler(clientId, catchupHandler);
    });
  }
  
  /**
   * Perform full client setup - connect and handle catchup if needed
   * @param clientId The client ID
   */
  async setupClient(clientId: string): Promise<void> {
    const client = this.getClient(clientId);
    
    // Connect first
    await this.connectClient(clientId);
    
    // Send catchup request only if needed (profile will have proper LSN)
    if (client.lsn === '0/0') {
      await this.sendCatchupRequest(clientId);
      await this.waitForCatchup(clientId);
    }
  }
  
  /**
   * Disconnect a client from the WebSocket server
   * @param clientId The client ID
   * @returns Promise that resolves when disconnected
   */
  async disconnectClient(clientId: string): Promise<void> {
    const client = this.getClient(clientId);
    
    // If already disconnected, just return
    if (client.status === 'disconnected' || client.ws === null) {
      this.logger.debug(`Client ${clientId} is already disconnected`);
      return;
    }
    
    // Stop heartbeat immediately
    this.stopHeartbeat(clientId);
    
    try {
      // Send a disconnect message if possible
      if (client.ws && client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(JSON.stringify({
            type: 'clt_disconnect',
            clientId,
            timestamp: Date.now(),
            message: 'Client disconnecting'
          }));
        } catch (e) {
          // Ignore errors when sending disconnect message
        }
      }
      
      // Close the connection - don't wait for response
      if (client.ws) {
        try {
          client.ws.close();
        } catch (e) {
          // Ignore errors during close
        }
        
        // Don't wait for onclose - force cleanup immediately
        this.forceTerminateClient(client, clientId);
      }
      
      // Clear this client from the profile
      await this.clearActiveClientFromProfile(clientId, client.profileId);
      
      this.logger.info(`Client ${clientId} disconnected`);
    } catch (error) {
      this.logger.error(`Error disconnecting client ${clientId}: ${error}`);
      
      // Ensure cleanup happens even on error
      this.forceTerminateClient(client, clientId);
      await this.clearActiveClientFromProfile(clientId, client.profileId);
    }
  }
  
  /**
   * Force terminate a client's WebSocket connection
   * This bypasses the normal close handshake
   */
  private forceTerminateClient(client: WSClient, clientId: string): void {
    // Clean up the client's state
    client.status = 'disconnected';
    client.messageHandlers.clear();
    
    // Force terminate WebSocket
    if (client.ws) {
      try {
        client.ws.terminate(); // More aggressive than close()
      } catch (e) {
        // Ignore errors during termination
      }
      
      // Nullify references for garbage collection
      client.ws.onclose = null;
      client.ws.onerror = null;
      client.ws.onmessage = null;
      client.ws.onopen = null;
      client.ws = null;
    }
    
    this.logger.debug(`Force terminated client ${clientId}`);
  }
  
  /**
   * Send a message through a client
   * @param clientId The client ID
   * @param message The message to send
   */
  async sendMessage(clientId: string, message: any): Promise<void> {
    const client = this.getClient(clientId);
    
    if (client.status !== 'connected' || !client.ws) {
      throw new Error(`Client ${clientId} is not connected`);
    }
    
    try {
      // Add clientId to message if not present
      if (typeof message === 'object' && !message.clientId) {
        message.clientId = clientId;
      }
      
      // Send message
      client.ws.send(JSON.stringify(message));
      this.logger.debug(`Client ${clientId} sent message: ${message.type}`);
    } catch (error) {
      this.logger.error(`Failed to send message for client ${clientId}: ${error}`);
      throw error;
    }
  }
  
  /**
   * Add a message handler for a client
   * @param clientId The client ID
   * @param handler The message handler function
   */
  addMessageHandler(clientId: string, handler: MessageHandler): void {
    const client = this.getClient(clientId);
    client.messageHandlers.add(handler);
  }
  
  /**
   * Remove a message handler for a client
   * @param clientId The client ID
   * @param handler The message handler function to remove
   */
  removeMessageHandler(clientId: string, handler: MessageHandler): void {
    const client = this.getClient(clientId);
    client.messageHandlers.delete(handler);
  }
  
  /**
   * Get the current LSN for a client
   * @param clientId The client ID
   * @returns The current LSN or null
   */
  getCurrentLSN(clientId: string): string | null {
    const client = this.getClient(clientId);
    return client.lsn;
  }
  
  /**
   * Update the LSN for a client
   * @param clientId The client ID
   * @param lsn The new LSN
   */
  updateLSN(clientId: string, lsn: string): void {
    const client = this.getClient(clientId);
    client.lsn = lsn;
    
    // Also update the profile
    this.profileManager.updateLSN(client.profileId, lsn);
  }
  
  /**
   * Get the connection status for a client
   * @param clientId The client ID
   * @returns The client status
   */
  getClientStatus(clientId: string): ClientStatus {
    const client = this.getClient(clientId);
    return client.status;
  }
  
  /**
   * Remove a client
   * @param clientId The client ID
   */
  async removeClient(clientId: string): Promise<void> {
    if (!this.clients.has(clientId)) {
      return;
    }
    
    const client = this.getClient(clientId);
    
    // Disconnect if connected
    if (client.status === 'connected') {
      await this.disconnectClient(clientId);
    }
    
    // Remove client
    this.clients.delete(clientId);
    this.logger.info(`Removed client: ${clientId}`);
  }
  
  /**
   * Get a client by ID
   * @param clientId The client ID
   * @returns The client
   */
  private getClient(clientId: string): WSClient {
    const client = this.clients.get(clientId);
    
    if (!client) {
      throw new Error(`Client ${clientId} not found`);
    }
    
    return client;
  }
  
  /**
   * Start heartbeat for a client
   * @param clientId The client ID
   */
  private startHeartbeat(clientId: string): void {
    const client = this.getClient(clientId);
    
    // Clear any existing heartbeat interval
    this.stopHeartbeat(clientId);
    
    const interval = setInterval(() => {
      if (client.status !== 'connected' || !client.ws) {
        this.stopHeartbeat(clientId);
        return;
      }
      
      try {
        client.ws.send(JSON.stringify({
          type: 'clt_heartbeat',
          clientId,
          timestamp: Date.now()
        }));
        
        this.logger.debug(`Sent heartbeat for client ${clientId}`);
      } catch (error) {
        this.logger.error(`Error sending heartbeat for client ${clientId}: ${error}`);
        this.stopHeartbeat(clientId);
      }
    }, WS_CONFIG.HEARTBEAT_INTERVAL);
    
    // Store the interval for future cleanup
    this.heartbeatIntervals.set(clientId, interval);
  }
  
  /**
   * Stop heartbeat for a client
   * @param clientId The client ID
   */
  private stopHeartbeat(clientId: string): void {
    if (this.heartbeatIntervals.has(clientId)) {
      clearInterval(this.heartbeatIntervals.get(clientId)!);
      this.heartbeatIntervals.delete(clientId);
      this.logger.debug(`Stopped heartbeat for client ${clientId}`);
    }
  }
  
  /**
   * Remove all message handlers for a client
   * @param clientId The client ID
   */
  removeAllMessageHandlers(clientId: string): void {
    const client = this.getClient(clientId);
    client.messageHandlers.clear();
    this.logger.debug(`Removed all message handlers for client ${clientId}`);
  }
  
  /**
   * Process an incoming WebSocket message
   * Uses MessageProcessor to handle different message types
   */
  private async processIncomingMessage(clientId: string, data: WebSocket.Data): Promise<any> {
    try {
      const rawMessage = JSON.parse(data.toString());
      // Reduce verbosity - log at debug level instead of info
      this.logger.debug(`Client ${clientId} received message type: ${rawMessage.type}`);
      
      // Add clientId to the message
      rawMessage.clientId = clientId;
      
      // Process specific message types for local state updates
      if (rawMessage.type.startsWith('srv_')) {
        // Server messages
        if (rawMessage.type === 'srv_live_changes' || rawMessage.type === 'srv_catchup_changes') {
          // Process server changes message
          const serverMessage = rawMessage as ServerChangesMessage;
          
          // Log more details for debugging
          if (rawMessage.type === 'srv_catchup_changes') {
            // Keep this as info since it's important state info
            this.logger.info(`Catchup change received: chunk=${serverMessage.sequence?.chunk}/${serverMessage.sequence?.total}, changes=${serverMessage.changes?.length || 0}, LSN=${serverMessage.lastLSN || 'none'}`);
          }
          
          // Update client's LSN if available
          const client = this.getClient(clientId);
          if (serverMessage.lastLSN) {
            client.lsn = serverMessage.lastLSN;
            this.profileManager.updateLSN(client.profileId, serverMessage.lastLSN);
            this.logger.debug(`Updated LSN for client ${clientId} to ${serverMessage.lastLSN}`);
          }
          
          // Process the changes for easier consumption by handlers
          const processedChanges = this.messageProcessor.processTableChanges(
            serverMessage.changes,
            false // Don't log warnings
          );
          
          // Augment the message with processed changes for handlers
          rawMessage._processedChanges = processedChanges;
        } else if (rawMessage.type === 'srv_catchup_completed') {
          this.logger.info(`Catchup completed message received for client ${clientId}: ${JSON.stringify(rawMessage)}`);
        }
      }
      
      // Forward ALL messages to the central message dispatcher first
      // IMPORTANT: Wait for the dispatch result before falling back to legacy handlers
      let wasHandled = false;
      try {
        wasHandled = await messageDispatcher.dispatchMessage(rawMessage);
        
        if (wasHandled) {
          // Reduce log level to debug
          this.logger.debug(`Message ${rawMessage.type} was handled by central dispatcher`);
        } else {
          // Only log a warning for server messages that should be handled
          if (rawMessage.type.startsWith('srv_')) {
            this.logger.warn(`Message ${rawMessage.type} was NOT handled by any dispatcher handler`);
          }
        }
      } catch (err) {
        this.logger.error(`Error dispatching message: ${err}`);
      }
      
      // Only call registered message handlers directly if not handled by the dispatcher
      // IMPORTANT: This is for backward compatibility only
      if (!wasHandled) {
        const client = this.getClient(clientId);
        if (client.messageHandlers.size > 0) {
          this.logger.debug(`Forwarding message to ${client.messageHandlers.size} direct handlers (legacy)`);
          client.messageHandlers.forEach(handler => {
            try {
              handler(rawMessage);
            } catch (err) {
              this.logger.error(`Error in message handler: ${err}`);
            }
          });
        }
      }
      
      return rawMessage;
    } catch (err) {
      this.logger.error(`Error processing message: ${err}`);
      return null;
    }
  }
  
  /**
   * Send a client acknowledgment message for server changes
   * @param clientId The client ID
   * @param lsn The LSN to acknowledge
   * @param messageId Optional message ID for tracking
   */
  async sendChangesAcknowledgment(clientId: string, lsn: string, messageId?: string): Promise<void> {
    const client = this.getClient(clientId);
    
    if (client.status !== 'connected') {
      throw new Error(`Client ${clientId} is not connected`);
    }
    
    this.logger.info(`Sending changes acknowledgment for client ${clientId} with LSN ${lsn}`);
    
    const message = {
      type: 'clt_changes_received',
      messageId: messageId || `ack-${uuidv4()}`,
      clientId,
      timestamp: Date.now(),
      changeIds: [], // We're acknowledging based on LSN, not individual changes
      lastLSN: lsn
    };
    
    await this.sendMessage(clientId, message);
    
    // Update client's LSN state
    client.lsn = lsn;
    this.profileManager.updateLSN(client.profileId, lsn);
  }
  
  /**
   * Clear the client ID from profile's active clients
   */
  private async clearActiveClientFromProfile(clientId: string, profileId: number): Promise<void> {
    try {
      await this.profileManager.clearActiveClientId(profileId, clientId);
      this.logger.debug(`Cleared active client ${clientId} from profile ${profileId}`);
    } catch (error) {
      this.logger.warn(`Failed to clear active client from profile: ${error}`);
    }
  }
}

// Export singleton instance
export const wsClientFactory = new WebSocketClientFactory(); 