import { v4 as uuidv4 } from 'uuid';
import { getNewPGliteDataSource, NewPGliteDataSource } from '../db/newtypeorm/NewDataSource';
import { getSyncWebSocketUrl } from './config';
import { SyncEventEmitter } from './SyncEventEmitter';
import { SyncMetadata } from '@repo/dataforge/client-entities';

// Define sync states
export type SyncState = 'disconnected' | 'connecting' | 'initial' | 'catchup' | 'live';

// Basic message types - can be expanded based on actual needs
export interface BaseMessage {
  type: string;
  clientId: string;
  messageId: string;
  timestamp: number;
}

export interface ClientMessage extends BaseMessage {
  // Base message fields (inherited)
  // type: string;
  // clientId: string;
  // messageId: string;
  // timestamp: number;
  
  // Common optional fields
  inReplyTo?: string;   // For acknowledgment messages
  lsn?: string;         // For LSN reporting
  resetSync?: boolean;  // For resetting sync state
  
  // Fields for specific message types
  changes?: Array<any>; // For clt_send_changes messages
  
  // Catchup acknowledgment fields
  chunk?: number;       // For clt_catchup_received messages
  
  // Change acknowledgment fields
  changeIds?: string[]; // For clt_changes_received messages
  lastLSN?: string;     // For clt_changes_received messages
  
  // Table acknowledgment fields (for initial sync)
  table?: string;       // For clt_init_received messages
  
  // Error reporting
  error?: string;       // For error messages
  
  // Any other properties
  [key: string]: any;  // Allow additional properties for backward compatibility
}

export interface ServerMessage extends BaseMessage {
  // Additional server message fields
  state?: SyncState;     // For state change messages
  lsn?: string;          // For LSN update messages
  changes?: Array<any>;  // For table change messages
  serverLSN?: string;    // For initial sync
  changeIds?: string[];  // For acknowledgments
  error?: any;           // For error messages
  
  // Sequence information for chunked messages (e.g., initial sync)
  sequence?: {
    table?: string;
    chunk?: number;
    total?: number;
    [key: string]: any; // Allow other sequence properties
  };
  
  // LSN associated with changes
  lastLSN?: string;
}

export interface ServerLiveStartMessage extends ServerMessage {
  finalLSN: string;
}

/**
 * SyncManager
 * 
 * A consolidated class that handles sync state, WebSocket connection,
 * message processing, and change management.
 * 
 * Implements a proper singleton pattern.
 */
export class SyncManager {
  // Singleton instance
  private static instance: SyncManager | null = null;
  
  // Add debug mode flag
  private static debugMode: boolean = process.env.NODE_ENV === 'development' && false; // Set to true only when needed
  
  // Core state
  private clientId: string = '';
  private currentLSN: string = '0/0';
  private syncState: SyncState = 'disconnected';
  private webSocket: WebSocket | null = null;
  private pendingChanges: number = 0;
  private lastSyncTime: Date | null = null;
  
  // Schema version tracking
  private currentSchemaVersion: string = '1.0';
  
  // Error tracking for fallback
  private syncErrorCount: number = 0;
  private MAX_SYNC_ERRORS = 3;
  
  // Event emitter for component communication
  // Make public to allow sharing with SyncChangeManager
  public events = new SyncEventEmitter();
  
  // Database key for storing sync metadata
  private metadataKey: string = 'sync';
  
  // Connection settings
  private serverUrl: string = '';
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 2000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private autoConnect: boolean = true; // Whether to auto-connect
  
  // Initialization state
  private isInitialized: boolean = false;
  private isInitializing: boolean = false;
  private initPromise: Promise<void> | null = null;
  
  // Add a tracking variable at the class level
  private isDisconnecting: boolean = false;
  
  // Add debounce tracking at the class level
  private saveMetadataDebounceTimer: NodeJS.Timeout | null = null;
  private pendingMetadataSave: boolean = false;
  private readonly SAVE_DEBOUNCE_DELAY = 500; // ms
  
  /**
   * Private constructor - use getInstance() instead
   */
  private constructor() {
    console.log('[SyncManager] Constructor: Creating new SyncManager instance');
    console.log('SyncManager: Creating instance');
  }
  
  /**
   * Get the singleton instance
   */
  public static getInstance(): SyncManager {
    // Only log when in debug mode
    if (SyncManager.debugMode) {
      console.log('[SyncManager.getInstance] Getting instance');
    }
    
    if (!SyncManager.instance) {
      // Only log instance creation, which should happen once
      console.log('[SyncManager] Creating new instance');
      SyncManager.instance = new SyncManager();
    }
    
    return SyncManager.instance;
  }
  
