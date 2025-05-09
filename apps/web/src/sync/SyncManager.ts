import { SyncEventEmitter } from './SyncEventEmitter';

// New Module Imports
import { DatabaseInitializer } from './DatabaseInitializer';
import { OutgoingChangeProcessor } from './OutgoingChangeProcessor';
import { IncomingChangeProcessor } from './IncomingChangeProcessor';
import { WebSocketConnector } from './WebSocketConnector'; // Remove IMessageSender import from here
import { SyncStatePersister } from './SyncStatePersister';
import { SyncMessageHandler } from './SyncMessageHandler';
import { 
  IOnlineStatusProvider,
  ISyncStateProvider,
  SyncStatus,
  ClientId,
  LSN,
  IMessageSender // Add IMessageSender import here
} from './interfaces';

// Define sync states - This type might be deprecated in favor of SyncStatus from interfaces.ts
// For now, keep it if it's used internally or by older event listeners.
export type SyncState = 'disconnected' | 'connecting' | 'initial' | 'catchup' | 'live';


// Basic message types - Consider moving these to a shared types file or within interfaces.ts
export interface BaseMessage {
  type: string;
  clientId: ClientId; 
  messageId: string;
  timestamp: number;
}

export interface ClientMessage extends BaseMessage {
  inReplyTo?: string;
  lsn?: LSN; 
  resetSync?: boolean;
  changes?: Array<any>; 
  chunk?: number;
  changeIds?: string[];
  lastLSN?: LSN; 
  table?: string;
  error?: string;
  [key: string]: any;
}

export interface ServerMessage extends BaseMessage {
  state?: SyncStatus; 
  lsn?: LSN; 
  changes?: Array<any>; 
  serverLSN?: LSN; 
  changeIds?: string[];
  error?: any;
  sequence?: {
    table?: string;
    chunk?: number;
    total?: number;
    [key: string]: any;
  };
  lastLSN?: LSN; 
}

export interface ServerLiveStartMessage extends ServerMessage {
  finalLSN: LSN;
}

/**
 * SyncManager
 * 
 * Orchestrates the different components of the synchronization process.
 * Acts as a facade for UI components and other parts of the application
 * to interact with the sync system.
 * 
 * Implements a proper singleton pattern.
 */
export class SyncManager implements IOnlineStatusProvider, ISyncStateProvider {
  // Singleton instance
  private static instance: SyncManager | null = null;
  
  // Add debug mode flag
  private static debugMode: boolean = process.env.NODE_ENV === 'development' && false; 
  
  // Event emitter for component communication
  public readonly events = new SyncEventEmitter();

  // New Sync Modules
  private databaseInitializer!: DatabaseInitializer;
  private outgoingChangeProcessor!: OutgoingChangeProcessor;
  private incomingChangeProcessor!: IncomingChangeProcessor;
  private webSocketConnector!: WebSocketConnector;
  private syncStatePersister!: SyncStatePersister;
  private syncMessageHandler!: SyncMessageHandler;
  
  // Initialization state
  private isInitialized: boolean = false;
  private isInitializing: boolean = false;
  private initPromise: Promise<void> | null = null;
  
  // Auto-connect behavior
  private autoConnect: boolean = true;

  /**
   * Private constructor - use getInstance() instead
   */
  private constructor() {
    if (SyncManager.debugMode) {
      console.log('[SyncManager] Constructor: Creating new SyncManager instance');
    }
    this.setupModules();
    this.registerEventHandlers();
  }

  private setupModules(): void {
    if (SyncManager.debugMode) {
      console.log('[SyncManager] setupModules: Initializing core sync modules');
    }

    this.databaseInitializer = new DatabaseInitializer();
    this.syncStatePersister = new SyncStatePersister(); // Constructor takes no arguments
    this.webSocketConnector = new WebSocketConnector(this.events);
    // Dependent modules (IncomingChangeProcessor, OutgoingChangeProcessor, SyncMessageHandler)
    // will be instantiated in initialize() after databaseInitializer is ready.

    if (SyncManager.debugMode) {
      console.log('[SyncManager] setupModules: Core sync modules initialized');
    }
  }

