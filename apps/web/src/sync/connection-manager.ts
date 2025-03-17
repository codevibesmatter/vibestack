/**
 * Connection Manager for Sync Worker
 * 
 * Handles WebSocket connection management with simple offline detection
 * and periodic reconnection attempts.
 */

import { syncLogger } from '../utils/logger';
import { ConnectionState } from './message-types';
import { ClientChangeHandler } from './changes/client-changes';

// Constants
const RECONNECT_INTERVAL = 30000; // 30 seconds
const CONNECTION_TIMEOUT = 10000; // 10 seconds
const HEARTBEAT_INTERVAL = 300000; // 5 minutes (300,000 ms)
const HEARTBEAT_LOG_INTERVAL = 60000; // 1 minute (60,000 ms)

/**
 * Connection Manager
 */
export class ConnectionManager {
  private ws: WebSocket | null = null;
  private state: ConnectionState;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private heartbeatLogTimer: number | null = null;
  private connectionTimeout: number | null = null;
  private heartbeatMinuteCounter: number = 0;
  private lastHeartbeatResponse: number = 0;
  private clientChangeHandler: ClientChangeHandler | null = null;
  
  // Callbacks
  private onMessage: (data: any) => void;
  private onStatusChange: (state: ConnectionState) => void;
  private onError: (message: string, details?: any) => void;
  
  constructor(
    initialState: ConnectionState,
    onMessage: (data: any) => void,
    onStatusChange: (state: ConnectionState) => void,
    onError: (message: string, details?: any) => void
  ) {
    this.state = initialState;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
    this.onError = onError;
  }
  
  /**
   * Set the client change handler
   */
  public setClientChangeHandler(handler: ClientChangeHandler): void {
    this.clientChangeHandler = handler;
  }
  
  /**
   * Connect to the sync server
   */
  public connect(wsUrl: string, clientId: string, lastLSN: string): void {
    // Don't connect if already connected or connecting
    if (this.state.isConnected || this.state.isConnecting) {
      return;
    }
    
    // Update state
    this.state.wsUrl = wsUrl;
    this.state.clientId = clientId;
    this.state.lastLSN = lastLSN; // Store LSN for sync message
    this.state.isConnecting = true;
    this.onStatusChange(this.state);
    
    // Clean up any existing connection
    this.cleanupWebSocket();
    
    try {
      // Ensure the WebSocket URL is properly formatted
      let wsUrlString = wsUrl;
      
      // If it's an HTTP URL, convert it to WS
      if (wsUrlString.startsWith('http://')) {
        wsUrlString = wsUrlString.replace('http://', 'ws://');
      } else if (wsUrlString.startsWith('https://')) {
        wsUrlString = wsUrlString.replace('https://', 'wss://');
      }
      
      // If it doesn't start with ws:// or wss://, assume ws://
      if (!wsUrlString.startsWith('ws://') && !wsUrlString.startsWith('wss://')) {
        wsUrlString = `ws://${wsUrlString}`;
      }
      
      // Create WebSocket URL with only clientId
      const url = new URL('/api/sync', wsUrlString);
      url.searchParams.set('clientId', clientId);
      
      syncLogger.info('Connecting to sync server', {
        clientId,
        url: url.toString()
      });
      
      // Create WebSocket
      this.ws = new WebSocket(url.toString());
      
      // Set up event handlers
      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onclose = this.handleClose.bind(this);
      this.ws.onerror = this.handleError.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
      
      // Set up connection timeout
      this.connectionTimeout = self.setTimeout(() => {
        if (!this.state.isConnected) {
          syncLogger.warn('Connection timeout - closing socket', {
            clientId: this.state.clientId,
            wsUrl: this.state.wsUrl
          });
          this.cleanupWebSocket();
          this.onError('Connection timeout', { wsUrl: this.state.wsUrl });
        }
      }, CONNECTION_TIMEOUT);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      syncLogger.error('Failed to create WebSocket', { error: errorMessage });
      this.onError('Failed to create WebSocket', { message: errorMessage });
      this.state.isConnecting = false;
      this.onStatusChange(this.state);
    }
  }
  
  /**
   * Disconnect from the sync server
   */
  public disconnect(graceful: boolean = true): void {
    // Cancel any pending reconnect
    this.cancelReconnect();
    
    if (graceful && this.ws && this.ws.readyState === WebSocket.OPEN) {
      syncLogger.info('Gracefully disconnecting from sync server');
      // Send graceful disconnect message
      this.sendToServer({
        type: 'disconnect',
        clientId: this.state.clientId,
        message: 'Client disconnecting gracefully'
      });
      
      // Give the server a moment to process the disconnect message
      setTimeout(() => {
        this.cleanupWebSocket();
      }, 200);
    } else {
      syncLogger.info('Forcefully disconnecting from sync server');
      this.cleanupWebSocket();
    }
    
    // Update state
    this.state.isConnected = false;
    this.state.isConnecting = false;
    this.onStatusChange(this.state);
  }
  
