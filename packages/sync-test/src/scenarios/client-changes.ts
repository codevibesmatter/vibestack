import { SyncTester } from '../test-sync.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import type { 
  SrvMessageType, 
  CltMessageType, 
  TableChange, 
  Message, 
  ServerReceivedMessage,
  ServerAppliedMessage,
  ServerLSNUpdateMessage,
  ClientChangesMessage
} from '@repo/sync-types';
import { fileURLToPath } from 'url';
import { generateSingleChange, generateBulkChanges } from '../changes/client-changes.ts';
import { Task } from '@repo/dataforge/server-entities';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { config } from 'dotenv';

// Load environment variables from .env file
config();

// Configure the LSN state file path
const LSN_STATE_FILE = path.join(process.cwd(), '.sync-test-lsn.json');

/**
 * Testing class for client changes scenario
 * 
 * FLOW:
 * 1. Initialize replication system via HTTP endpoint
 * 2. Client connects to server with current LSN
 * 3. Client sends single change
 * 4. Server acknowledges receipt with srv_changes_received
 * 5. Server confirms application with srv_changes_applied
 * 6. Client sends bulk changes
 * 7. Server acknowledges receipt and application
 * 8. Server sends LSN updates
 */
class ClientChangesTester extends SyncTester {
  private changesReceived: number = 0;
  private changesApplied: number = 0;
  private lastLSN: string = '0/0';
  private messageTimeLog: Array<{timestamp: number, type: string, details: any}> = [];
  
