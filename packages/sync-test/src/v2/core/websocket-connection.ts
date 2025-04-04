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
 * Simple WebSocketConnection class - minimal implementation for reliable connections
 */
export class WebSocketConnection {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private clientId: string;
  private lsn: string;
  private logger: any;

  constructor(clientId: string, lsn: string = '0/0') {
    this.clientId = clientId;
    this.lsn = lsn;
    this.logger = createLogger('websocket-connection');
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
   */
  getLSN(): string {
    return this.lsn;
  }

  /**
   * Update the connection's LSN
   */
  updateLSN(lsn: string): void {
    this.lsn = lsn;
  }

  /**
   * Connect to WebSocket server - simplified for reliability
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
    
    return new Promise<void>((resolve, reject) => {
      try {
        // Create WebSocket
        this.logger.info(`Connecting to: ${wsUrl.toString()}`);
        this.ws = new WebSocket(wsUrl.toString());
        
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
        this.ws.on('open', () => {
          clearTimeout(timeout);
          this.logger.info(`Client ${this.clientId} connected to ${wsUrl.toString()}`);
          this.status = 'connected';
          if (options.onConnect) options.onConnect();
          resolve();
        });
        
        this.ws.on('error', (error) => {
          clearTimeout(timeout);
          this.status = 'error';
          this.logger.error(`WebSocket connection error for client ${this.clientId}: ${error}`);
          if (options.onError) options.onError(error instanceof Error ? error : new Error(String(error)));
          reject(error);
        });
        
        this.ws.on('close', (code, reason) => {
          this.status = 'disconnected';
          this.logger.info(`Client ${this.clientId} disconnected with code ${code}, reason: ${reason || 'No reason'}`);
          
          if (options.onDisconnect) options.onDisconnect();
        });
        
        this.ws.on('message', (data) => {
          try {
            // Parse message
            let messageText: string;
            if (Buffer.isBuffer(data)) {
              messageText = data.toString('utf-8');
            } else if (data instanceof ArrayBuffer) {
              messageText = new TextDecoder().decode(data);
            } else {
              messageText = data.toString();
            }
            
            const message = JSON.parse(messageText);
            
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
      } catch (error) {
        this.status = 'error';
        this.logger.error(`Failed to connect client ${this.clientId}: ${error}`);
        reject(error);
      }
    });
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
   * Disconnect from the WebSocket server - simplified for reliability
   */
  async disconnect(): Promise<void> {
    // If already disconnected, just return
    if (this.status === 'disconnected' || this.ws === null) {
      this.logger.debug(`Client ${this.clientId} is already disconnected`);
      return;
    }
    
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
          
          // Give a little time for the disconnect message to reach the server
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (e) {
          // Ignore errors when sending disconnect message
        }
      }
      
      // Close the connection
      if (this.ws) {
        try {
          this.ws.close(1000, 'Normal closure');
        } catch (e) {
          // Ignore errors during close
        }
      }
      
      // Set status to disconnected
      this.status = 'disconnected';
      this.ws = null;
      
      this.logger.info(`Client ${this.clientId} disconnected`);
    } catch (error) {
      this.logger.error(`Error disconnecting client ${this.clientId}: ${error}`);
      
      // Ensure state is cleaned up even on error
      this.status = 'disconnected';
      this.ws = null;
    }
  }

  /**
   * Send a raw string or object message
   */
  send(message: string | Record<string, any>): void {
    if (this.status !== 'connected' || !this.ws) {
      this.logger.debug(`Cannot send message, client ${this.clientId} not connected`);
      return;
    }

    try {
      const serializedMessage = typeof message === 'string' ? message : JSON.stringify(message);
      this.ws.send(serializedMessage);
      
      if (typeof message === 'object' && message.type && !message.type.includes('heartbeat')) {
        this.logger.debug(`Sent message to server: ${message.type}`);
      }
    } catch (error) {
      this.logger.error(`Error sending message for client ${this.clientId}: ${error}`);
    }
  }
} 