  /**
   * Send a message to the server
   */
  public sendMessage(message: any): boolean {
    return this.sendToServer(message);
  }
  
  /**
   * Get the current connection state
   */
  public getState(): ConnectionState {
    return { ...this.state };
  }
  
  /**
   * Update the connection state
   */
  public updateState(newState: ConnectionState): void {
    Object.assign(this.state, newState);
    this.onStatusChange(this.state);
  }
  
  /**
   * Clean up resources
   */
  public cleanup(): void {
    this.cancelReconnect();
    this.stopHeartbeat();
    this.cleanupWebSocket();
  }
  
  /**
   * Handle WebSocket open event
   */
  private handleOpen(): void {
    // Update state
    this.state.isConnected = true;
    this.state.isConnecting = false;
    this.onStatusChange(this.state);
    
    syncLogger.info('Connected to sync server', {
      clientId: this.state.clientId,
      lastLSN: this.state.lastLSN
    });
    
    // Send initial sync request
    this.sendToServer({
      type: 'sync',
      clientId: this.state.clientId,
      lastLSN: this.state.lastLSN
    });
    
    // Start heartbeat
    this.startHeartbeat();
    
    // Cancel any pending reconnect
    this.cancelReconnect();
  }
  
  /**
   * Process any unsynced changes after connection is restored
   */
  private async processUnsyncedChanges(): Promise<void> {
    if (!this.clientChangeHandler) {
      syncLogger.warn('No client change handler available for processing unsynced changes');
      return;
    }

    try {
      syncLogger.info('Processing unsynced changes after connection restored');
      await this.clientChangeHandler.processUnsyncedChanges();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      syncLogger.error('Failed to process unsynced changes', { error: errorMessage });
      this.onError('Failed to process unsynced changes', { error: errorMessage });
    }
  }
  
  /**
   * Handle WebSocket message event
   */
  private handleMessage(event: MessageEvent): void {
    try {
      // Parse the message
      const data = JSON.parse(event.data);
      
      // Log sync_ack messages
      if (data.type === 'sync_ack') {
        syncLogger.info('Received sync acknowledgment', {
          clientId: data.clientId,
          lastLSN: data.lastLSN
        });

        // Process unsynced changes after receiving sync_ack
        this.processUnsyncedChanges();
      }
      // Only log detailed message info at debug level for non-heartbeat messages
      else if (data.type !== 'heartbeat') {
        syncLogger.debug('Received message from server', {
          type: data.type,
          messageKeys: Object.keys(data),
          hasChanges: data.changes ? 'yes' : 'no',
          changesLength: data.changes?.length || 0
        });
      }
      
      // Reset heartbeat counter on any message
      this.heartbeatMinuteCounter = 0;
      this.lastHeartbeatResponse = Date.now();
      
      // Forward the message to the callback
      this.onMessage(data);
    } catch (error: any) {
      this.onError(`Error parsing message: ${error.message}`, error);
    }
  }
  
  /**
   * Handle WebSocket close event
   */
  private handleClose(event: CloseEvent): void {
    // Update state
    this.state.isConnected = false;
    this.state.isConnecting = false;
    this.onStatusChange(this.state);
    
    syncLogger.info('Disconnected from sync server', {
      wasClean: event.wasClean,
      code: event.code,
      reason: event.reason || 'No reason provided'
    });
    
    // Stop heartbeat
    this.stopHeartbeat();
    
    // Clean up WebSocket
    this.cleanupWebSocket();
    
    // Schedule reconnect
    this.scheduleReconnect();
  }
  
  /**
   * Handle WebSocket error event
   */
  private handleError(event: Event): void {
    syncLogger.error('WebSocket error occurred', event);
    this.onError('WebSocket error occurred');
    // Note: We don't need to clean up here as the close event will be fired after an error
  }
  