  private registerEventHandlers(): void {
    if (SyncManager.debugMode) {
      console.log('[SyncManager] registerEventHandlers: Setting up global event listeners');
    }

    this.events.on('websocket:status', (status: 'connected' | 'disconnected' | 'connecting' | 'error') => {
      if (SyncManager.debugMode) {
        console.log(`[SyncManager] Event: websocket:status received: ${status}`);
      }
      this.events.emit('sync:statusChanged', this.getStatus());

      if (status === 'disconnected' && this.autoConnect && this.isInitialized && !this.isInitializing) {
         if (SyncManager.debugMode) {
            console.log('[SyncManager] WebSocket disconnected, autoConnect is on. WebSocketConnector handles reconnection.');
        }
      }
    });
    
    this.events.on('outgoing:pendingCountChanged', (count: number) => {
        if (SyncManager.debugMode) {
            console.log(`[SyncManager] Event: outgoing:pendingCountChanged received: ${count}`);
        }
        this.events.emit('sync:pendingChangesCount', count);
    });

    this.events.on('sync:error', (errorData: { type: string, message: string, error?: any }) => {
        console.error(`[SyncManager] Sync Error (${errorData.type}): ${errorData.message}`, errorData.error || '');
    });

    this.events.on('syncStatePersister:stateUpdated', (newState: { clientId: ClientId, lsn: LSN, status: SyncStatus }) => {
        if (SyncManager.debugMode) {
            console.log('[SyncManager] Event: syncStatePersister:stateUpdated', newState);
        }
    });
  }
  