  /**
   * Initialize the sync manager
   * Loads data from database and sets up initial state
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log('SyncManager: Already initialized');
      return;
    }
    
    if (this.isInitializing) {
      console.log('SyncManager: Already initializing, waiting for completion');
      return this.initPromise as Promise<void>;
    }
    
    this.isInitializing = true;
    
    this.initPromise = (async () => {
      try {
        console.log('SyncManager: Beginning initialization sequence');
        await this.loadMetadata();
        
        // Register window event handlers for online/offline status
        window.addEventListener('online', this.handleOnline);
        
        this.isInitialized = true;
        this.isInitializing = false;
        console.log(`SyncManager: Initialization complete - clientId: ${this.clientId}, LSN: ${this.currentLSN}`);
      } catch (error) {
        console.error('SyncManager: Initialization failed', error);
        this.isInitializing = false;
        throw error;
      }
    })();
    
    return this.initPromise;
  }
  
  /**
   * Load sync metadata from the database
   */
  private async loadMetadata(): Promise<void> {
    console.log('SyncManager: Loading sync metadata from database using TypeORM');

    try {
        const dataSource = await getNewPGliteDataSource();
        if (!dataSource || !dataSource.isInitialized) {
            throw new Error('Failed to get initialized TypeORM DataSource for loading.');
        }

        const metadataRepo = dataSource.getRepository(SyncMetadata);

        // Find existing metadata (should be only one row)
        const existingMetadataArray = await metadataRepo.find(); // Use find() instead of raw query

        if (existingMetadataArray && existingMetadataArray.length > 0) {
            const metadata = existingMetadataArray[0]; // Get the first (only) row
            console.log(`SyncManager: Found existing sync metadata with ID: ${metadata.id}`);

            // Load data from existing record
            this.currentLSN = metadata.currentLsn || '0/0';
            // Ensure clientId exists, generate if somehow missing
            this.clientId = metadata.clientId || this.generateClientId(); 
            this.pendingChanges = metadata.pendingChangesCount || 0;
            this.lastSyncTime = metadata.lastSyncTime || null;

            console.log(`SyncManager: Loaded metadata - ClientID: ${this.clientId}, LSN: ${this.currentLSN}`);
            // Always start disconnected
            this.syncState = 'disconnected';

        } else {
            // No existing record, generate ID and create initial record
            console.log('SyncManager: No existing sync metadata found. Generating new client ID and creating initial record.');
            this.clientId = this.generateClientId();
            this.currentLSN = '0/0';
            this.syncState = 'disconnected';
            this.pendingChanges = 0;
            this.lastSyncTime = null;

            console.log(`SyncManager: Generated new ClientID: ${this.clientId}. Saving initial metadata.`);
            // Call the *correct* save function immediately
            await this.doSaveMetadata(); // Use the refactored save method
        }

    } catch (error) {
        console.error('SyncManager: Error loading/initializing sync metadata:', error);
        // Fallback: Generate a new client ID if loading fails completely
        console.log('SyncManager: Falling back to generating new client ID due to load error.');
        this.clientId = this.generateClientId();
        this.currentLSN = '0/0';
        this.syncState = 'disconnected';
        this.pendingChanges = 0;
        this.lastSyncTime = null;
        console.log(`SyncManager: Generated new ClientID after error: ${this.clientId}`);
        // Attempt an initial save in the fallback case as well
        try {
            await this.doSaveMetadata();
        } catch (saveError) {
            console.error('SyncManager: Failed to save fallback metadata:', saveError);
        }
    }
  }
  