  /**
   * Send a message to the server
   */
  public sendToServer(message: any): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      syncLogger.warn('Cannot send message - WebSocket not connected', {
        message,
        readyState: this.ws?.readyState,
        isConnected: this.state.isConnected
      });
      return false;
    }

    try {
      // Log the full message details before sending
      syncLogger.info('Preparing to send message to server:', {
        type: message.type,
        clientId: message.clientId,
        lastLSN: message.lastLSN,
        resetSync: message.resetSync,
        fullMessage: JSON.stringify(message)
      });
      
      this.ws.send(JSON.stringify(message));
      
      // Log confirmation after sending
      syncLogger.info('Message sent to server successfully');
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      syncLogger.error('Failed to send message to server:', { error: errorMessage });
      this.onError('Failed to send message to server', error);
      return false;
    }
  }
  
  /**
   * Clean up the WebSocket instance
   */
  private cleanupWebSocket(): void {
    if (!this.ws) return;
    
    try {
      // Clear connection timeout if it exists
      if (this.connectionTimeout !== null) {
        self.clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }
      
      // Remove event handlers
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      
      // Close the connection if not already closed
      if (this.ws.readyState !== WebSocket.CLOSED) {
        this.ws.close();
        syncLogger.debug('WebSocket connection closed');
      }
    } catch (error: any) {
      syncLogger.error('Error cleaning up WebSocket', error);
      this.onError(`Error cleaning up WebSocket: ${error.message}`);
    } finally {
      this.ws = null;
    }
  }
  
  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    // Cancel any existing reconnect timer
    this.cancelReconnect();
    
    // Schedule new reconnect
    this.reconnectTimer = self.setTimeout(() => {
      this.reconnectTimer = null;
      
      // Only reconnect if we have the necessary information
      if (this.state.wsUrl && this.state.clientId) {
        syncLogger.info('Attempting to reconnect', {
          clientId: this.state.clientId,
          lastLSN: this.state.lastLSN
        });
        this.connect(this.state.wsUrl, this.state.clientId, this.state.lastLSN);
      } else {
        syncLogger.warn('Cannot reconnect - missing connection information', {
          wsUrl: this.state.wsUrl,
          clientId: this.state.clientId
        });
      }
    }, RECONNECT_INTERVAL) as unknown as number;
    
    syncLogger.info('Scheduled reconnect attempt', {
      delay: RECONNECT_INTERVAL / 1000,
      unit: 'seconds'
    });
  }
  
  /**
   * Cancel any pending reconnection attempt
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      self.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
  
  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    // Stop any existing heartbeat
    this.stopHeartbeat();
    
    syncLogger.debug('Starting heartbeat with initial delay', {
      delay: HEARTBEAT_INTERVAL / 1000,
      unit: 'seconds'
    });
    
    // Reset minute counter
    this.heartbeatMinuteCounter = 0;
    
    // Start the 1-minute increment logs
    this.startHeartbeatLogs();
    
    // Start new heartbeat with initial delay to avoid sending right after connection
    this.heartbeatTimer = self.setTimeout(() => {
      // Send initial heartbeat after delay
      if (this.state.isConnected) {
        syncLogger.debug('Sending heartbeat');
        const heartbeatMessage: any = {
          type: 'sync',
          clientId: this.state.clientId,
          lastLSN: this.state.lastLSN
        };
        
        this.sendToServer(heartbeatMessage);
      }
      
      // Set up recurring heartbeat
      this.heartbeatTimer = self.setInterval(() => {
        if (this.state.isConnected) {
          // Reset minute counter when sending heartbeat
          this.heartbeatMinuteCounter = 0;
          
          syncLogger.debug('Sending heartbeat');
          const heartbeatMessage: any = {
            type: 'sync',
            clientId: this.state.clientId,
            lastLSN: this.state.lastLSN
          };
          
          this.sendToServer(heartbeatMessage);
        } else {
          syncLogger.debug('Stopping heartbeat - connection lost');
          this.stopHeartbeat();
        }
      }, HEARTBEAT_INTERVAL) as unknown as number;
    }, HEARTBEAT_INTERVAL) as unknown as number;
  }
  
  /**
   * Start heartbeat logs at 1-minute increments
   */
  private startHeartbeatLogs(): void {
    // Stop any existing heartbeat logs
    this.stopHeartbeatLogs();
    
    // Set up recurring 1-minute logs
    this.heartbeatLogTimer = self.setInterval(() => {
      if (this.state.isConnected) {
        this.heartbeatMinuteCounter++;
        
        if (this.heartbeatMinuteCounter < 5) {
          syncLogger.info(`Heartbeat status: ${this.heartbeatMinuteCounter} minute(s) since last heartbeat, ${5 - this.heartbeatMinuteCounter} minute(s) until next heartbeat`, {
            minutesPassed: this.heartbeatMinuteCounter,
            minutesRemaining: 5 - this.heartbeatMinuteCounter,
            clientId: this.state.clientId
          });
        }
      }
    }, HEARTBEAT_LOG_INTERVAL) as unknown as number;
  }
  
  /**
   * Stop heartbeat logs
   */
  private stopHeartbeatLogs(): void {
    if (this.heartbeatLogTimer !== null) {
      self.clearInterval(this.heartbeatLogTimer);
      this.heartbeatLogTimer = null;
    }
  }
  
  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    // Stop the heartbeat timer
    if (this.heartbeatTimer !== null) {
      self.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    // Stop the heartbeat log timer
    this.stopHeartbeatLogs();
    
    // Reset the minute counter
    this.heartbeatMinuteCounter = 0;
  }

  /**
   * Handle heartbeat response from server
   */
  private handleHeartbeatResponse(): void {
    this.lastHeartbeatResponse = Date.now();
    this.heartbeatMinuteCounter = 0;
  }
} 