import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from './logger.ts';
import { WS_CONFIG } from '../config.ts';
import { ClientProfileManager, ClientProfile } from './client-profile-manager.ts';
import * as dbService from './db-service.ts';

// Define client status type
type ClientStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// WebSocket message handler type
type MessageHandler = (message: any) => void;

// Client instance type
interface WSClient {
  id: string;
  ws: WebSocket | null;
  status: ClientStatus;
  lsn: string | null;
  profileId: number;
  connectionPromise: Promise<void> | null;
  messageHandlers: Set<MessageHandler>;
  disconnectResolver: (() => void) | null;
}

export class WebSocketClientFactory {
  private clients: Map<string, WSClient> = new Map();
  private logger = createLogger('ws-client-factory');
  private wsConfig = { ...WS_CONFIG };
  private profileManager: ClientProfileManager;
  
  constructor() {
    this.profileManager = new ClientProfileManager();
  }
  
  /**
   * Create a new WebSocket client with associated profile
   * @param profileId Profile ID to use (creates new profile if needed)
   * @returns The client ID
   */
  async createClient(profileId: number = 1): Promise<string> {
    // Get or create client profile
    const profile = await this.profileManager.getProfile(profileId);
    this.logger.info(`Using profile: ${profile.name} (ID: ${profile.profileId}) with LSN: ${profile.lsn}`);
    
    // Generate a unique client ID
    const clientId = `client-${uuidv4()}`;
    
    // Create client 
    this.clients.set(clientId, {
      id: clientId,
      ws: null,
      status: 'disconnected',
      lsn: profile.lsn,
      profileId,
      connectionPromise: null,
      messageHandlers: new Set(),
      disconnectResolver: null
    });
    
    this.logger.info(`Created new client: ${clientId} with profile ${profileId}`);
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
          clearTimeout(timeout);
          client.status = 'connected';
          this.logger.info(`Client ${clientId} connected to ${serverUrl}`);
          resolve();
        });
        
        client.ws!.on('error', (error) => {
          clearTimeout(timeout);
          client.status = 'error';
          this.logger.error(`Error in client ${clientId}: ${error.message}`);
          reject(error);
        });
        
        client.ws!.on('close', () => {
          client.status = 'disconnected';
          this.logger.info(`Client ${clientId} disconnected`);
          
          // Resolve disconnect promise if it exists
          if (client.disconnectResolver) {
            client.disconnectResolver();
            client.disconnectResolver = null;
          }
        });
        
        client.ws!.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            this.logger.debug(`Client ${clientId} received message: ${message.type}`);
            
            // Update LSN if present and save to profile
            if (message.lsn) {
              client.lsn = message.lsn;
              this.profileManager.updateLSN(client.profileId, message.lsn);
              this.logger.debug(`Updated LSN for client ${clientId} to ${message.lsn}`);
            }
            
            // Call all message handlers
            client.messageHandlers.forEach(handler => {
              try {
                handler(message);
              } catch (err) {
                this.logger.error(`Error in message handler: ${err}`);
              }
            });
          } catch (err) {
            this.logger.error(`Error parsing message: ${err}`);
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
   * Disconnect a client
   * @param clientId The client ID
   * @returns Promise that resolves when disconnected
   */
  async disconnectClient(clientId: string): Promise<void> {
    const client = this.getClient(clientId);
    
    if (client.status === 'disconnected') {
      this.logger.warn(`Client ${clientId} is already disconnected`);
      return;
    }
    
    if (!client.ws) {
      client.status = 'disconnected';
      return;
    }
    
    return new Promise<void>((resolve) => {
      client.disconnectResolver = resolve;
      
      try {
        client.ws!.close();
      } catch (err) {
        this.logger.error(`Error closing client ${clientId}: ${err}`);
        client.status = 'disconnected';
        resolve();
      }
    });
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
    
    const interval = setInterval(() => {
      if (client.status !== 'connected' || !client.ws) {
        clearInterval(interval);
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
        clearInterval(interval);
      }
    }, WS_CONFIG.HEARTBEAT_INTERVAL);
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
}

// Export singleton instance
export const wsClientFactory = new WebSocketClientFactory(); 