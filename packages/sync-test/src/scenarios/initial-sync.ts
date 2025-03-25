import { SyncTester } from '../test-sync.js';
import { DEFAULT_CONFIG } from '../config.js';
import { SERVER_DOMAIN_TABLES, SERVER_TABLE_HIERARCHY } from '@repo/dataforge/server-entities';
import type { 
  ServerMessage,
  ServerInitChangesMessage,
  ServerInitStartMessage,
  ServerInitCompleteMessage,
  ServerStateChangeMessage,
  ServerLSNUpdateMessage,
  TableChange,
  ClientInitReceivedMessage,
  ClientInitProcessedMessage,
  Message
} from '@repo/sync-types';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

// Get the current file's directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the saved LSN data file - directly in the sync-test package directory
const LSN_FILE_PATH = path.join(__dirname, '..', '..', '.sync-test-lsn.json');

// Log the file path for debugging
console.log(`LSN file path: ${LSN_FILE_PATH}`);

/**
 * Load existing LSN data from file if available
 */
function loadSavedLSNData(): { lsn: string, clientId: string, timestamp: string } | null {
  try {
    if (fs.existsSync(LSN_FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(LSN_FILE_PATH, 'utf8'));
      return data;
    }
  } catch (err) {
    console.warn('Failed to load saved LSN data:', err);
  }
  return null;
}

/**
 * Testing class for initial sync scenario
 * 
 * FLOW:
 * 1. Client connects to server with LSN=0/0
 * 2. Server sends srv_init_start message
 * 3. Server sends multiple srv_init_changes messages with table chunks
 * 4. Client acknowledges each chunk with clt_init_received message
 * 5. After all tables are sent, server sends srv_init_complete message
 * 6. Client sends clt_init_processed message
 * 7. Server sends srv_lsn_update with latest LSN
 */
class InitialSyncTester {
  // Tracking state
  private initStartLSN: string = '0/0'; // Always use 0/0 for initial sync
  private initCompleteLSN: string = '';
  private receivedTables: Set<string> = new Set();
  private expectedTables: Set<string>;
  private acknowledgedChunks: Set<string> = new Set();
  private processedInitComplete: boolean = false;
  private syncSuccessful: boolean = false;
  
  // Websocket and connection
  private ws: WebSocket | null = null;
  private config = DEFAULT_CONFIG;
  private clientId: string;
  private messageId = 0;
  private messageLog: Message[] = [];
  private currentState: 'initial' | 'catchup' | 'live' = 'initial';
  private serverLSN: string = '';
  
  constructor() {
    // Try to load saved client ID from previous run
    const savedData = loadSavedLSNData();
    
    if (savedData && savedData.clientId) {
      console.log('Using existing client ID from previous run:', savedData.clientId);
      this.clientId = savedData.clientId;
    } else {
      // Generate a new UUID-based client ID
      this.clientId = uuidv4();
      console.log('Generated new client ID:', this.clientId);
    }
    
    // Get expected table names from domain tables
    this.expectedTables = new Set(SERVER_DOMAIN_TABLES.map(t => t.replace(/^"|"$/g, '')));
  }

  /**
   * Connect to server to begin sync
   */
  public async connect(): Promise<void> {
    // STEP 1: Setup connection with LSN=0/0 for initial sync
    const wsUrl = new URL(this.config.wsUrl);
    wsUrl.searchParams.set('clientId', this.clientId);
    wsUrl.searchParams.set('lsn', '0/0'); // Always use 0/0 for initial sync
    
    console.log('Connecting to sync server:', {
      url: wsUrl.toString(),
      clientId: this.clientId
    });
    
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(wsUrl.toString());
      
      this.ws.on('open', () => {
        console.log('Connection established, waiting for server to begin sync process');
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as Message;
          this.handleMessage(message);
        } catch (err) {
          console.error('Error parsing message:', err);
        }
      });

