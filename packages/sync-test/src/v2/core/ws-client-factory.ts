import { v4 as uuidv4 } from 'uuid';
import { createLogger } from './logger.ts';
import { WS_CONFIG } from '../config.ts';
import { ClientProfileManager } from './client-profile-manager.ts';
import * as apiService from './api-service.ts';
import { messageDispatcher } from './message-dispatcher.ts';
import type { ServerChangesMessage } from '@repo/sync-types';
import { WebSocketConnection, ConnectionStatus } from './websocket-connection.ts';

// Client instance type
interface WSClient {
  id: string;
  connection: WebSocketConnection;
  profileId: number;
}

export class WebSocketClientFactory {
  private clients: Map<string, WSClient> = new Map();
  private logger = createLogger('sync.ws-client');
  private wsConfig = { ...WS_CONFIG };
  private profileManager: ClientProfileManager;
  
  constructor() {
    this.profileManager = new ClientProfileManager();
    this.logger.info('WebSocketClientFactory initialized');
    
    // Listen for LSN updates from the MessageDispatcher
    messageDispatcher.on('lsn_updated', (data: { clientId: string, lsn: string }) => {
      const { clientId, lsn } = data;
      if (this.clients.has(clientId)) {
        const client = this.clients.get(clientId)!;
        
        // Update profile with new LSN
        this.profileManager.updateLSN(client.profileId, lsn);
        this.logger.debug(`Updated profile LSN for client ${clientId} to ${lsn}`);
      }
    });
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
    
    // Create WebSocketConnection for this client
    const connection = new WebSocketConnection(clientId, profile.lsn);
    
    // Create client entry
    this.clients.set(clientId, {
      id: clientId,
      connection,
      profileId
    });
    
    // IMPORTANT: Initialize the LSN in MessageDispatcher
    messageDispatcher.updateClientLSN(clientId, profile.lsn);
    this.logger.info(`Initialized MessageDispatcher with LSN ${profile.lsn} for client ${clientId}`);
    
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
    
    if (client.connection.getStatus() === 'connected') {
      this.logger.warn(`Client ${clientId} is already connected`);
      return;
    }
    
    try {
      // Connect with options
      await client.connection.connect(serverUrl, {
        timeout: options.timeout || WS_CONFIG.CONNECT_TIMEOUT,
        lsn: options.lsn || client.connection.getLSN()
      });
      
      this.logger.info(`Client ${clientId} connected successfully`);
    } catch (error) {
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
    
    if (client.connection.getStatus() !== 'connected') {
      throw new Error(`Client ${clientId} is not connected`);
    }
    
    const lsn = fromLSN || client.connection.getLSN();
    
    this.logger.info(`Sending catchup request for client ${clientId} from LSN ${lsn}`);
    await client.connection.sendMessage({
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
        messageDispatcher.removeHandler('srv_catchup_completed', catchupHandler);
        reject(new Error('Catchup handshake timed out'));
      }, timeout);
      
      const catchupHandler = (message: any) => {
        if (message.clientId === clientId) {
          clearTimeout(timeoutId);
          messageDispatcher.removeHandler('srv_catchup_completed', catchupHandler);
          this.logger.info(`Catchup completed for client ${clientId}`);
          resolve();
        }
        return true;
      };
      
      messageDispatcher.registerHandler('srv_catchup_completed', catchupHandler);
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
    if (client.connection.getLSN() === '0/0') {
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
    if (client.connection.getStatus() === 'disconnected') {
      this.logger.debug(`Client ${clientId} is already disconnected`);
      return;
    }
    
    try {
      // Disconnect the WebSocket connection
      await client.connection.disconnect();
      
      // Clear this client from the profile
      await this.clearActiveClientFromProfile(clientId, client.profileId);
      
      this.logger.info(`Client ${clientId} disconnected`);
    } catch (error) {
      this.logger.error(`Error disconnecting client ${clientId}: ${error}`);
      
      // Still try to clear from profile even on error
      await this.clearActiveClientFromProfile(clientId, client.profileId);
    }
  }
  
  /**
   * Send a message through a client
   * @param clientId The client ID
   * @param message The message to send
   */
  async sendMessage(clientId: string, message: any): Promise<void> {
    const client = this.getClient(clientId);
    
    try {
      await client.connection.sendMessage(message);
    } catch (error) {
      this.logger.error(`Failed to send message for client ${clientId}: ${error}`);
      throw error;
    }
  }
  
  /**
   * Register a handler for a specific message type
   * @param messageType Message type to handle
   * @param handler Handler function
   */
  registerMessageHandler(messageType: string, handler: (message: any) => boolean | Promise<boolean>): void {
    messageDispatcher.registerHandler(messageType, handler);
    this.logger.debug(`Registered handler for message type: ${messageType}`);
  }
  
  /**
   * Get the current LSN for a client
   * @param clientId The client ID
   * @returns The current LSN or null
   * 
   * NOTE: MessageDispatcher is the source of truth for LSN tracking.
   * Connection layer is only consulted as fallback for backward compatibility.
   */
  getCurrentLSN(clientId: string): string | null {
    // MessageDispatcher is the source of truth for LSN
    const dispatcherLSN = messageDispatcher.getClientLSN(clientId);
    if (dispatcherLSN) return dispatcherLSN;
    
    // Fallback to connection's LSN only if not in MessageDispatcher
    // This is for backward compatibility only
    try {
      const client = this.getClient(clientId);
      return client.connection.getLSN();
    } catch (error) {
      // If client not found, return null
      this.logger.warn(`Client ${clientId} not found when getting LSN`);
      return null;
    }
  }
  
  /**
   * Get the connection status for a client
   * @param clientId The client ID
   * @returns The client status
   */
  getClientStatus(clientId: string): ConnectionStatus {
    const client = this.getClient(clientId);
    return client.connection.getStatus();
  }
  
  /**
   * Check if a client connection was hibernated
   * @param clientId The client ID
   * @returns True if hibernation was detected
   */
  wasClientHibernated(clientId: string): boolean {
    // Always return false since we're not tracking hibernation anymore
    return false;
  }
  
  /**
   * Reset hibernation state for a client
   * @param clientId The client ID
   */
  resetClientHibernationState(clientId: string): void {
    // No-op since we're not tracking hibernation anymore
  }
  
  /**
   * Update the LSN for a client
   * @param clientId The client ID 
   * @param lsn The new LSN
   * 
   * NOTE: MessageDispatcher is the source of truth for LSN tracking.
   * Connection layer is updated for backward compatibility only.
   */
  updateLSN(clientId: string, lsn: string): void {
    // MessageDispatcher is the source of truth - update it first
    // This also emits an event that will update profiles
    messageDispatcher.updateClientLSN(clientId, lsn);
    
    // Update connection's LSN as well for backward compatibility
    try {
      const client = this.getClient(clientId);
      client.connection.updateLSN(lsn);
      this.logger.debug(`Updated LSN for client ${clientId} to ${lsn}`);
    } catch (error) {
      this.logger.warn(`Client ${clientId} not found when updating LSN, but MessageDispatcher was updated`);
    }
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
    if (client.connection.getStatus() === 'connected') {
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
   * Send a client acknowledgment message for server changes
   * @param clientId The client ID
   * @param lsn The LSN to acknowledge
   * @param messageId Optional message ID for tracking
   */
  async sendChangesAcknowledgment(clientId: string, lsn: string, messageId?: string): Promise<void> {
    const client = this.getClient(clientId);
    
    if (client.connection.getStatus() !== 'connected') {
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
    
    await client.connection.sendMessage(message);
    
    // Update LSN in central message dispatcher
    messageDispatcher.updateClientLSN(clientId, lsn);
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