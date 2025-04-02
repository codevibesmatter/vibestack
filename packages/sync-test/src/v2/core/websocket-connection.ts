import WebSocket from 'ws';
import { createLogger } from './logger.ts';
import { WS_CONFIG } from '../config.ts';
import { messageDispatcher } from './message-dispatcher.ts';

// Define client status type
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// Connection options
export interface ConnectionOptions {
  timeout?: number;
  lsn?: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

/**
 * WebSocketConnection handles the low-level connection management
 * It focuses solely on the WebSocket lifecycle, not on message processing
 * 
 * NOTE: For LSN handling, this class only needs to know about LSN during connection.
 * All LSN tracking should be done by MessageDispatcher, not here.
 * The getLSN/updateLSN methods are maintained for backward compatibility.
 */
export class WebSocketConnection {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private logger = createLogger('websocket-connection');
  private connectionPromise: Promise<void> | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private clientId: string;
  private lsn: string;

  constructor(clientId: string, lsn: string = '0/0') {
    this.clientId = clientId;
    this.lsn = lsn;
    this.logger.info(`WebSocketConnection instance created for client ${clientId}`);
  }

  /**
   * Get the current connection status
   */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Get the current LSN
   * NOTE: This method is kept for backward compatibility.
   * LSN tracking should be done by MessageDispatcher, not here.
   */
  getLSN(): string {
    return this.lsn;
  }

  /**
   * Update the connection's LSN
   * NOTE: This method is kept for backward compatibility.
   * LSN tracking should be done by MessageDispatcher, not here.
   */
  updateLSN(lsn: string): void {
    this.lsn = lsn;
  }

  /**
   * Connect to WebSocket server
   */
  async connect(serverUrl: string = WS_CONFIG.URL, options: ConnectionOptions = {}): Promise<void> {
    if (this.status === 'connected') {
      this.logger.warn(`Client ${this.clientId} is already connected`);
      return;
    }

    // Update connection status
    this.status = 'connecting';
    
    // Configure WebSocket URL with client ID and LSN
    const wsUrl = new URL(serverUrl);
    wsUrl.searchParams.set('clientId', this.clientId);
    
    // Always include LSN parameter
    const lsn = options.lsn || this.lsn;
    if (lsn) {
      wsUrl.searchParams.set('lsn', lsn);
      this.logger.info(`Connecting with LSN: ${lsn}`);
    }
    
    try {
      // Create WebSocket
      this.logger.info(`Connecting to: ${wsUrl.toString()}`);
      this.ws = new WebSocket(wsUrl.toString());
      
      // Create connection promise
      this.connectionPromise = new Promise<void>((resolve, reject) => {
        // Set timeout for connection
        const timeout = setTimeout(() => {
          reject(new Error(`Connection timeout for client ${this.clientId}`));
          
          if (this.ws) {
            this.ws.close();
            this.ws = null;
          }
          
          this.status = 'error';
        }, options.timeout || WS_CONFIG.CONNECT_TIMEOUT);
        
        // Set up event handlers
        this.ws!.on('open', () => {
          this.logger.info(`Client ${this.clientId} connected to ${wsUrl.toString()}`);
          this.status = 'connected';
          if (options.onConnect) options.onConnect();
          resolve();
        });
        
        this.ws!.on('error', (error) => {
          clearTimeout(timeout);
          this.status = 'error';
          this.logger.error(`WebSocket connection error for client ${this.clientId}: ${error}`);
          if (options.onError) options.onError(error instanceof Error ? error : new Error(String(error)));
          reject(error);
        });
        
        this.ws!.on('close', () => {
          this.status = 'disconnected';
          this.logger.info(`Client ${this.clientId} disconnected`);
          if (options.onDisconnect) options.onDisconnect();
        });
        
        this.ws!.on('message', (data: WebSocket.Data) => {
          try {
            // Parse message and forward directly to the dispatcher
            const message = JSON.parse(data.toString());
            
            // Add clientId to ensure it's always present
            message.clientId = this.clientId;
            
            // Forward to the central message dispatcher
            messageDispatcher.dispatchMessage(message).catch(err => {
              this.logger.error(`Error dispatching message: ${err}`);
            });
          } catch (error) {
            this.logger.error(`Error processing message for client ${this.clientId}: ${error}`);
          }
        });
      });
      
      // Start heartbeat
      this.startHeartbeat();
      
      // Wait for connection
      await this.connectionPromise;
      
      // Return when connected
      return;
    } catch (error) {
      this.status = 'error';
      this.logger.error(`Failed to connect client ${this.clientId}: ${error}`);
      throw error;
    }
  }

