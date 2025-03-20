import { SyncTester } from '../test-sync.js';
import { DEFAULT_CONFIG } from '../config.js';
import { SERVER_DOMAIN_TABLES, SERVER_TABLE_HIERARCHY } from '@repo/dataforge/server-entities';
import type { 
  ServerMessage,
  ServerInitChangesMessage,
  ServerStateChangeMessage,
  TableChange,
  ClientInitReceivedMessage,
  ClientInitProcessedMessage
} from '@repo/sync-types';

interface SyncValidationState {
  initStartReceived: boolean;
  initStartLSN: string;
  receivedTables: Set<string>;
  initCompleteReceived: boolean;
  initCompleteLSN: string;
  stateChanges: ServerStateChangeMessage[];
}

class InitialSyncTester extends SyncTester {
  private state: SyncValidationState;

  constructor() {
    super(DEFAULT_CONFIG);
    this.state = {
      initStartReceived: false,
      initStartLSN: '',
      receivedTables: new Set(),
      initCompleteReceived: false,
      initCompleteLSN: '',
      stateChanges: []
    };
  }

  public async connect(): Promise<void> {
    // Add LSN to WebSocket URL
    const wsUrl = new URL(this.config.wsUrl);
    wsUrl.searchParams.set('clientId', this.clientId);
    wsUrl.searchParams.set('lsn', '0/0'); // Start from beginning for initial sync
    this.config = { ...this.config, wsUrl: wsUrl.toString() };
    
    console.log('Connecting to sync server:', {
      url: wsUrl.toString(),
      clientId: this.clientId
    });
    
    await super.connect();
  }

  private async sendInitialAck(table: string, chunk: number): Promise<void> {
    const ack: ClientInitReceivedMessage = {
      type: 'clt_init_received',
      messageId: this.nextMessageId(),
      timestamp: Date.now(),
      clientId: this.clientId,
      table,
      chunk
    };
    console.log('Sending chunk acknowledgment:', {
      table,
      chunk,
      clientId: this.clientId
    });
    await this.sendMessage(ack);
  }

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

  private validateTableOrder(receivedTables: string[]): boolean {
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
   * Validate LSN format and state transitions based on LSN changes
   */
  private validateLSNProgression(): boolean {
    // Ensure we got both LSNs
    if (!this.state.initStartLSN || !this.state.initCompleteLSN) {
      console.error('Missing LSN values:', {
        startLSN: this.state.initStartLSN,
        endLSN: this.state.initCompleteLSN
      });
      return false;
    }

    // Validate LSN format (X/Y where X and Y are hexadecimal)
    const isValidLSN = (lsn: string): boolean => /^[0-9A-F]+\/[0-9A-F]+$/i.test(lsn);
    
    if (!isValidLSN(this.state.initStartLSN) || !isValidLSN(this.state.initCompleteLSN)) {
      console.error('Invalid LSN format:', {
        startLSN: this.state.initStartLSN,
        endLSN: this.state.initCompleteLSN
      });
      return false;
    }

    // Check state transition matches LSN comparison
    const lsnUnchanged = this.state.initStartLSN === this.state.initCompleteLSN;
    const wentToLive = this.state.stateChanges.some(change => change.state === 'live');
    const wentToCatchup = this.state.stateChanges.some(change => change.state === 'catchup');

    if (lsnUnchanged && !wentToLive) {
      console.error('Expected transition to live state when LSN unchanged');
      return false;
    }

    if (!lsnUnchanged && !wentToCatchup) {
      console.error('Expected transition to catchup state when LSN changed');
      return false;
    }

    return true;
  }

  public async validateInitialSync(timeoutMs: number = 30000): Promise<boolean> {
    const startTime = Date.now();
    const expectedTables = new Set(SERVER_DOMAIN_TABLES.map(t => t.replace(/^"|"$/g, '')));
    console.log('Starting initial sync validation:', {
      expectedTables: Array.from(expectedTables)
    });

    while (Date.now() - startTime < timeoutMs) {
      // Process all messages in the log
      const messages = this.getMessagesByType<ServerInitChangesMessage>('srv_init_changes');
      for (const msg of messages) {
        if (msg.type === 'srv_init_changes') {
          const { changes, sequence } = msg;
          for (const change of changes) {
            if (change.table) {
              this.state.receivedTables.add(change.table);
            }
          }
          // Send acknowledgment for each chunk with proper table and chunk info
          await this.sendInitialAck(sequence.table, sequence.chunk);
        }
      }

      // Check init start
      const initStart = this.getLastMessage<ServerMessage>('srv_init_start');
      if (initStart && !this.state.initStartReceived) {
        this.state.initStartReceived = true;
        this.state.initStartLSN = (initStart as any).serverLSN;
        console.log('Initial sync started with LSN:', this.state.initStartLSN);
      }

      // Check init complete
      const initComplete = this.getLastMessage<ServerMessage>('srv_init_complete');
      if (initComplete && !this.state.initCompleteReceived) {
        this.state.initCompleteReceived = true;
        this.state.initCompleteLSN = (initComplete as any).serverLSN;
        console.log('Initial sync completed with LSN:', this.state.initCompleteLSN);
        // Send processed message when we receive complete
        await this.sendInitProcessed();
      }

      // Track state changes
      this.state.stateChanges = this.getMessagesByType<ServerStateChangeMessage>('srv_state_change');

      // Validate complete flow
      if (this.state.initStartReceived && this.state.initCompleteReceived) {
        const currentState = this.getCurrentState();
        const allTablesReceived = Array.from(expectedTables)
          .every(table => this.state.receivedTables.has(table));
        const correctTableOrder = this.validateTableOrder(Array.from(this.state.receivedTables));
        const validLSNProgression = this.validateLSNProgression();
        
        if (currentState === 'live' && allTablesReceived && correctTableOrder && validLSNProgression) {
          console.log('Initial sync validation successful:', {
            tablesReceived: this.state.receivedTables.size,
            startLSN: this.state.initStartLSN,
            endLSN: this.state.initCompleteLSN,
            stateChanges: this.state.stateChanges.map(s => s.state),
            lsnUnchanged: this.state.initStartLSN === this.state.initCompleteLSN
          });
          return true;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.error('Initial sync validation failed:', {
      initStartReceived: this.state.initStartReceived,
      initCompleteReceived: this.state.initCompleteReceived,
      tablesReceived: this.state.receivedTables.size,
      missingTables: Array.from(expectedTables)
        .filter(t => !this.state.receivedTables.has(t)),
      currentState: this.getCurrentState(),
      lsnValidation: this.state.initStartReceived && this.state.initCompleteReceived ? {
        startLSN: this.state.initStartLSN,
        endLSN: this.state.initCompleteLSN,
        stateChanges: this.state.stateChanges.map(s => s.state)
      } : 'LSNs not received'
    });
    return false;
  }
}

async function testInitialSync() {
  console.log('Starting Initial Sync Test');
  const tester = new InitialSyncTester();
  
  try {
    await tester.connect();
    const syncValid = await tester.validateInitialSync();
    
    if (!syncValid) {
      throw new Error('Initial sync validation failed');
    }
    
    console.log('Initial sync test completed successfully');
  } finally {
    await tester.disconnect(1000, 'Test complete');
  }
}

// Run the test if this is the main module
if (process.argv[1] === new URL(import.meta.url).pathname) {
  testInitialSync().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
  });
} 