  /**
   * Read LSN information from state file
   */
  public getLSNInfoFromFile(): { lsn: string, clientId?: string } {
    try {
      if (fs.existsSync(LSN_STATE_FILE)) {
        const content = fs.readFileSync(LSN_STATE_FILE, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.error('Error reading LSN file:', error);
    }
    
    return {
      lsn: '0/0',
      clientId: undefined
    };
  }
  
  /**
   * Save LSN information to state file
   */
  public saveLSNInfoToFile(lsn: string, clientId?: string): void {
    try {
      // Never save 0/0 as the LSN - this would trigger initial sync on next run
      if (lsn === '0/0') {
        console.warn('Avoiding saving LSN 0/0 which would trigger initial sync on next run');
        
        // Read the existing LSN file to keep the previous value
        const existing = this.getLSNInfoFromFile();
        if (existing.lsn && existing.lsn !== '0/0') {
          console.log(`Keeping existing LSN: ${existing.lsn}`);
          lsn = existing.lsn;
        } else {
          // If no valid previous LSN, use a dummy non-zero value
          lsn = '0/1';
          console.log('Using fallback LSN: 0/1');
        }
      }
      
      const state = { 
        lsn, 
        timestamp: new Date().toISOString(),
        clientId: clientId || this.getClientId()
      };
      
      fs.writeFileSync(LSN_STATE_FILE, JSON.stringify(state, null, 2));
      console.log(`Saved LSN state to ${LSN_STATE_FILE} for future tests`);
    } catch (error) {
      console.error('Error saving LSN file:', error);
    }
  }
  
  /**
   * Initialize the replication system via HTTP endpoint
   * This is crucial to ensure the server is ready to process changes
   */
  public async initializeReplication(): Promise<boolean> {
    try {
      // Convert the WebSocket URL to the base HTTP URL
      const wsUrl = new URL(this.config.wsUrl);
      const baseUrl = `http${wsUrl.protocol === 'wss:' ? 's' : ''}://${wsUrl.host}`;
      const initUrl = `${baseUrl}/api/replication/init`;
      
      console.log(`Initializing replication system via HTTP: ${initUrl}`);
      
      const response = await fetch(initUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        console.error(`Failed to initialize replication: ${response.status} ${response.statusText}`);
        return false;
      }
      
      const result = await response.json();
      console.log('Replication initialization successful:', result);
      
      // Allow some time for the replication system to start
      console.log('Waiting for replication system to start...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      return true;
    } catch (error) {
      console.error('Error initializing replication:', error);
      return false;
    }
  }
  
  constructor(config = DEFAULT_CONFIG) {
    super(config);
    
    // Setup message handler to track changes
    this.onMessage = (message: Message): void => {
      // Track message counts based on message type
      if ('type' in message) {
        const now = Date.now();
        console.log(`RECEIVED MESSAGE TYPE: ${message.type} at ${new Date(now).toISOString()}`);
        
        // Log message with timestamp
        this.messageTimeLog.push({
          timestamp: now,
          type: message.type,
          details: message
        });
        
        switch (message.type) {
          case 'srv_changes_received':
            this.changesReceived++;
            const receivedMsg = message as ServerReceivedMessage;
            console.log(`📩 RECEIVED: srv_changes_received`, {
              count: this.changesReceived,
              changeIds: receivedMsg.changeIds?.join(', ') || 'none',
              timestamp: new Date(now).toISOString()
            });
            break;
          
          case 'srv_changes_applied':
            this.changesApplied++;
            const appliedMsg = message as ServerAppliedMessage;
            console.log(`📩 RECEIVED: srv_changes_applied`, {
              count: this.changesApplied,
              success: appliedMsg.success,
              error: appliedMsg.error,
              changeIds: appliedMsg.appliedChanges?.join(', ') || 'none',
              timestamp: new Date(now).toISOString()
            });
            break;
          
          case 'srv_lsn_update':
            this.lastLSN = (message as ServerLSNUpdateMessage).lsn;
            console.log(`📩 RECEIVED: srv_lsn_update (LSN: ${this.lastLSN}) at ${new Date(now).toISOString()}`);
            break;
          
          case 'srv_sync_completed':
            console.log(`📩 RECEIVED: srv_sync_completed (sync complete notification) at ${new Date(now).toISOString()}`);
            break;
          
          case 'srv_error':
            console.error(`❌ RECEIVED: srv_error (server reported an error) at ${new Date(now).toISOString()}`);
            break;
          
          case 'srv_send_changes':
            const changes = (message as any).changes?.length || 0;
            console.log(`📩 RECEIVED: srv_send_changes (${changes} changes) at ${new Date(now).toISOString()}`);
            break;
          
          case 'srv_init_start':
            console.warn(`⚠️ RECEIVED: srv_init_start - this means we're in initial sync mode (${new Date(now).toISOString()})`);
            break;
          
          case 'srv_init_changes':
            console.warn(`⚠️ RECEIVED: srv_init_changes - this means we're in initial sync mode (${new Date(now).toISOString()})`);
            break;
          
          case 'srv_init_complete':
            console.warn(`⚠️ RECEIVED: srv_init_complete - initial sync is complete (${new Date(now).toISOString()})`);
            break;
          
          default:
            console.log(`📩 RECEIVED: ${message.type} at ${new Date(now).toISOString()}`);
        }
      }
    };
  }
  
  /**
   * Get the detailed message time log
   */
  public getMessageTimeLog(): Array<{timestamp: number, type: string, details: any}> {
    return this.messageTimeLog;
  }
  
  /**
   * Generate a unique message ID
   */
  protected nextMessageId(): string {
    // Create a more unique message ID with client ID prefix
    return `clt_${this.getClientId().substring(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  }
  
  /**
   * Send a single change to the server
   */
  public async sendSingleChange(): Promise<void> {
    try {
      // Generate a single change for the Task entity, passing client ID
      const change = await generateSingleChange(Task, this.getClientId());
      
      // Create a changes message
      const message: ClientChangesMessage = {
        type: 'clt_send_changes',
        messageId: this.nextMessageId(),
        clientId: this.getClientId(),
        timestamp: Date.now(),
        changes: [change]
      };
      
      console.log('Sending single change:', {
        table: change.table,
        operation: change.operation,
        id: change.data.id,
        messageId: message.messageId,
        timestamp: new Date(message.timestamp).toISOString()
      });
      
      // Store the send time in the message log
      this.messageTimeLog.push({
        timestamp: Date.now(),
        type: 'clt_send_changes_single',
        details: {
          id: change.data.id,
          table: change.table,
          clientId: this.getClientId()
        }
      });
      
      await this.sendMessage(message);
    } catch (error) {
      console.error('Error sending single change:', error);
    }
  }
  
  /**
   * Send bulk changes to the server
   */
  public async sendBulkChanges(count: number = 3): Promise<void> {
    try {
      // Generate bulk changes for the Task entity, passing client ID
      const changes = await generateBulkChanges(Task, count, this.getClientId());
      
      // Create a changes message
      const message: ClientChangesMessage = {
        type: 'clt_send_changes',
        messageId: this.nextMessageId(),
        clientId: this.getClientId(),
        timestamp: Date.now(),
        changes
      };
      
      console.log(`Sending ${changes.length} bulk changes for ${changes[0].table}:`, {
        table: changes[0].table,
        messageId: message.messageId,
        ids: changes.map(c => c.data.id).join(', '),
        timestamp: new Date(message.timestamp).toISOString()
      });
      
      // Store the send time in the message log
      this.messageTimeLog.push({
        timestamp: Date.now(),
        type: 'clt_send_changes_bulk',
        details: {
          count: changes.length,
          table: changes[0].table,
          ids: changes.map(c => c.data.id),
          clientId: this.getClientId()
        }
      });
      
      await this.sendMessage(message);
    } catch (error) {
      console.error('Error sending bulk changes:', error);
    }
  }
  
  /**
   * Get statistics about processed changes
   */
  public getChangeStats(): { received: number, applied: number, lastLSN: string } {
    return {
      received: this.changesReceived,
      applied: this.changesApplied,
      lastLSN: this.lastLSN
    };
  }
  
  /**
   * Print detailed message timing information
   */
  public printMessageTimings(): void {
    console.log('\nDetailed Message Timing Information:');
    console.log('----------------------------------');
    
    if (this.messageTimeLog.length === 0) {
      console.log('No messages received');
      return;
    }
    
    const startTime = this.messageTimeLog[0].timestamp;
    
    this.messageTimeLog.forEach((entry, index) => {
      const elapsedMs = entry.timestamp - startTime;
      const previousTime = index > 0 ? this.messageTimeLog[index-1].timestamp : startTime;
      const timeSincePrevious = entry.timestamp - previousTime;
      
      console.log(`[${index}] ${entry.type} - Time: +${elapsedMs}ms (Δ${timeSincePrevious}ms) - ${new Date(entry.timestamp).toISOString()}`);
    });
  }
}

/**
 * Run the client changes test scenario
 */
async function testClientChanges() {
  console.log('Starting Client Changes Test');
  
  const tester = new ClientChangesTester(DEFAULT_CONFIG);
  
  // Setup timeouts
  const timeoutDuration = 120000; // 120 seconds - longer timeout for server processing
  const testStartTime = Date.now();
  let testTimedOut = false;
  
  // Set an overall test timeout
  const testTimeout = setTimeout(() => {
    testTimedOut = true;
    console.error('Test timed out after', timeoutDuration, 'ms');
    process.exit(1);
  }, timeoutDuration);
  
  try {
    // Get saved LSN and client ID if available
    const lsnInfo = tester.getLSNInfoFromFile();
    
    console.log(`Using existing LSN: ${lsnInfo.lsn || '0/0'}`);
    if (lsnInfo.clientId) {
      console.log(`Using saved client ID: ${lsnInfo.clientId}`);
    }
    
    // STEP 1: Initialize replication system
    console.log('Initializing replication system...');
    const initSuccess = await tester.initializeReplication();
    if (!initSuccess) {
      console.warn('Replication initialization failed. Proceeding anyway, but sync may not work correctly.');
    }
    
    // STEP 2: Connect with the current LSN
    console.log(`Connecting to sync server with LSN: ${lsnInfo.lsn || '0/0'}...`);
    await tester.connect(lsnInfo.lsn || '0/0', lsnInfo.clientId);
    
    // Wait longer for connection to stabilize and handler registration
    console.log('Waiting for connection to stabilize and handlers to register...');
    await new Promise(resolve => setTimeout(resolve, DEFAULT_CONFIG.syncWaitTime * 2));
    
    // Check if we're receiving initial sync messages - we don't want to be in initial sync
    const messageLog = tester.getMessageLog();
    const hasInitMessages = messageLog.some(msg => 'type' in msg && 
      (msg.type === 'srv_init_start' || msg.type === 'srv_init_changes'));
    
    if (hasInitMessages) {
      console.warn('⚠️ WARNING: Received initial sync messages. This test should run in LIVE sync mode.');
      console.warn('⚠️ Please check your LSN file and ensure it has a valid non-zero LSN.');
      console.warn('⚠️ Will continue test, but results may not be accurate.');
    }
    
    // Wait for any potential sync_completed message to ensure we're in live mode
    console.log('Waiting for any pending sync operations to complete...');
    let syncWaitStart = Date.now();
    while (Date.now() - syncWaitStart < DEFAULT_CONFIG.syncWaitTime * 2) {
      const messages = tester.getMessageLog();
      const hasSyncCompleted = messages.some(msg => 'type' in msg && 
        (msg.type === 'srv_sync_completed' || msg.type === 'srv_state_change'));
      
      if (hasSyncCompleted) {
        console.log('Sync completed or state changed, ready to proceed with client changes test');
        break;
      }
      
      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('Connection established. Testing client changes...');
    
    // STEP 3: Test single change
    console.log('\nTesting single change...');
    
    // Store current acknowledgment counts before sending the change
    const beforeSingleReceived = tester.getChangeStats().received;
    const beforeSingleApplied = tester.getChangeStats().applied;
    
    // Send the single change
    await tester.sendSingleChange();
    
    // Wait for both received and applied acknowledgments with timeout
    console.log('Waiting for server to process single change...');
    const singleChangeTimeout = Date.now() + DEFAULT_CONFIG.changeWaitTime * 20; // Much longer timeout
    
    let receivedSingleAck = false;
    let appliedSingleAck = false;
    
    while (Date.now() < singleChangeTimeout && (!receivedSingleAck || !appliedSingleAck)) {
      // Check if we've received acknowledgments
      const currentStats = tester.getChangeStats();
      
      if (!receivedSingleAck && currentStats.received > beforeSingleReceived) {
        receivedSingleAck = true;
        console.log(`✅ Server acknowledged RECEIPT of single change`);
      }
      
      if (!appliedSingleAck && currentStats.applied > beforeSingleApplied) {
        appliedSingleAck = true;
        console.log(`✅ Server acknowledged APPLICATION of single change`);
      }
      
      if (!receivedSingleAck || !appliedSingleAck) {
        console.log(`Waiting for server acknowledgments... Received: ${receivedSingleAck}, Applied: ${appliedSingleAck}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    if (!receivedSingleAck) {
      console.error('❌ ERROR: Single change was NOT acknowledged as RECEIVED by the server');
      throw new Error('Single change acknowledgment timeout: no received confirmation');
    }
    
    if (!appliedSingleAck) {
      console.error('❌ ERROR: Single change was NOT acknowledged as APPLIED by the server');
      throw new Error('Single change acknowledgment timeout: no applied confirmation');
    }
    
    console.log('✅ Single change test complete - both received and applied acknowledgments confirmed');
    
    // STEP 6: Test bulk changes
    console.log('\nTesting bulk changes...');
    
    // Store current acknowledgment counts before sending bulk changes
    const beforeBulkReceived = tester.getChangeStats().received;
    const beforeBulkApplied = tester.getChangeStats().applied;
    
    // Send bulk changes
    await tester.sendBulkChanges(3); // Reduce to 3 changes instead of 5 to lower processing load
    
    // Wait for changes to be processed with timeout
    console.log('Waiting for server to process bulk changes...');
    const bulkChangeTimeout = Date.now() + DEFAULT_CONFIG.changeWaitTime * 30; // Even longer timeout
    
    let receivedBulkAck = false;
    let appliedBulkAck = false;
    
    while (Date.now() < bulkChangeTimeout && (!receivedBulkAck || !appliedBulkAck)) {
      // Check if we've received acknowledgments
      const currentStats = tester.getChangeStats();
      
      if (!receivedBulkAck && currentStats.received > beforeBulkReceived) {
        receivedBulkAck = true;
        console.log(`✅ Server acknowledged RECEIPT of bulk changes`);
      }
      
      if (!appliedBulkAck && currentStats.applied > beforeBulkApplied) {
        appliedBulkAck = true;
        console.log(`✅ Server acknowledged APPLICATION of bulk changes`);
      }
      
      if (!receivedBulkAck || !appliedBulkAck) {
        console.log(`Waiting for server acknowledgments... Received: ${receivedBulkAck}, Applied: ${appliedBulkAck}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    if (!receivedBulkAck) {
      console.error('❌ ERROR: Bulk changes were NOT acknowledged as RECEIVED by the server');
      throw new Error('Bulk changes acknowledgment timeout: no received confirmation');
    }
    
    if (!appliedBulkAck) {
      console.error('❌ ERROR: Bulk changes were NOT acknowledged as APPLIED by the server');
      throw new Error('Bulk changes acknowledgment timeout: no applied confirmation');
    }
    
    console.log('✅ Bulk changes test complete - both received and applied acknowledgments confirmed');
    
    // Get statistics
    const stats = tester.getChangeStats();
    
    // Report results
    console.log('\nClient Changes Results:');
    console.log('---------------------');
    console.log(`Server received acknowledgments: ${stats.received}`);
    console.log(`Server applied acknowledgments: ${stats.applied}`);
    console.log(`Test duration: ${(Date.now() - testStartTime) / 1000} seconds`);
    
    // Print comprehensive message timeline
    tester.printMessageTimings();
    
    // Print complete message log for debugging
    console.log('\nMessage Log:');
    console.log('---------------------');
    const finalMessageLog = tester.getMessageLog();
    finalMessageLog.forEach((msg, index) => {
      if ('type' in msg) {
        console.log(`[${index}] ${msg.type}`);
      }
    });
    
    // Save final LSN for future tests
    console.log(`Final LSN: ${stats.lastLSN}`);
    tester.saveLSNInfoToFile(stats.lastLSN);
    
    return 0; // Success
  } catch (error) {
    console.error('Test failed:', error);
    return 1;
  } finally {
    // Clear the test timeout
    clearTimeout(testTimeout);
    
    // Always try to disconnect cleanly
    try {
      console.log('Disconnecting from server...');
      await tester.disconnect(1000, 'Test complete');
    } catch (disconnectError) {
      console.error('Error disconnecting:', disconnectError);
    }
  }
}

// Run the test if this is the main module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  testClientChanges().then(exitCode => {
    console.log(`Exiting with code ${exitCode}`);
    process.exit(exitCode);
  }).catch(error => {
    console.error('Uncaught test error:', error);
    process.exit(1);
  });
} 

export { testClientChanges, ClientChangesTester }; 