  public static getInstance(): SyncManager {
    if (SyncManager.debugMode) {
      console.log('[SyncManager.getInstance] Getting instance');
    }
    if (!SyncManager.instance) {
      if (SyncManager.debugMode) { 
        console.log('[SyncManager.getInstance] Creating new SyncManager instance');
      }
      SyncManager.instance = new SyncManager();
    }
    return SyncManager.instance;
  }
  
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      if (SyncManager.debugMode) console.log('[SyncManager.initialize] Already initialized.');
      return;
    }
    
    if (this.isInitializing) {
      if (SyncManager.debugMode) console.log('[SyncManager.initialize] Already initializing, waiting for completion.');
      return this.initPromise!; 
    }
    
    this.isInitializing = true;
    if (SyncManager.debugMode) console.log('[SyncManager.initialize] Starting initialization sequence.');

    this.initPromise = (async () => {
      try {
        await this.syncStatePersister.initialize();
        const clientId = this.syncStatePersister.getClientId();
        const lsn = this.syncStatePersister.getLSN();
        if (SyncManager.debugMode) console.log(`[SyncManager.initialize] SyncStatePersister initialized. ClientID: ${clientId}, LSN: ${lsn}`);

await this.databaseInitializer.initialize(); 
        if (SyncManager.debugMode) console.log('[SyncManager.initialize] DatabaseInitializer initialized.');

        // Now instantiate dependent modules
        this.incomingChangeProcessor = new IncomingChangeProcessor(this.events);
        if (SyncManager.debugMode) console.log('[SyncManager.initialize] IncomingChangeProcessor instantiated.');

        this.outgoingChangeProcessor = new OutgoingChangeProcessor(
          this.databaseInitializer, // Now initialized
          this.events,
          this.webSocketConnector // as IMessageSender
        );
        if (SyncManager.debugMode) console.log('[SyncManager.initialize] OutgoingChangeProcessor instantiated.');

        this.syncMessageHandler = new SyncMessageHandler(
          this.events,
          this.webSocketConnector, // as IMessageSender & for connection status
          this.incomingChangeProcessor, // Now instantiated
          this.syncStatePersister // Already initialized
        );
        if (SyncManager.debugMode) console.log('[SyncManager.initialize] SyncMessageHandler instantiated.');
        
        this.webSocketConnector.setConnectionParams(clientId, lsn);
        if (SyncManager.debugMode) console.log('[SyncManager.initialize] WebSocketConnector connection params set.');

        // Pass the full state object to syncInitialState
        const initialStateData = {
            clientId,
            currentLsn: lsn,
            syncState: this.syncStatePersister.getStatus(), // Get initial status from persister
            pendingChangesCount: this.syncStatePersister.getPendingChangesCount(),
            lastSyncTime: null // Or get from persister if available/needed
        };
        this.syncMessageHandler.syncInitialState(initialStateData);
        if (SyncManager.debugMode) console.log('[SyncManager.initialize] SyncMessageHandler initial state synced.');

        this.isInitialized = true;
        this.isInitializing = false;
        this.events.emit('sync:initialized', { clientId, lsn });
        if (SyncManager.debugMode) console.log(`[SyncManager.initialize] Initialization complete. ClientID: ${this.getClientId()}, LSN: ${this.getLSN()}`);

        if (this.autoConnect) {
          if (SyncManager.debugMode) console.log('[SyncManager.initialize] Auto-connecting to server post-initialization.');
          this.connect().catch(error => { 
            console.error('[SyncManager.initialize] Auto-connect post-initialization failed:', error);
          });
        }
      } catch (error) {
        console.error('[SyncManager.initialize] Initialization failed:', error);
        this.isInitializing = false;
        this.isInitialized = false; 
        this.events.emit('sync:error', { type: 'initialization', message: 'SyncManager initialization failed', error });
        throw error; 
      }
    })();
    
    return this.initPromise;
  }

  // --- Public API Methods ---

  public async connect(serverUrl?: string, suppressAuthErrors: boolean = false): Promise<boolean> {
    if (!this.isInitialized) {
      console.warn('[SyncManager.connect] SyncManager not initialized. Call initialize() first or await initialization.');
      if (this.isInitializing && this.initPromise) {
          if (SyncManager.debugMode) console.log('[SyncManager.connect] Waiting for ongoing initialization...');
          await this.initPromise;
          if (!this.isInitialized) {
              console.error('[SyncManager.connect] Initialization failed, cannot connect.');
              return false;
          }
      } else if (!this.isInitialized) {
          console.error('[SyncManager.connect] Not initialized and not initializing. Cannot connect.');
          return false;
      }
    }
    if (SyncManager.debugMode) {
      console.log(`[SyncManager.connect] Attempting to connect. Server URL: ${serverUrl || 'using default'}`);
    }
    return this.webSocketConnector.connect(serverUrl, suppressAuthErrors);
  }

  public disconnect(): void {
    if (SyncManager.debugMode) console.log('[SyncManager.disconnect] Attempting to disconnect.');
    if (this.webSocketConnector) {
      this.webSocketConnector.disconnect();
    } else {
      if (SyncManager.debugMode) console.warn('[SyncManager.disconnect] WebSocketConnector not available.');
    }
  }

  public isConnected(): boolean {
    return this.webSocketConnector?.isConnected() ?? false;
  }

  public send(messageData: Omit<ClientMessage, 'clientId' | 'messageId' | 'timestamp'>): void {
    if (!this.isInitialized) {
        console.warn('[SyncManager.send] SyncManager not initialized. Cannot send message.');
        return;
    }
    if (!this.isConnected()) {
        console.warn('[SyncManager.send] Not connected. Message not sent:', messageData);
        return;
    }
    if (SyncManager.debugMode) console.log('[SyncManager.send] Sending message via WebSocketConnector:', messageData);
    this.webSocketConnector.send(messageData);
  }
  
  public getStatus(): SyncStatus {
    if (!this.isInitialized && !this.isInitializing) return 'disconnected';
    if (this.isInitializing) return 'connecting';

    const wsStatus = this.webSocketConnector?.getStatus();
    if (wsStatus) {
        if (wsStatus === 'connected') {
            return this.syncMessageHandler?.getCurrentSyncPhase() || 'live';
        }
        if (wsStatus === 'connecting') return 'connecting';
        return 'disconnected';
    }
    return this.syncStatePersister?.getStatus() || 'disconnected';
  }

  public getLSN(): LSN {
    if (!this.syncStatePersister) {
        if (SyncManager.debugMode) console.warn("[SyncManager.getLSN] SyncStatePersister not initialized.");
        return '0/0'; 
    }
    return this.syncStatePersister.getLSN();
  }

  public getClientId(): ClientId {
     if (!this.syncStatePersister) {
        if (SyncManager.debugMode) console.warn("[SyncManager.getClientId] SyncStatePersister not initialized.");
        return ''; 
    }
    return this.syncStatePersister.getClientId();
  }

  public getPendingChangesCount(): number {
    if (!this.outgoingChangeProcessor) {
        if (SyncManager.debugMode) console.warn("[SyncManager.getPendingChangesCount] OutgoingChangeProcessor not initialized.");
        return 0;
    }
    return this.outgoingChangeProcessor.getQueueSize();
  }

