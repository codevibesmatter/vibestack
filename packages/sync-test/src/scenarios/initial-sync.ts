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

/**
 * Testing class for initial sync scenario
 * 
 * FLOW:
 * 1. Client connects to server with LSN=0
 * 2. Server sends srv_init_start message
 * 3. Server sends multiple srv_init_changes messages with table chunks
 * 4. Client acknowledges each chunk with clt_init_received message
 * 5. After all tables are sent, server sends srv_init_complete message
 * 6. Client sends clt_init_processed message
 * 7. Server sends srv_lsn_update with latest LSN
 */
class InitialSyncTester {
  // Tracking state
  private initStartLSN: string = '';
  private initCompleteLSN: string = '';
  private receivedTables: Set<string> = new Set();
  private expectedTables: Set<string>;
  private acknowledgedChunks: Set<string> = new Set();
  private processedInitComplete: boolean = false;
  
  // Websocket and connection
  private ws: WebSocket | null = null;
  private config = DEFAULT_CONFIG;
  private clientId: string;
  private messageId = 0;
  private messageLog: Message[] = [];
  private currentState: 'initial' | 'catchup' | 'live' = 'initial';
  private serverLSN: string = '';
  
  constructor() {
    // Generate client ID
    this.clientId = `client_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    // Get expected table names from domain tables
    this.expectedTables = new Set(SERVER_DOMAIN_TABLES.map(t => t.replace(/^"|"$/g, '')));
  }

  /**
   * Connect to server to begin sync
   */
  public async connect(): Promise<void> {
    // STEP 1: Setup connection with LSN=0 to start initial sync
    const wsUrl = new URL(this.config.wsUrl);
    wsUrl.searchParams.set('clientId', this.clientId);
    wsUrl.searchParams.set('lsn', '0/0'); // Start from beginning
    
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
   * Disconnect from server
   */
  public async disconnect(code = 1000, reason = 'Test complete'): Promise<void> {
    if (this.ws) {
      this.ws.close(code, reason);
    }
    this.ws = null;
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
      } else if (message.type === 'srv_lsn_update') {
        // New LSN-only update message
        this.serverLSN = (message as ServerLSNUpdateMessage).lsn;
        
        // Derive state from LSN comparison
        if (this.initStartLSN === '0/0' || !this.initStartLSN) {
          this.currentState = 'initial';
        } else if (this.serverLSN !== this.initCompleteLSN) {
          this.currentState = 'catchup';
        } else {
          this.currentState = 'live';
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
        console.log('Received LSN update:', (message as ServerLSNUpdateMessage).lsn);
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
      this.processedInitComplete = true;
      // STEP 6: Send init processed message
      await this.sendInitProcessed();
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
    return `clt_${Date.now()}_${this.messageId++}`;
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
    // Step 1: Wait for the sync to complete (state becomes live)
    console.log('Validating initial sync...');
    try {
      // Wait for LSN match instead of state
      await this.waitForLSNMatch(timeoutMs);
      console.log('✓ LSNs match (client is in sync with server)');
      
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
    } catch (err) {
      console.error('❌ Initial sync validation failed:', err);
      throw err;
    }
    
    return true;
  }

  /**
   * Wait for a specific sync state with timeout
   */
  private waitForState(targetState: 'initial' | 'catchup' | 'live', timeout = 30000): Promise<boolean> {
    return new Promise(resolve => {
      const start = Date.now();
      const checkState = () => {
        if (this.currentState === targetState) {
          resolve(true);
        } else if (Date.now() - start > timeout) {
          resolve(false);
        } else {
          setTimeout(checkState, 100);
        }
      };
      checkState();
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
   * Wait for client and server LSNs to match (implies live state)
   */
  private waitForLSNMatch(timeout = 30000): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const checkLSNs = () => {
        // If LSNs match, we're in sync
        if (this.serverLSN && this.initCompleteLSN && 
            this.serverLSN === this.initCompleteLSN) {
          console.log('LSNs match:', this.serverLSN);
          return resolve(true);
        }
        
        // Check timeout
        if (Date.now() - startTime > timeout) {
          return reject(new Error(`Timeout waiting for LSN match. ` +
            `Server: ${this.serverLSN}, Client: ${this.initCompleteLSN}`));
        }
        
        // Check again after delay
        setTimeout(checkLSNs, 100);
      };
      
      // Start checking
      checkLSNs();
    });
  }
}

/**
 * Run the initial sync test
 */
async function testInitialSync() {
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
    
    // Save the LSN for future tests
    const finalLSN = tester.getLastMessage<ServerInitCompleteMessage>('srv_init_complete')?.serverLSN;
    if (finalLSN) {
      const lsnFilePath = path.join(process.cwd(), '.sync-test-lsn.json');
      fs.writeFileSync(
        lsnFilePath, 
        JSON.stringify({
          lsn: finalLSN,
          timestamp: new Date().toISOString(),
          clientId: tester.getClientId()
        }, null, 2)
      );
      console.log(`Saved LSN state to ${lsnFilePath} for future tests`);
    }
    
    console.log('Initial sync test completed successfully');
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    // Ensure we disconnect before exiting
    await tester.disconnect(1000, 'Test complete');
    
    // Only exit with success if we've reached this point without errors
    if (process.argv[1] === new URL(import.meta.url).pathname) {
      console.log('Exiting with success code');
      process.exit(0);
    }
  }
}

// Run the test if this is the main module
if (process.argv[1] === new URL(import.meta.url).pathname) {
  testInitialSync();
} 