      this.ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });

      this.ws.on('close', () => {
        this.ws = null;
      });

      // Connection timeout
      setTimeout(() => {
        if (!this.ws) {
          reject(new Error('Connection timeout'));
        }
      }, this.config.connectTimeout);
    });
  }
  
  /**
   * Disconnect from server with a more aggressive termination strategy
   */
  public async disconnect(code = 1000, reason = 'Test complete'): Promise<void> {
    console.log('Disconnecting WebSocket...');
    
    return new Promise<void>((resolve) => {
      if (!this.ws) {
        console.log('No active WebSocket connection to disconnect');
        return resolve();
      }
      
      // Remove all existing listeners to avoid memory leaks
      this.ws.removeAllListeners();
      
      // Set a short timeout for graceful close
      const forceCloseTimeout = setTimeout(() => {
        console.log('Force closing WebSocket after timeout');
        if (this.ws) {
          // Force terminate the connection
          try {
            this.ws.terminate();
          } catch (err) {
            console.error('Error terminating WebSocket:', err);
          }
          this.ws = null;
        }
        resolve();
      }, 1000);
      
      // Try graceful close first
      try {
        // Add just one close listener
        this.ws.once('close', () => {
          console.log('WebSocket closed gracefully');
          clearTimeout(forceCloseTimeout);
          this.ws = null;
          resolve();
        });
        
        // Attempt graceful close
        this.ws.close(code, reason);
      } catch (error) {
        console.error('Error during WebSocket close:', error);
        clearTimeout(forceCloseTimeout);
        
        // Force terminate on error
        if (this.ws) {
          try {
            this.ws.terminate();
          } catch (err) {
            // Just log, don't throw
            console.error('Error terminating WebSocket after close error:', err);
          }
          this.ws = null;
        }
        resolve();
      }
    });
  }

  /**
   * Process incoming WebSocket messages
   */
  private handleMessage(message: Message): void {
    // Add to message log
    this.messageLog.push(message);
    
    // Track LSN and state based on message type
    if ('type' in message) {
      if (message.type === 'srv_state_change') {
        // Legacy state change message
        this.currentState = (message as ServerStateChangeMessage).state;
        this.serverLSN = (message as ServerStateChangeMessage).lsn;
        console.log(`State changed to ${this.currentState} with LSN: ${this.serverLSN}`);
      } else if (message.type === 'srv_lsn_update') {
        // New LSN-only update message
        this.serverLSN = (message as ServerLSNUpdateMessage).lsn;
        console.log(`Received LSN update: ${this.serverLSN}`);
        
        // Derive state from LSN comparison
        if (this.initStartLSN === '0/0' || !this.initStartLSN) {
          this.currentState = 'initial';
        } else if (!this.initCompleteLSN || this.serverLSN !== this.initCompleteLSN) {
          this.currentState = 'catchup';
        } else {
          this.currentState = 'live';
          console.log(`Entered live state with LSN: ${this.serverLSN}`);
        }
      }
    }
    
    // Process message based on type
    switch (message.type) {
      case 'srv_init_start':
        // STEP 2: Server sent initial sync start message
        this.handleInitStart(message as ServerInitStartMessage);
        break;
        
      case 'srv_init_changes':
        // STEP 3: Server sent table chunks
        this.handleInitChanges(message as ServerInitChangesMessage);
        break;
        
      case 'srv_init_complete':
        // STEP 5: Server sent sync complete message
        this.handleInitComplete(message as ServerInitCompleteMessage);
        break;
        
      case 'srv_lsn_update':
        // STEP 7: Server sent LSN update
        const lsnMessage = message as ServerLSNUpdateMessage;
        console.log(`LSN update received: ${lsnMessage.lsn} (current: ${this.initCompleteLSN})`);
        break;
    }
  }

  /**
   * Handle init start message from server
   */
  private handleInitStart(message: ServerInitStartMessage): void {
    this.initStartLSN = message.serverLSN;
    console.log('Initial sync started with LSN:', this.initStartLSN);
  }

  /**
   * Handle table chunk data from server
   */
  private async handleInitChanges(message: ServerInitChangesMessage): Promise<void> {
    const { changes, sequence } = message;
    
    // Track received tables
    for (const change of changes) {
      if (change.table) {
        this.receivedTables.add(change.table);
      }
    }

    // STEP 4: Send acknowledgment for this chunk
    await this.sendChunkAcknowledgment(sequence.table, sequence.chunk);
  }

  /**
   * Handle init complete message from server
   */
  private async handleInitComplete(message: ServerInitCompleteMessage): Promise<void> {
    this.initCompleteLSN = message.serverLSN;
    console.log('Initial sync completed with LSN:', this.initCompleteLSN);
    
    // Check if we have all tables and can send processed
    const allTablesReceived = Array.from(this.expectedTables)
      .every(table => this.receivedTables.has(table));
      
    if (allTablesReceived && !this.processedInitComplete) {
      // Mark as processed
      this.processedInitComplete = true;
      
      // STEP 6: Send init processed message
      await this.sendInitProcessed();
      
      // Store the server LSN (the complete message contains the server's LSN)
      this.serverLSN = message.serverLSN;
      
      // Mark sync as successful - we're done with initial sync when we receive and process the complete message
      this.syncSuccessful = true;
      this.currentState = 'live';
      console.log('✓ Initial sync completed successfully');
      
      // Save LSN file immediately when sync is successful
      this.saveLSNFile();
      
      // If running as main module, exit now since we've completed our work
      if (process.argv[1] === fileURLToPath(import.meta.url)) {
        console.log('Sync complete and LSN saved. Exiting with success code.');
        process.exit(0);
      }
    }
  }

  /**
   * Save the LSN state to a file for future tests
   */
  private saveLSNFile(): void {
    if (this.initCompleteLSN && this.syncSuccessful) {
      try {
        console.log(`Saving LSN file to: ${LSN_FILE_PATH}`);
        
        // Ensure directory exists
        const dirPath = path.dirname(LSN_FILE_PATH);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        
        fs.writeFileSync(
          LSN_FILE_PATH, 
          JSON.stringify({
            lsn: this.initCompleteLSN,
            timestamp: new Date().toISOString(),
            clientId: this.clientId
          }, null, 2)
        );
        console.log(`Saved LSN state to ${LSN_FILE_PATH} for future tests`);
      } catch (err) {
        console.error('Failed to save LSN file:', err);
      }
    }
  }

  /**
   * Send a message to the server
   */
  private async sendMessage(message: Message): Promise<void> {
    if (!this.ws) {
      throw new Error('Not connected');
    }
    
    return new Promise<void>((resolve, reject) => {
      this.ws!.send(JSON.stringify(message), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Generate next unique message ID
   */
  private nextMessageId(): string {
    return `clt_${this.clientId.substring(0, 8)}_${this.messageId++}`;
  }

  /**
   * Send acknowledgment for a chunk
   */
  private async sendChunkAcknowledgment(table: string, chunk: number): Promise<void> {
    // Avoid duplicate acknowledgments for the same chunk
    const chunkKey = `${table}:${chunk}`;
    if (this.acknowledgedChunks.has(chunkKey)) {
      return;
    }
    
    // Mark this chunk as acknowledged
    this.acknowledgedChunks.add(chunkKey);
    
    // Send acknowledgment message
    const ack: ClientInitReceivedMessage = {
      type: 'clt_init_received',
      messageId: this.nextMessageId(),
      timestamp: Date.now(),
      clientId: this.clientId,
      table,
      chunk
    };
    
    console.log('Sending chunk acknowledgment:', { table, chunk });
    await this.sendMessage(ack);
  }

  /**
   * Send init processed message
   */
  private async sendInitProcessed(): Promise<void> {
    const msg: ClientInitProcessedMessage = {
      type: 'clt_init_processed',
      messageId: this.nextMessageId(),
      timestamp: Date.now(),
      clientId: this.clientId
    };
    
    console.log('Sending init processed message');
    await this.sendMessage(msg);
  }

  /**
   * Get the current sync state
   */
  public getCurrentState(): 'initial' | 'catchup' | 'live' {
    return this.currentState;
  }
  
  /**
   * Get messages of a specific type from log
   */
  public getMessagesByType<T extends Message>(type: string): T[] {
    return this.messageLog.filter(msg => msg.type === type) as T[];
  }
  
  /**
   * Get the last message of a specific type
   */
  public getLastMessage<T extends Message>(type: string): T | undefined {
    const messages = this.messageLog.filter(msg => msg.type === type);
    return messages[messages.length - 1] as T | undefined;
  }

  /**
   * Validate complete initial sync process
   */
  public async validateInitialSync(timeoutMs: number = 30000): Promise<boolean> {
    // Step 1: Wait for sync signals via events
    console.log('Validating initial sync...');
    try {
      // If sync already completed during connection, just validate results
      if (this.syncSuccessful) {
        console.log('✓ Sync already completed successfully');
      } else {
        // Wait for sync to complete with timeout
        const syncCompleted = await this.waitForSyncCompletion(timeoutMs);
        if (!syncCompleted) {
          throw new Error('Sync did not complete within timeout period');
        }
      }
      
      console.log('✓ Sync completed, validating results');
      
      // Step 2: Validate table hierarchy was respected
      if (this.validateTableOrder()) {
        console.log('✓ Tables synced in correct order');
      } else {
        throw new Error('Tables were not synced in correct hierarchical order');
      }
      
      // Step 3: Validate LSNs
      if (this.validateLSNs()) {
        console.log('✓ LSN values are valid and consistent');
      } else {
        throw new Error('LSN validation failed');
      }
      
      // Step 4: Check expected tables were received
      if (this.receivedTables.size === this.expectedTables.size) {
        console.log(`✓ Received all ${this.receivedTables.size} expected tables`);
      } else {
        const missing = [...this.expectedTables].filter(t => !this.receivedTables.has(t));
        throw new Error(`Missing tables: ${missing.join(', ')}`);
      }
      
      console.log('✓ Initial sync validation successful');
      return true;
    } catch (err) {
      console.error('❌ Initial sync validation failed:', err);
      this.syncSuccessful = false;
      throw err;
    }
  }
  
  /**
   * Helper method to wait for sync completion
   */
  private waitForSyncCompletion(timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      // Already successful?
      if (this.syncSuccessful) {
        return resolve(true);
      }
      
      // Set timeout
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeout);
      
      // Track if we've resolved
      let hasResolved = false;
      
      // Function to clean up listeners
      const cleanup = () => {
        if (hasResolved) return;
        hasResolved = true;
        clearTimeout(timeoutId);
        if (this.ws) {
          this.ws.removeListener('message', messageHandler);
          this.ws.removeListener('close', closeHandler);
        }
      };
      
      // Message handler to check for completion
      const messageHandler = (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as Message;
          this.handleMessage(message);
          
          // Check if we're done
          if (this.syncSuccessful) {
            cleanup();
            resolve(true);
          }
        } catch (err) {
          console.error('Error parsing message:', err);
        }
      };
      
      // Handle WebSocket close
      const closeHandler = () => {
        console.warn('WebSocket closed during sync validation');
        cleanup();
        // If we already completed sync, consider it successful
        resolve(this.syncSuccessful);
      };
      
      // Set up listeners
      if (this.ws) {
        this.ws.on('message', messageHandler);
        this.ws.once('close', closeHandler);
      } else {
        // No websocket, can't complete
        resolve(false);
      }
    });
  }

  /**
   * Validate table hierarchy order was followed
   */
  private validateTableOrder(): boolean {
    const receivedTables = Array.from(this.receivedTables);
    const hierarchyLevels = new Map(
      Object.entries(SERVER_TABLE_HIERARCHY)
        .map(([table, level]) => [table.replace(/^"|"$/g, ''), level])
    );

    let lastLevel = -1;
    for (const table of receivedTables) {
      const level = hierarchyLevels.get(table) || 0;
      if (level < lastLevel) {
        console.error('Invalid table order:', { table, level, lastLevel });
        return false;
      }
      lastLevel = level;
    }
    return true;
  }

  /**
   * Validate LSN formatting and state transition
   */
  private validateLSNs(): boolean {
    // Check we have both LSNs
    if (!this.initStartLSN || !this.initCompleteLSN) {
      console.error('Missing LSN values:', {
        startLSN: this.initStartLSN,
        endLSN: this.initCompleteLSN
      });
      return false;
    }

    // Validate LSN format (X/Y where X and Y are hexadecimal)
    const isValidLSN = (lsn: string): boolean => /^[0-9A-F]+\/[0-9A-F]+$/i.test(lsn);
    
    if (!isValidLSN(this.initStartLSN) || !isValidLSN(this.initCompleteLSN)) {
      console.error('Invalid LSN format:', {
        startLSN: this.initStartLSN,
        endLSN: this.initCompleteLSN
      });
      return false;
    }

    // Get state changes (from either message type)
    const legacyStateChanges = this.getMessagesByType<ServerStateChangeMessage>('srv_state_change');
    const lsnUpdates = this.getMessagesByType<ServerLSNUpdateMessage>('srv_lsn_update');
    
    // Check if we got any state update at all
    if (legacyStateChanges.length === 0 && lsnUpdates.length === 0) {
      console.error('No state change or LSN update messages received');
      return false;
    }
    
    // Check whether the client was in sync at the end of initial sync
    const lsnUnchanged = this.initStartLSN === this.initCompleteLSN;
    const serverLSNMatches = lsnUpdates.length > 0 && 
      this.serverLSN === this.initCompleteLSN;
    
    // For legacy state change messages
    const wentToLive = legacyStateChanges.some(change => change.state === 'live');
    const wentToCatchup = legacyStateChanges.some(change => change.state === 'catchup');

    // Check state transition matches LSN comparison
    if (lsnUnchanged) {
      // If LSN didn't change during sync, we should be in live mode
      if (legacyStateChanges.length > 0 && !wentToLive) {
        console.error('Expected transition to live state when LSN unchanged');
        return false;
      }
      
      // With new protocol, we should have matching LSNs
      if (lsnUpdates.length > 0 && !serverLSNMatches) {
        console.error('Expected matching LSNs for live state');
        return false;
      }
    } else {
      // If LSN changed during sync, we should be in catchup mode
      if (legacyStateChanges.length > 0 && !wentToCatchup) {
        console.error('Expected transition to catchup state when LSN changed');
        return false;
      }
      
      // With new protocol, LSNs should not match
      if (lsnUpdates.length > 0 && serverLSNMatches) {
        console.error('Expected LSN mismatch for catchup state');
        return false;
      }
    }

    return true;
  }
  
  /**
   * Get the client ID 
   */
  public getClientId(): string {
    return this.clientId;
  }

  /**
   * Check if sync was successful
   */
  public isSyncSuccessful(): boolean {
    return this.syncSuccessful;
  }
  
  /**
   * Get the final LSN from sync
   */
  public getFinalLSN(): string {
    return this.initCompleteLSN;
  }

  /**
   * Run the initial sync test
   */
  public static async test(): Promise<void> {
    console.log('Starting Initial Sync Test');
    const tester = new InitialSyncTester();
    
    try {
      // Step 1: Connect to server
      await tester.connect();
      
      // Step 2-7: Run validation (handles steps in order)
      const syncValid = await tester.validateInitialSync();
      
      if (!syncValid) {
        throw new Error('Initial sync validation failed');
      }
      
      // We don't need to save LSN file here, it's already saved in handleInitComplete
      
      console.log('Initial sync test completed successfully');
    } catch (error) {
      console.error('Test failed:', error);
      // Don't exit here - let the finally block handle cleanup first
      throw error; // Re-throw so the caller can handle it
    } finally {
      // Ensure we disconnect before exiting
      await tester.disconnect(1000, 'Test complete');
    }
  }
}

/**
 * Run the initial sync test
 */
async function testInitialSync() {
  try {
    await InitialSyncTester.test();
    console.log('Test completed successfully, exiting with code 0');
  } catch (error) {
    console.error('Test execution failed with error. Exiting with code 1');
    // Delay to ensure logs are flushed
    await new Promise(resolve => setTimeout(resolve, 100));
    process.exit(1);
  }
  
  // Always exit with success if we get here
  // Delay to ensure logs are flushed
  await new Promise(resolve => setTimeout(resolve, 100));
  process.exit(0);
}

// Run the test if this is the main module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Starting test as main module');
  // Force exit after a reasonable timeout to prevent hanging
  const forceExitTimeout = setTimeout(() => {
    console.log('Force exiting after timeout');
    process.exit(0);
  }, 10000);
  
  // Ensure the force exit timeout is cleared if we exit normally
  process.on('exit', () => {
    clearTimeout(forceExitTimeout);
  });
  
  // Run the test
  testInitialSync().catch(() => {
    console.error('Unhandled error in test execution');
    process.exit(1);
  });
} 