  /**
   * Saves the current metadata state to the database using TypeORM repository.
   * This operation is debounced to prevent excessive database writes.
   * Attempts to find the single existing metadata row and updates it,
   * or creates a new one if none exists.
   */
  private async doSaveMetadata(): Promise<void> {
    try {
      const dataSource = await getNewPGliteDataSource();
      if (!dataSource || !dataSource.isInitialized) {
        console.error("SyncManager: DataSource not available or not initialized for saving metadata.");
        // Keep pending flag true for retry
        this.pendingMetadataSave = true; 
        return;
      }

      // Get the repository for SyncMetadata
      const metadataRepo = dataSource.getRepository(SyncMetadata);

      // Attempt to find the single existing metadata record
      // Since there should only ever be one, findOne() without args might work,
      // or find() and take the first element. Let's try find().
      const existingMetadataArray = await metadataRepo.find();
      let metadataToSave: SyncMetadata | undefined;

      if (existingMetadataArray && existingMetadataArray.length > 0) {
        // If found, update the existing record
        metadataToSave = existingMetadataArray[0];
        console.log(`SyncManager: Found existing metadata record with ID: ${metadataToSave.id}`);
        metadataToSave.clientId = this.clientId; // Update properties
        metadataToSave.currentLsn = this.currentLSN;
        metadataToSave.syncState = this.syncState;
        metadataToSave.lastSyncTime = this.lastSyncTime || new Date(); // Use current time if null
        metadataToSave.pendingChangesCount = this.pendingChanges;
      } else {
        // If not found, create a new record
        console.log(`SyncManager: No existing metadata record found. Creating new one.`);
        metadataToSave = metadataRepo.create({
          // ID will be auto-generated by the database (UUID)
          clientId: this.clientId,
          currentLsn: this.currentLSN,
          syncState: this.syncState,
          lastSyncTime: this.lastSyncTime || new Date(), // Use current time if null
          pendingChangesCount: this.pendingChanges
        });
      }
      
      // Log what we're attempting to save
      console.log(`SyncManager: Attempting to save metadata: ID=${metadataToSave.id}, ClientID=${metadataToSave.clientId}, LSN=${metadataToSave.currentLsn}, State=${metadataToSave.syncState}`);

      // Save the new or updated record
      await metadataRepo.save(metadataToSave);

      // Reset the pending flag
      this.pendingMetadataSave = false;

      // Log success
      console.log(`SyncManager: Saved metadata to database. LSN: ${this.currentLSN}, State: ${this.syncState}`);

    } catch (error) {
      console.error('SyncManager: Error saving metadata using Repository:', error);
      this.pendingMetadataSave = true; // Keep pending flag true for retry

      // Enhanced logging for development
      if (process.env.NODE_ENV !== 'production') {
        console.error('SyncManager: Error details:', {
          clientId: this.clientId,
          lsn: this.currentLSN,
          state: this.syncState,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  
  /**
   * Ensure any pending metadata is saved before the component unmounts
   */
  public flushMetadata(): Promise<void> {
    return this.doSaveMetadata(); // Use doSaveMetadata
  }
  
  /**
   * Connect to the sync server
   * @param serverUrl Optional server URL to connect to
   * @param suppressAuthErrors If true, don't emit errors for auth failures (useful during initial app load)
   */
  public async connect(serverUrl?: string, suppressAuthErrors: boolean = false): Promise<boolean> {
    console.log('SyncManager: Starting connection attempt');
    
    // First check authentication status via JWT token
    let authToken = '';
    let authError = false;
    
    try {
      console.log('SyncManager: Attempting to fetch JWT token');
      
      // Get the base URL from environment
      const apiBaseUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:8787";
      const tokenUrl = `${apiBaseUrl}/api/auth/token`;
      
      console.log('SyncManager: Requesting JWT token from:', tokenUrl);
      
      // Call the /token endpoint directly with credentials to get JWT token
      const tokenResponse = await fetch(tokenUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (tokenResponse.ok) {
        const tokenData = await tokenResponse.json();
        
        if (tokenData && tokenData.token) {
          authToken = tokenData.token;
          console.log('SyncManager: Successfully obtained JWT token');
        } else {
          console.warn('SyncManager: Token endpoint returned success but no token in response');
          authError = true;
        }
      } else {
        console.error('SyncManager: Failed to fetch JWT token -', 
          tokenResponse.status, tokenResponse.statusText);
          
        // If token endpoint fails with a 401, user is not authenticated
        if (tokenResponse.status === 401) {
          console.log('SyncManager: User is not authenticated for sync connection');
          authError = true;
          
          if (!suppressAuthErrors) {
            this.events.emit('error', new Error('Authentication required for sync'));
          }
          return false;
        }
      }
    } catch (tokenError) {
      console.error('SyncManager: Error fetching JWT token:', tokenError);
      authError = true;
    }
    
    // Verify we have a token before proceeding
    if (!authToken) {
      console.error('SyncManager: No valid authentication token obtained, cannot connect');
      
      if (authError && !suppressAuthErrors) {
        this.events.emit('error', new Error('Authentication required for sync'));
      } else if (!authError && !suppressAuthErrors) {
        // This is a different kind of error, not authentication related
        this.events.emit('error', new Error('Could not obtain authentication token'));
      }
      
      return false;
    }
    
    // If already connected, disconnect first
    if (this.webSocket) {
      console.log('SyncManager: Already connected, disconnecting first');
      this.disconnect(false);  // Don't change state when disconnecting
    }
    
    // Set connecting state
    this.setState('connecting');
    
    // Use provided URL or default
    if (serverUrl) {
      this.serverUrl = serverUrl;
    } else if (!this.serverUrl) {
      this.serverUrl = this.getDefaultServerUrl();
    }
    
    console.log(`SyncManager: Connecting to ${this.serverUrl}`);
    
    return new Promise<boolean>((resolve, reject) => {
      // Set timeout for connection
      const timeoutId = setTimeout(() => {
        console.log('SyncManager: Connection timeout');
        
        // Clean up if the WebSocket exists but hasn't connected or errored
        if (this.webSocket) {
          this.disconnect(true);
        }
        
        reject(new Error('Connection timeout'));
      }, 10000);
      
      // Build WebSocket URL with client ID, LSN, and auth token
      const wsUrl = new URL(this.serverUrl);
      wsUrl.searchParams.set('clientId', this.clientId);
      wsUrl.searchParams.set('lsn', this.currentLSN);
      
      // Add auth token
      wsUrl.searchParams.set('auth', authToken);
      console.log(`SyncManager: Adding JWT auth token to WebSocket URL`);
      
      console.log(`SyncManager: Connecting with LSN: ${this.currentLSN} and clientId: ${this.clientId}`);
      
      // Create WebSocket connection
      try {
        this.webSocket = new WebSocket(wsUrl.toString());
        
        // Set up event handlers with promise resolution
        this.webSocket.onopen = (event) => {
          console.log('SyncManager: WebSocket connected successfully');
          clearTimeout(timeoutId);
          this.handleOpen(event);
          
          // Reset errors since we successfully connected
          this.syncErrorCount = 0;
          
          resolve(true);
        };
        
        this.webSocket.onclose = (event) => {
          console.log(`SyncManager: WebSocket closed during connection: code=${event.code}, reason=${event.reason}`);
          clearTimeout(timeoutId);
          this.handleClose(event);
          
          // If we get a 401 unauthorized close, emit an auth error
          if (event.code === 1006 && event.reason && event.reason.includes('401')) {
            console.error('SyncManager: Authentication failed for WebSocket connection');
            
            if (!suppressAuthErrors) {
              this.events.emit('error', new Error('Authentication failed for sync connection'));
            }
            
            reject(new Error('Authentication failed: ' + event.reason));
          } else if (event.code !== 1000) {
            reject(new Error(`WebSocket closed with code ${event.code}: ${event.reason || 'No reason provided'}`));
          }
        };
        
        this.webSocket.onerror = (event) => {
          console.error('SyncManager: WebSocket error during connection', event);
          clearTimeout(timeoutId);
          this.handleError(event);
          reject(new Error('WebSocket connection error'));
        };
        
        this.webSocket.onmessage = this.handleMessage.bind(this);
        
      } catch (error) {
        clearTimeout(timeoutId);
        console.error('SyncManager: Error creating WebSocket', error);
        this.setState('disconnected');
        reject(error);
        return;
      }
    });
  }
  
  /**
   * Disconnect from the sync server
   */
  public disconnect(changeState: boolean = true): void {
    console.log('SyncManager: Disconnect called, current state:', this.syncState);
    
    // Prevent multiple disconnect operations
    if (this.isDisconnecting) {
      console.log('SyncManager: Already disconnecting, ignoring duplicate call');
      return;
    }
    
    this.isDisconnecting = true;
    
    // Always set state to disconnected first before closing the socket
    if (changeState) {
      this.setState('disconnected');
    }
    
    // Clear any reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Store local reference to identify if we have a websocket
    const ws = this.webSocket;
    
    // If no WebSocket exists, just cleanup and return
    if (!ws) {
      console.log('SyncManager: No active WebSocket connection to disconnect');
      this.completeDisconnect();
      return;
    }
    
    // Clear the instance property immediately to prevent new operations
    this.webSocket = null;
    
    // Set a unique disconnect ID to track this specific disconnect operation
    const disconnectId = Date.now();
    console.log(`SyncManager: Starting disconnect sequence #${disconnectId}`);
    
    // Set a timeout to force cleanup if the close event never comes
    const disconnectTimeout = setTimeout(() => {
      if (this.isDisconnecting) {
        console.log(`SyncManager: Disconnect timeout #${disconnectId} - forcing cleanup`);
        this.completeDisconnect();
      }
    }, 2000);
    
    // IMPORTANT: Add a specific onclose handler to confirm the close was processed
    const originalOnClose = ws.onclose;
    ws.onclose = (event) => {
      console.log(`SyncManager: Disconnect close event #${disconnectId} received: ${event.code} ${event.reason}`);
      
      // Clear the timeout since we got the close event
      clearTimeout(disconnectTimeout);
      
      // Now it's safe to null out event handlers
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        // onclose will be nulled implicitly after this handler completes
      } catch (e) {
        console.error('SyncManager: Error cleaning up event handlers:', e);
      }
      
      // Call the original handler if it exists, but only if it's a function
      // This prevents issues if the handler was already nulled or modified
      if (typeof originalOnClose === 'function') {
        try {
          originalOnClose.call(ws, event);
        } catch (e) {
          console.error('SyncManager: Error calling original onclose handler:', e);
        }
      }
      
      console.log(`SyncManager: Disconnect #${disconnectId} complete, clean close confirmed`);
      
      // Finally complete the disconnect process
      this.completeDisconnect();
    };
    
    // Send a proper close frame with code and reason
    try {
      console.log(`SyncManager: Sending WebSocket close frame #${disconnectId}`);
      ws.close(1000, 'Client initiated disconnect');
    } catch (e) {
      console.error(`SyncManager: Error closing WebSocket #${disconnectId}:`, e);
      // Force cleanup if close fails
      clearTimeout(disconnectTimeout);
      
      // Null out event handlers
      try {
        ws.onopen = null;
        ws.onclose = null;
        ws.onmessage = null;
        ws.onerror = null;
      } catch (e2) {
        console.error('SyncManager: Error cleaning up event handlers after failed close:', e2);
      }
      
      // Complete the disconnect process
      this.completeDisconnect();
    }
  }
  
  /**
   * Complete the disconnect process by cleaning up resources and emitting events
   * This is a helper method called at the end of any disconnect flow
   */
  private completeDisconnect(): void {
    // Reset the disconnecting flag
    this.isDisconnecting = false;
    
    // Always ensure state is disconnected regardless of how we got here
    if (this.syncState !== 'disconnected') {
      console.log(`SyncManager: Forcing state to disconnected (was: ${this.syncState})`);
      this.setState('disconnected');
    }
    
    // Emit disconnected event to ensure the UI is updated
    this.events.emit('connection:status', false);
    
    // Save the disconnected state to the database IMMEDIATELY to ensure it's persisted
    this.doSaveMetadata().catch(error => 
      console.error('SyncManager: Error saving disconnected state:', error)
    );
    
    console.log('SyncManager: Disconnect process completed');
  }
  
  /**
   * Check if the WebSocket is connected
   */
  public isConnected(): boolean {
    return !!this.webSocket && this.webSocket.readyState === WebSocket.OPEN;
  }
  
  /**
   * Send a message to the server
   */
  public send(message: ClientMessage): boolean {
    try {
      if (!this.webSocket || this.webSocket.readyState !== WebSocket.OPEN) {
        console.error(`[SyncManager] 🚫 Cannot send message - WebSocket not open`, {
          type: message.type,
          messageId: message.messageId,
          socketState: this.webSocket ? this.getWebSocketStateString(this.webSocket.readyState) : 'null'
        });
        return false;
      }
      
      // Log outgoing message (include clientId and indicate if changes are present)
      console.log(`[SyncManager] 📤 Sending message: ${message.type}`, {
        type: message.type,
        clientId: message.clientId, // Add clientId to the log
        messageId: message.messageId,
        inReplyTo: message.inReplyTo || 'none',
        hasChanges: message.changes && message.changes.length > 0 // Indicate if changes payload exists
      });
      
      // For debugging, log the full message in development
      if (process.env.NODE_ENV === 'development') {
        console.debug(`[SyncManager] Debug - Full outgoing message:`, JSON.stringify(message));
      }
      
      // Measure how long it takes to send
      const sendStartTime = Date.now();
      
      // Send the message
      this.webSocket.send(JSON.stringify(message));
      
      const sendDuration = Date.now() - sendStartTime;
      console.log(`[SyncManager] ✅ Message sent successfully in ${sendDuration}ms: ${message.type}`);
      
      // Sanity check log
      console.log(`[SyncManager] DEBUG: Reached line just before emitting 'sync:message-sent'`);

      // ADDED LOG: Confirming event emission attempt
      console.log(`[SyncManager] ➡️ Emitting event: 'sync:message-sent' for message type: ${message.type}`);
      
      // ADDED LOG: Log the emitter instance before emitting
      console.log('[SyncManager.send] Emitting on emitter instance:', this.events);

      // Emit event
      this.events.emit('sync:message-sent', message);
      
      return true;
    } catch (error) {
      console.error(`[SyncManager] ❌ Failed to send message ${message.type}:`, error);
      return false;
    }
  }
  
  /**
   * Helper method to get readable WebSocket state
   */
  private getWebSocketStateString(state: number): string {
    switch (state) {
      case WebSocket.CONNECTING:
        return 'CONNECTING';
      case WebSocket.OPEN:
        return 'OPEN';
      case WebSocket.CLOSING:
        return 'CLOSING';
      case WebSocket.CLOSED:
        return 'CLOSED';
      default:
        return `UNKNOWN (${state})`;
    }
  }
  
  /**
   * Reset the LSN and trigger a fresh sync
   */
  public async resetLSN(): Promise<void> {
    this.currentLSN = '0/0';
    
    // Update database
    await this.doSaveMetadata(); // Use doSaveMetadata
    
    // Emit event
    this.events.emit('lsnUpdate', this.currentLSN);
    
    // Reconnect if connected
    if (this.isConnected()) {
      await this.connect();
    }
  }
  
  /**
   * Get the current sync state
   */
  public getState(): SyncState {
    return this.syncState;
  }
  
  /**
   * Set the current sync state
   */
  public setState(state: SyncState): void {
    if (this.syncState !== state) {
      console.log(`SyncManager: State changing from ${this.syncState} to ${state}`);
      this.syncState = state;
      this.events.emit('stateChange', state);
      
      // Save state change to database (debounced)
      this.doSaveMetadata().catch(error => 
        console.error('SyncManager: Error saving state change:', error)
      );
    }
  }
  
  /**
   * Update the LSN
   */
  public updateLSN(lsn: string): void {
    if (this.currentLSN !== lsn) {
      console.log(`SyncManager: LSN changing from ${this.currentLSN} to ${lsn}`);
      this.currentLSN = lsn;
      this.events.emit('lsnUpdate', lsn);
      
      // Save LSN change to database IMMEDIATELY to ensure it's persisted
      console.log(`SyncManager: Saving LSN update to database immediately`);
      this.doSaveMetadata().catch(error => 
        console.error('SyncManager: Error saving LSN change:', error)
      );
    }
  }
  
  /**
   * Get the current client ID
   */
  public getClientId(): string {
    return this.clientId;
  }
  
  /**
   * Get the current LSN
   */
  public getLSN(): string {
    return this.currentLSN;
  }
  
  /**
   * Get the number of pending changes
   */
  public getPendingChangesCount(): number {
    return this.pendingChanges;
  }
  
  /**
   * Update the pending changes count
   */
  public updatePendingChangesCount(count: number): void {
    if (this.pendingChanges !== count) {
      this.pendingChanges = count;
      this.events.emit('pendingChangesUpdate', count);
      
      // Save change to database (debounced)
      this.doSaveMetadata().catch(error => 
        console.error('SyncManager: Error saving pending changes count:', error)
      );
    }
  }
  
  /**
   * Register an event listener
   */
  public on(event: string, listener: (...args: any[]) => void): void {
    // console.log(`[SyncManager.on] Registering listener for: ${event}. Emitter instance:`, this.events);
    this.events.on(event, listener);
  }
  
  /**
   * Remove an event listener
   */
  public off(event: string, listener: (...args: any[]) => void): void {
    // console.log(`[SyncManager.off] Removing listener for: ${event}. Emitter instance:`, this.events);
    this.events.off(event, listener);
  }
  
  /**
   * Handle WebSocket open event
   */
  private handleOpen(event: Event): void {
    console.log('WebSocket connected');
    
    // Reset reconnect attempts on successful connection
    this.reconnectAttempts = 0;
    
    // Set state to connecting if it's disconnected (in case we missed the state change)
    if (this.syncState === 'disconnected') {
      this.setState('connecting');
    }
    
    // Update state and emit events
    this.events.emit('connection:status', true);
    this.events.emit('websocket:open', event);
  }
  
  /**
   * Handle WebSocket close event
   */
  private handleClose = (event: CloseEvent): void => {
    console.log(`SyncManager: WebSocket disconnected: ${event.code} ${event.reason}`);
    
    // If we're already in a disconnect process, ignore this close event
    // Our explicit disconnect handler will take care of it
    if (this.isDisconnecting) {
      console.log('SyncManager: Ignoring close event during disconnect process');
      return;
    }
    
    // Only process if we have a websocket reference or if this is an unexpected closure
    if (!this.webSocket) {
      console.log('SyncManager: WebSocket reference is already null - likely already handled the disconnect');
      return; // Ignore duplicate close events
    }
    
    // Clear the WebSocket reference
    this.webSocket = null;
    
    // Emit events
    this.events.emit('connection:status', false);
    this.events.emit('websocket:close', event);
    
    // Always set state to disconnected for any close event
    console.log(`SyncManager: WebSocket close detected (code ${event.code}), setting state to disconnected`);
    this.setState('disconnected');
    
    // For non-clean closes, attempt reconnect after setting state
    if (event.code !== 1000) {
      console.log(`SyncManager: Non-clean close code ${event.code}, attempting reconnect`);
      this.attemptReconnect();
    }
    
    // Save metadata to ensure persistence
    this.doSaveMetadata().catch(err => 
      console.error('SyncManager: Error saving state after disconnect:', err)
    );
  };
  
  /**
   * Handle WebSocket error event
   */
  private handleError(event: Event): void {
    console.error('WebSocket error:', event);
    this.events.emit('websocket:error', event);
  }
  
  /**
   * Handle WebSocket message event
   */
  private handleMessage(event: MessageEvent): void {
    try {
      const rawData = event.data;
      const message = JSON.parse(rawData) as ServerMessage;
      const receiveTime = Date.now();
      
      console.log(`[SyncManager] 📥 Received message: ${message.type}`, {
        type: message.type,
        messageId: message.messageId,
        size: typeof rawData === 'string' ? `${Math.round(rawData.length / 1024 * 100) / 100}KB` : 'unknown'
      });
      
      // For debugging, log the full message in development
      if (process.env.NODE_ENV === 'development') {
        console.debug(`[SyncManager] Debug - Full incoming message:`, JSON.stringify(message));
      }
      
      // Emit the message event based on its type
      this.events.emit(message.type, message);
      
      // Also emit a generic message event
      this.events.emit('message', message);
      
      // Process specific message types
      this.processMessage(message);
      
      const processingTime = Date.now() - receiveTime;
      if (processingTime > 50) { // Log only if processing took more than 50ms
        console.log(`[SyncManager] ⏱️ Message processing took ${processingTime}ms for ${message.type}`);
      }
    } catch (error) {
      console.error('[SyncManager] ❌ Error processing message:', error);
      console.error('[SyncManager] Raw message data:', event.data);
    }
  }
  
  /**
   * Process an incoming message
   */
  private processMessage(message: ServerMessage): void {
    // Handle different message types
    switch (message.type) {
      case 'srv_state_change':
        this.handleStateChangeMessage(message);
        break;
      case 'srv_lsn_update':
        this.handleLSNUpdateMessage(message);
        break;
      case 'srv_send_changes':
      case 'srv_live_changes': // Process live changes same as regular changes
      case 'srv_catchup_changes':
      case 'srv_init_changes':
        this.handleTableChangesMessage(message);
        break;
      case 'srv_init_start':
        this.handleInitStartMessage(message);
        break;
      case 'srv_init_complete':
        this.handleInitCompleteMessage(message);
        break;
      case 'srv_catchup_completed':
        this.handleCatchupCompletedMessage(message);
        break;
      case 'srv_live_start': // Added handler for live start
        this.handleLiveStartMessage(message);
        break;
      case 'srv_sync_stats':
        this.handleSyncStatsMessage(message);
        break;
      case 'srv_changes_received':
      case 'srv_changes_applied':
      case 'srv_error':
        // These are directly handled by event listeners in SyncChangeManager
        // Forward them through the event system
        break;
      default:
        console.log(`Unhandled message type: ${message.type}`);
    }
  }
  
  /**
   * Handle state change message
   */
  private handleStateChangeMessage(message: ServerMessage): void {
    // Extract state from message
    const state = message.state;
    if (state) {
      this.setState(state);
    }
  }
  
  /**
   * Handle LSN update message
   */
  private handleLSNUpdateMessage(message: ServerMessage): void {
    // Extract LSN from message
    const lsn = message.lsn;
    if (lsn) {
      this.updateLSN(lsn);
    }
  }
  
  /**
   * Handle table changes message (during initial sync, catchup or live)
   */
  private handleTableChangesMessage(message: ServerMessage): void {
    const changes = message.changes;
    if (changes && Array.isArray(changes)) {
      // Update LSN if provided in the message (more common in catchup/live)
      if (message.lastLSN) {
        console.log(`[SyncManager] 🔄 Updating LSN from ${this.getLSN()} to ${message.lastLSN} based on ${message.type}`);
        this.updateLSN(message.lastLSN);
      }
      
      // Enhanced logging for initial sync table processing
      const sequence = message.sequence;
      if (message.type === 'srv_init_changes' && sequence) {
        console.log(`[SyncManager] 📊 Initial sync table: ${sequence.table}, chunk: ${sequence.chunk}, records: ${changes.length}`);
        
        // Log sample of first few records to help diagnose foreign key issues
        if (sequence.table === 'comments' && changes.length > 0) {
          const sample = changes.slice(0, Math.min(3, changes.length));
          console.log(`[SyncManager] 🔍 Sample comments (first ${sample.length}):`);
          sample.forEach((comment, i) => {
            const data = comment.data || {};
            console.log(`  Comment #${i+1} - id: ${data.id}, parentId: ${data.parentId || data.parent_id}, entityId: ${data.entityId || data.entity_id}`);
          });
        }
      }
      
      // Log the received message details
      console.log(`[SyncManager] 📦 Processing ${changes.length} changes from ${message.type}`, {
        messageId: message.messageId,
        messageType: message.type,
        changeCount: changes.length,
        hasSequence: !!message.sequence,
        hasLSN: !!message.lastLSN
      });
      
      // Process changes and handle acknowledgment when complete
      this.processChanges(message.type, changes)
        .then(success => {
          if (success) {
            console.log(`[SyncManager] ✅ Successfully processed ${changes.length} changes from ${message.type}`);
            
            // Send appropriate acknowledgment based on the original message type
            this.sendMessageAcknowledgment(message);
          } else {
            console.error(`[SyncManager] ❌ Failed to process changes from ${message.type}`);
          }
        })
        .catch(error => {
          console.error(`[SyncManager] ❌ Error processing changes from ${message.type}:`, error);
        });
    } else {
      console.warn(`[SyncManager] ⚠️ Received table changes message with no valid changes array`);
    }
  }
  
  /**
   * Process changes through the change manager
   */
  private async processChanges(type: string, changes: any[]): Promise<boolean> {
    // Create a promise that resolves when changes are processed
    console.log(`[SyncManager] 🔍 Starting processChanges for ${type} with ${changes.length} changes`);
    
    return new Promise((resolve) => {
      // Set a timeout in case the callback is never called
      let timeoutId = setTimeout(() => {
        console.warn(`[SyncManager] ⚠️ Timeout waiting for changes to be processed for ${type}, assuming failure`);
        resolve(false);
      }, 120000); // 2 minute timeout for large data volumes

      // Emit event for change processor to handle
      console.log(`[SyncManager] 🔄 Emitting process_changes event for ${changes.length} changes (${type})`);
      
      this.events.emit('process_changes', {
        type,
        changes,
        callback: (success: boolean) => {
          // Clear the timeout since we got a response
          clearTimeout(timeoutId);
          console.log(`[SyncManager] 📢 Received processing result for ${type}: ${success ? 'success' : 'failure'}`);
          resolve(success);
        }
      });
    });
  }
  
  /**
   * Send acknowledgment for a table changes message
   */
  private sendMessageAcknowledgment(message: ServerMessage): void {
    const type = message.type;
    
    try {
      console.log(`[SyncManager] 🔄 Preparing acknowledgment for ${type} (in reply to ${message.messageId})`);
      
      switch (type) {
        case 'srv_init_changes':
          // Acknowledge each chunk of initial sync changes
          this.sendInitChangesAcknowledgment(message);
          break;
        case 'srv_catchup_changes':
          this.sendCatchupAcknowledgment(message);
          break;
        case 'srv_live_changes':
          this.sendLiveChangesAcknowledgment(message);
          break;
        default:
          console.warn(`[SyncManager] ⚠️ No acknowledgment handler for message type: ${type}`);
      }
    } catch (error) {
      console.error(`[SyncManager] ❌ Error sending acknowledgment for ${type}:`, error);
    }
  }
  
  /**
   * Send acknowledgment for initial sync changes chunk
   */
  private sendInitChangesAcknowledgment(message: ServerMessage): void {
    const sequence = message.sequence;
    const table = sequence?.table;
    const chunk = sequence?.chunk;
    
    if (!table || chunk === undefined) {
      console.warn(`[SyncManager] ⚠️ Cannot send init changes ack - missing table or chunk in sequence:`, sequence);
      return;
    }
    
    console.log(`[SyncManager] 📤 Sending initial sync acknowledgment for table ${table}, chunk ${chunk}, messageId: ${message.messageId}`);
    
    // Send the acknowledgment using the 'clt_init_received' type
    // This matches the server expectation in initial-sync.ts processTable
    const ackMessage: ClientMessage = {
      type: 'clt_init_received',
      messageId: `init_ack_${table}_${chunk}_${Date.now()}`,
      timestamp: Date.now(),
      clientId: this.getClientId(),
      table: table,
      chunk: chunk,
      inReplyTo: message.messageId
      // Note: LSN is not typically required/expected by the server for this specific ack
    };
    
    const sent = this.send(ackMessage);
    console.log(`[SyncManager] 📊 Initial sync chunk acknowledgment sent result: ${sent ? 'success' : 'failed'}`);
  }
  
  /**
   * Send acknowledgment for catchup changes
   */
  private sendCatchupAcknowledgment(message: ServerMessage): void {
    const sequence = message.sequence;
    const lastLSN = message.lastLSN || this.getLSN(); // Use LSN from message if available
    const chunk = sequence?.chunk || 1; // Default chunk to 1 if not specified
    
    console.log(`[SyncManager] 📤 Sending catchup acknowledgment for chunk ${chunk}, LSN: ${lastLSN}, messageId: ${message.messageId}`);
    
    // Send the acknowledgment
    const ackMessage: ClientMessage = {
      type: 'clt_catchup_received',
      messageId: `catchup_ack_${Date.now()}`,
      timestamp: Date.now(),
      clientId: this.getClientId(),
      chunk: chunk,
      lsn: lastLSN,
      inReplyTo: message.messageId
    };
    
    const sent = this.send(ackMessage);
    console.log(`[SyncManager] 📊 Catchup acknowledgment sent result: ${sent ? 'success' : 'failed'}`);
  }
  
  /**
   * Send acknowledgment for live changes
   */
  private sendLiveChangesAcknowledgment(message: ServerMessage): void {
    const changes = message.changes as Array<any>;
    const lastLSN = message.lastLSN || this.getLSN(); // Use LSN from message if available
    
    // Extract the change IDs from the changes
    // Assuming changes have a `data.id` structure based on `recordsToChanges` on server
    const changeIds = changes
      .map(change => change.data?.id)
      .filter(Boolean);
    
    console.log(`[SyncManager] 📤 Sending live changes acknowledgment for ${changeIds.length} changes, LSN: ${lastLSN}`);
    
    // Send the acknowledgment
    this.send({
      type: 'clt_changes_received',
      messageId: `live_ack_${Date.now()}`,
      timestamp: Date.now(),
      clientId: this.getClientId(),
      changeIds: changeIds,
      lastLSN: lastLSN,
      inReplyTo: message.messageId
    });
  }
  
  /**
   * Handle initial sync start message
   */
  private handleInitStartMessage(message: ServerMessage): void {
    console.log('Initial sync starting', {
      serverLSN: message.serverLSN,
      messageId: message.messageId
    });
    
    // Update LSN if provided in the message (this might be the server's starting point)
    if (message.serverLSN) {
      // Avoid updating LSN if resuming, server provides an informational string then
      if (!message.serverLSN.includes('(resuming)')) {
          console.log(`[SyncManager] 🔄 Updating LSN from ${this.getLSN()} to ${message.serverLSN} on initial sync start`);
          this.updateLSN(message.serverLSN);
      } else {
          console.log(`[SyncManager] ℹ️ Resuming sync, keeping current LSN: ${this.getLSN()}`);
      }
    }
    
    // Set the sync state to initial
    this.setState('initial');
    
    // Send acknowledgment - Server expects this for the START message specifically
    this.sendInitStartReceivedAck(message.messageId);
  }
  
  /**
   * Send acknowledgment for initial sync START message
   */
  private sendInitStartReceivedAck(inReplyTo: string): void {
    console.log(`[SyncManager] 📤 Sending initial sync START acknowledgment (in reply to ${inReplyTo})`);
    this.send({
      type: 'clt_init_received', // Server expects this type for the start ack as well
      messageId: `init_start_ack_${Date.now()}`,
      timestamp: Date.now(),
      clientId: this.getClientId(),
      inReplyTo
      // No table/chunk needed for the *start* acknowledgment
    });
  }
  
  /**
   * Handle initial sync complete message
   */
  private handleInitCompleteMessage(message: ServerMessage): void {
    console.log('Initial sync complete', {
      serverLSN: message.serverLSN,
      messageId: message.messageId
    });
    
    // Update LSN if provided in the message (this should be the final LSN after initial sync)
    if (message.serverLSN) {
      console.log(`[SyncManager] 🔄 Updating LSN from ${this.getLSN()} to ${message.serverLSN} on initial sync complete`);
      this.updateLSN(message.serverLSN);
    }
    
    // Send acknowledgment that we have *processed* the initial sync completion signal
    this.sendInitProcessedAck(message.messageId);
    
    // Set state to catchup (server will likely send catchup changes or complete immediately)
    this.setState('catchup');
  }
  
  /**
   * Send acknowledgment for initial sync COMPLETION
   */
  private sendInitProcessedAck(inReplyTo: string): void {
    console.log(`[SyncManager] 📤 Sending initial sync PROCESSED acknowledgment (in reply to ${inReplyTo})`);
    this.send({
      type: 'clt_init_processed', // Specific type for acknowledging completion
      messageId: `init_processed_${Date.now()}`,
      timestamp: Date.now(),
      clientId: this.getClientId(),
      inReplyTo
    });
  }
  
  /**
   * Handle catchup completed message
   */
  private handleCatchupCompletedMessage(message: ServerMessage): void {
    console.log('Catchup sync complete', {
        lastLSN: message.lastLSN, // Use lastLSN from ServerMessage interface
        messageId: message.messageId
    });
    
    // Update LSN if provided in the message (final LSN after catchup)
    if (message.lastLSN) {
      console.log(`[SyncManager] 🔄 Updating LSN from ${this.getLSN()} to ${message.lastLSN} on catchup complete`);
      this.updateLSN(message.lastLSN);
    }
    
    // Set state to live
    this.setState('live');
    
    // Update last sync time
    this.lastSyncTime = new Date();
    this.doSaveMetadata().catch(error => console.error('Error saving sync time:', error));
    
    // Explicitly trigger processing of any pending changes
    console.log('[SyncManager] Triggering process_all_changes event after catchup completion');
    this.events.emit('process_all_changes', { type: 'catchup_completion' });
  }
  
  /**
   * Handle live start message (client connected and was already up-to-date)
   */
  private handleLiveStartMessage(message: ServerMessage): void {
    // Cast to the specific type to access its properties
    const liveStartMsg = message as ServerLiveStartMessage;
    
    console.log('Live sync starting', {
      finalLSN: liveStartMsg.finalLSN, 
      messageId: liveStartMsg.messageId
    });
    
    // Update LSN if provided (should match current LSN but good practice)
    if (liveStartMsg.finalLSN) {
      console.log(`[SyncManager] 🔄 Updating LSN from ${this.getLSN()} to ${liveStartMsg.finalLSN} on live start confirmation`);
      this.updateLSN(liveStartMsg.finalLSN);
    }
    
    // Set state to live
    this.setState('live');
    
    // Update last sync time
    this.lastSyncTime = new Date();
    this.doSaveMetadata().catch(error => console.error('Error saving sync time:', error));
    
    // Explicitly trigger processing of any pending changes
    // TODO: Review if this manual trigger is necessary or if state changes handle it
    // this.processPendingChanges();
  }
  
  /**
   * Handle sync stats message
   */
  private handleSyncStatsMessage(message: ServerMessage): void {
    console.log('Received sync stats', message);
    
    // Emit stats event for UI to display
    this.events.emit('sync_stats', message);
  }
  
  /**
   * Attempt to reconnect to the WebSocket server
   */
  private attemptReconnect(): void {
    // If we've exceeded the max reconnect attempts, stop trying
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log(`SyncManager: Giving up reconnection after ${this.reconnectAttempts} attempts`);
      
      // Make absolutely sure we're in disconnected state
      if (this.syncState !== 'disconnected') {
        console.log(`SyncManager: Forcing final state to disconnected (was: ${this.syncState})`);
        this.setState('disconnected');
      }
      
      // Make sure all metadata is saved immediately
      this.doSaveMetadata().catch(error => 
        console.error('SyncManager: Error saving final state after reconnect failure:', error)
      );
      
      return;
    }
    
    this.reconnectAttempts++;
    
    // Use exponential backoff for reconnect delay
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
    console.log(`SyncManager: Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    // Clear any existing reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    // Set a timer to reconnect
    this.reconnectTimer = setTimeout(() => {
      console.log(`SyncManager: Executing reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
      this.connect().catch(error => {
        console.error(`SyncManager: Reconnect attempt ${this.reconnectAttempts} failed:`, error);
        // Will automatically try again if we haven't reached max attempts
      });
    }, delay);
  }
  
  /**
   * Handle online event
   */
  private handleOnline = (): void => {
    console.log('Network is online');
    
    // If we are disconnected and autoConnect is enabled, attempt to reconnect
    // Don't auto-reconnect if we were explicitly disconnected or already connecting/connected
    if (this.autoConnect && this.syncState === 'disconnected' && !this.isConnectingOrConnected()) {
        console.log('SyncManager: Network online, attempting to reconnect...');
        this.reconnectAttempts = 0; // Reset attempts as this is a network event
        this.connect().catch(err => {
            console.error('SyncManager: Reconnect attempt after coming online failed:', err);
        });
    } else {
        console.log(`SyncManager: Skipping reconnect on online event (autoConnect: ${this.autoConnect}, state: ${this.syncState})`);
    }
  };
  
  /**
   * Helper to check if state is connecting or connected
   */
  private isConnectingOrConnected(): boolean {
      return this.syncState === 'connecting' || this.isConnected();
  }
  
  /**
   * Generate a unique client ID
   */
  private generateClientId(): string {
    return uuidv4();
  }
  
  /**
   * Generate a unique message ID
   */
  private generateMessageId(): string {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  }
  
  /**
   * Cleanup resources when the manager is no longer needed
   */
  public destroy(): void {
    // Disconnect WebSocket
    this.disconnect();
    
    // Remove event listeners
    window.removeEventListener('online', this.handleOnline);
    
    // Make sure any pending metadata changes are saved
    this.flushMetadata().catch(err => 
      console.error('SyncManager: Error flushing metadata during destroy:', err)
    );
    
    // Clear any debounce timers
    if (this.saveMetadataDebounceTimer) {
      clearTimeout(this.saveMetadataDebounceTimer);
      this.saveMetadataDebounceTimer = null;
    }
    
    // Clear the singleton instance
    SyncManager.instance = null;
  }
  
  /**
   * Set whether to automatically connect after initialization
   */
  public setAutoConnect(value: boolean): void {
    this.autoConnect = value;
  }
  
  /**
   * Auto-connect to server (called from SyncContext)
   */
  public async autoConnectToServer(): Promise<void> {
    // Only auto-connect if enabled and not already connected/connecting
    if (!this.autoConnect || this.isConnectingOrConnected()) {
      console.log(`SyncManager: Auto-connect skipped - autoConnect: ${this.autoConnect}, state: ${this.syncState}, connected: ${this.isConnected()}`);
      return;
    }
    
    console.log('SyncManager: Auto-connect sequence starting');
    
    try {
      // Get the default URL if no server URL is already set
      const url = this.serverUrl || this.getDefaultServerUrl();
      console.log(`SyncManager: Auto-connecting to ${url}`);
      
      // Use the same approach as the manual connect but suppress auth errors during auto-connect
      await this.connect(url, true);
    } catch (connectError) {
      console.error('SyncManager: Auto-connect failed', connectError);
      // Reconnect logic is handled by handleClose/attemptReconnect
    }
  }
  
  /**
   * Get default server URL from config
   */
  private getDefaultServerUrl(): string {
    try {
      // Determine protocol based on current window protocol
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      
      // Use the API_URL from environment if available, or fall back to default
      const apiUrl = import.meta.env.VITE_API_URL;
      
      if (apiUrl) {
        // Extract host from API_URL if provided
        try {
          const url = new URL(apiUrl);
          return `${protocol}//${url.host}/api/sync`;
        } catch (e) {
          console.warn('SyncManager: Invalid API_URL format:', apiUrl);
        }
      }
      
      // Fall back to the fixed development server address
      return `${protocol}//127.0.0.1:8787/api/sync`;
    } catch (e) {
      // Default fallback
      return 'ws://127.0.0.1:8787/api/sync';
    }
  }
} 