  /**
   * Send a message through the WebSocket
   */
  async sendMessage(message: any): Promise<void> {
    if (this.status !== 'connected' || !this.ws) {
      throw new Error(`Client ${this.clientId} is not connected`);
    }
    
    try {
      // Add clientId to message if not present
      if (typeof message === 'object' && !message.clientId) {
        message.clientId = this.clientId;
      }
      
      // Send message
      this.ws.send(JSON.stringify(message));
      this.logger.debug(`Client ${this.clientId} sent message: ${message.type}`);
    } catch (error) {
      this.logger.error(`Failed to send message for client ${this.clientId}: ${error}`);
      throw error;
    }
  }

  /**
   * Disconnect from the WebSocket server
   */
  async disconnect(): Promise<void> {
    // If already disconnected, just return
    if (this.status === 'disconnected' || this.ws === null) {
      this.logger.debug(`Client ${this.clientId} is already disconnected`);
      return;
    }
    
    // Stop heartbeat immediately
    this.stopHeartbeat();
    
    try {
      // Send a disconnect message if possible
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({
            type: 'clt_disconnect',
            clientId: this.clientId,
            timestamp: Date.now(),
            message: 'Client disconnecting'
          }));
        } catch (e) {
          // Ignore errors when sending disconnect message
        }
      }
      
      // Close the connection
      if (this.ws) {
        try {
          this.ws.close();
        } catch (e) {
          // Ignore errors during close
        }
        
        // Force cleanup immediately
        this.forceTerminate();
      }
      
      this.logger.info(`Client ${this.clientId} disconnected`);
    } catch (error) {
      this.logger.error(`Error disconnecting client ${this.clientId}: ${error}`);
      
      // Ensure cleanup happens even on error
      this.forceTerminate();
    }
  }

  /**
   * Force terminate the WebSocket connection
   */
  private forceTerminate(): void {
    // Clean up state
    this.status = 'disconnected';
    
    // Force terminate WebSocket
    if (this.ws) {
      try {
        this.ws.terminate(); // More aggressive than close()
      } catch (e) {
        // Ignore errors during termination
      }
      
      // Nullify references for garbage collection
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      this.ws = null;
    }
    
    this.logger.debug(`Force terminated client ${this.clientId}`);
  }

  /**
   * Start heartbeat for the connection
   */
  private startHeartbeat(): void {
    // Clear any existing heartbeat interval
    this.stopHeartbeat();
    
    this.heartbeatInterval = setInterval(() => {
      if (this.status !== 'connected' || !this.ws) {
        this.stopHeartbeat();
        return;
      }
      
      try {
        this.ws.send(JSON.stringify({
          type: 'clt_heartbeat',
          clientId: this.clientId,
          timestamp: Date.now()
        }));
        
        this.logger.debug(`Sent heartbeat for client ${this.clientId}`);
      } catch (error) {
        this.logger.error(`Error sending heartbeat for client ${this.clientId}: ${error}`);
        this.stopHeartbeat();
      }
    }, WS_CONFIG.HEARTBEAT_INTERVAL);
  }

  /**
   * Stop heartbeat for the connection
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.logger.debug(`Stopped heartbeat for client ${this.clientId}`);
    }
  }
} 