public getOutgoingChangeProcessor(): OutgoingChangeProcessor {
    if (!this.outgoingChangeProcessor) {
      // This case should ideally not happen if SyncManager is initialized properly
      // and its components are constructed.
      throw new Error("OutgoingChangeProcessor not initialized in SyncManager.");
    }
    return this.outgoingChangeProcessor;
  }

  public getIncomingChangeProcessor(): IncomingChangeProcessor {
    if (!this.incomingChangeProcessor) {
      // This case should ideally not happen if SyncManager is initialized properly
      // and its components are constructed.
      throw new Error("IncomingChangeProcessor not initialized in SyncManager.");
    }
    return this.incomingChangeProcessor;
  }

  /** @deprecated Pending changes are managed internally. */
  public updatePendingChangesCount(_count: number): void {
    if (SyncManager.debugMode) {
        console.warn('[SyncManager.updatePendingChangesCount] This method is deprecated.');
    }
  }
  
  public async resetLSN(): Promise<void> {
    if (SyncManager.debugMode) console.warn('[SyncManager.resetLSN] Initiating LSN and client state reset.');
    
    if (this.webSocketConnector?.isConnected() || this.webSocketConnector?.getStatus() === 'connecting') {
      this.webSocketConnector.disconnect(); 
    }

    await this.syncStatePersister.resetSyncState(); 
    
    const newClientId = this.syncStatePersister.getClientId();
    const newLSN = this.syncStatePersister.getLSN();

    if (SyncManager.debugMode) console.log(`[SyncManager.resetLSN] State reset. New ClientID: ${newClientId}, New LSN: ${newLSN}`);
    
    this.webSocketConnector?.setConnectionParams(newClientId, newLSN);
    // Pass the full state object to syncInitialState after reset
    const resetStateData = {
        clientId: newClientId,
        currentLsn: newLSN,
        syncState: this.syncStatePersister.getStatus(), // Should be 'disconnected' after reset
        pendingChangesCount: this.syncStatePersister.getPendingChangesCount(), // Should be 0 after reset
        lastSyncTime: null
    };
    this.syncMessageHandler?.syncInitialState(resetStateData);
    await this.outgoingChangeProcessor?.handleLSNReset();

    this.events.emit('sync:stateReset', { clientId: newClientId, lsn: newLSN });
    if (SyncManager.debugMode) console.warn('[SyncManager.resetLSN] LSN reset complete. Re-sync on next connection.');

    if (this.autoConnect) {
      if (SyncManager.debugMode) console.log('[SyncManager.resetLSN] Auto-connecting after LSN reset.');
      this.connect().catch(err => console.error('[SyncManager.resetLSN] Error auto-connecting after LSN reset:', err));
    }
  }

  public on(event: string, listener: (...args: any[]) => void): void {
    this.events.on(event, listener);
  }

  public off(event: string, listener: (...args: any[]) => void): void {
    this.events.off(event, listener);
  }

  public setAutoConnect(enabled: boolean): void {
    this.autoConnect = enabled;
    this.webSocketConnector?.setAutoReconnect(enabled); 

    if (SyncManager.debugMode) console.log(`[SyncManager.setAutoConnect] Auto-connect ${enabled ? 'enabled' : 'disabled'}.`);
    if (enabled && this.isInitialized && !this.isConnected() && this.webSocketConnector?.getStatus() === 'disconnected') {
      if (SyncManager.debugMode) console.log('[SyncManager.setAutoConnect] Auto-connect enabled, attempting to connect.');
      this.connect().catch(err => console.error('[SyncManager.setAutoConnect] Error on connect:', err));
    }
  }
  
  public getAutoConnect(): boolean {
    return this.autoConnect;
  }

  public async autoConnectToServer(): Promise<void> { 
    if (this.autoConnect && this.isInitialized && !this.isConnected() && this.webSocketConnector?.getStatus() === 'disconnected') {
      if (SyncManager.debugMode) console.log('[SyncManager.autoConnectToServer] Explicitly triggering auto-connect...');
      try {
        await this.connect();
      } catch (error) {
        console.error('[SyncManager.autoConnectToServer] Auto-connect trigger failed:', error);
      }
    } else {
      if (SyncManager.debugMode) {
        const reason = !this.autoConnect ? 'autoConnect is false' 
                     : !this.isInitialized ? 'not initialized' 
                     : this.isConnected() ? 'already connected' 
                     : `status is ${this.webSocketConnector?.getStatus()}`;
        console.log(`[SyncManager.autoConnectToServer] Auto-connect condition not met (${reason}).`);
      }
    }
  }

  public async destroy(): Promise<void> {
    if (SyncManager.debugMode) console.log('[SyncManager.destroy] Destroying SyncManager...');
    
    this.isInitialized = false;
    this.isInitializing = false;
    this.initPromise = null;

    this.webSocketConnector?.destroy(); 
    // OutgoingChangeProcessor, SyncMessageHandler, IncomingChangeProcessor might have destroy methods if needed.
    // Example: await this.outgoingChangeProcessor?.destroy();
    
    await this.syncStatePersister?.flush();
    // Example: await this.syncStatePersister?.destroy();
    // Example: await this.databaseInitializer?.destroy();

    this.events.removeAllListeners();
    
    SyncManager.instance = null; 
    if (SyncManager.debugMode) console.log('[SyncManager.destroy] SyncManager destroyed.');
  }

  // --- IOnlineStatusProvider Implementation ---
  public isOnline(): boolean {
    return this.webSocketConnector?.isOnline() ?? navigator.onLine;
  }
}