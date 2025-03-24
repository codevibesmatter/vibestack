import { SyncTester } from '../test-sync.js';
import { DEFAULT_CONFIG } from '../config.js';
import { Task } from '@repo/dataforge/server-entities';
import { Client } from '@neondatabase/serverless';
import type { DataSource } from 'typeorm';
import type { 
  ServerChangesMessage,
  ServerStateChangeMessage,
  ServerLSNUpdateMessage,
  Message,
  ClientHeartbeatMessage,
  ServerSyncCompletedMessage
} from '@repo/sync-types';
import { createServerBulkChanges, createServerChange } from '../changes/server-changes.js';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
config();

// Configure the LSN state file path
const LSN_STATE_FILE = path.join(process.cwd(), '.sync-test-lsn.json');

// Structure for the LSN state file
interface LSNState {
  lsn: string;
  clientId?: string;
}

/**
 * Get database URL from environment
 */
function getDatabaseURL(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not defined in environment variables');
  }
  return databaseUrl;
}

/**
 * Read LSN and client ID information from state file
 */
function getLSNInfoFromFile(): LSNState {
  try {
    if (fs.existsSync(LSN_STATE_FILE)) {
      const content = fs.readFileSync(LSN_STATE_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('Error reading LSN file:', error);
  }
  
  // Default state if file doesn't exist or can't be read
  return {
    lsn: '0/0',
    clientId: undefined
  };
}

/**
 * Save LSN information to state file
 */
function saveLSNInfoToFile(lsn: string, clientId?: string): void {
  try {
    const state: LSNState = { lsn };
    if (clientId) {
      state.clientId = clientId;
    }
    
    fs.writeFileSync(LSN_STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`Saved LSN state to ${LSN_STATE_FILE} for future tests`);
  } catch (error) {
    console.error('Error saving LSN file:', error);
  }
}

/**
 * Call the replication initialization endpoint before connecting to WebSocket
 * This ensures the replication system is ready to process changes
 */
async function initializeReplication(): Promise<boolean> {
  try {
    // Convert the WebSocket URL to the base HTTP URL
    const wsUrl = new URL(DEFAULT_CONFIG.wsUrl);
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

/**
 * Test live synchronization with concurrent database operations
 */
async function testLiveSync(): Promise<number> {
  console.log('Starting Live Sync Test');
  
  // Load existing LSN and client ID from file
  const lsnInfo = getLSNInfoFromFile();
  const currentLSN = lsnInfo.lsn;
  let savedClientId = lsnInfo.clientId;
  
  console.log(`Using existing LSN: ${currentLSN}`);
  if (savedClientId) {
    console.log(`Using saved client ID: ${savedClientId}`);
  }
  
  // Initialize database connection
  console.log('Initializing database connection...');
  const databaseURL = getDatabaseURL();
  const sql = neon(databaseURL);
  
  console.log('Database connection initialized successfully');
  
  // Verify database connection
  console.log('Verifying database connection...');
  try {
    await sql`SELECT 1`;
    console.log('Database connection verified successfully');
  } catch (error) {
    console.error('Database connection verification failed:', error);
    return 1;
  }
  
  // Initialize replication system via HTTP before connecting
  console.log('Initializing replication system...');
  const initSuccess = await initializeReplication();
  if (!initSuccess) {
    console.warn('Replication initialization failed. Proceeding anyway, but sync may not work correctly.');
  }
  
  // Read the LSN file again to ensure we have the most recent value before connecting
  const updatedLsnInfo = getLSNInfoFromFile();
  const startLSN = updatedLsnInfo.lsn;
  const clientId = updatedLsnInfo.clientId || savedClientId;
  
  // Track stats for reporting
  const stats = {
    totalMessages: 0,
    changesMessages: 0,
    lsnUpdateMessages: 0,
    syncCompletedMessages: 0,
    totalChangesReceived: 0,
    finalLSN: startLSN,
    clientId: clientId,
    testCompletedSuccessfully: false  // Default to false and set to true only when all changes are created
  };
  
  // Setup sync tester with default config
  const tester = new SyncTester();
  
  // Track various message types
  let changesReceived = false;
  let syncCompleted = false;
  
  // Setup timeouts
  const timeoutDuration = 30000; // 30 seconds
  const testDuration = 30000;    // 30 seconds - shortened since we only need 3 changes max
  
  // Log message receipt
  const logMessageReceipt = (type: string) => {
    console.log(`📩 RECEIVED: ${type.substring(0, 12)} (total messages: ${stats.totalMessages})`);
  };
  
  // Setup message listener
  tester.onMessage = (message: Message) => {
    stats.totalMessages++;
    
    // Handle different message types
    switch (message.type) {
      case 'srv_send_changes':
        const changesMsg = message as ServerChangesMessage;
        logMessageReceipt(message.type);
        stats.changesMessages++;
        
        console.log(`Received srv_send_changes message #${stats.changesMessages}`);
        console.log(`  Contains ${changesMsg.changes.length} changes`);
        
        // Check if sequence information is available
        if (changesMsg.sequence) {
          console.log(`  Chunk ${changesMsg.sequence.chunk}/${changesMsg.sequence.total}`);
        }
        
        if (changesMsg.lastLSN) {
          console.log(`  Has lastLSN: ${changesMsg.lastLSN}`);
          stats.finalLSN = changesMsg.lastLSN;
        }
        
        stats.totalChangesReceived += changesMsg.changes.length;
        changesReceived = true;
        break;
        
      case 'srv_lsn_update':
        const lsnMsg = message as ServerLSNUpdateMessage;
        logMessageReceipt(message.type);
        stats.lsnUpdateMessages++;
        
        console.log(`Received LSN update: ${lsnMsg.lsn}`);
        if (lsnMsg.lsn) {
          stats.finalLSN = lsnMsg.lsn;
        }
        break;
        
      case 'srv_sync_completed':
        const syncMsg = message as ServerSyncCompletedMessage;
        logMessageReceipt(message.type);
        stats.syncCompletedMessages++;
        
        console.log(`Received sync completed message: startLSN=${syncMsg.startLSN}, finalLSN=${syncMsg.finalLSN}, changes=${syncMsg.changeCount}, success=${syncMsg.success}`);
        
        if (syncMsg.finalLSN) {
          stats.finalLSN = syncMsg.finalLSN;
          console.log(`Using final LSN from sync completed message: ${stats.finalLSN}`);
        }
        
        syncCompleted = true;
        break;
        
      default:
        logMessageReceipt(message.type);
        console.log(`Received other message type: ${message.type}`);
    }
  };
  
  // Connect to the server with the current LSN and client ID
  console.log('Connecting to server with current LSN...');
  await tester.connect(startLSN, clientId);
  
  // If we don't have a client ID yet, get it from the tester
  if (!stats.clientId) {
    stats.clientId = tester.getClientId();
    console.log(`New client ID assigned: ${stats.clientId}`);
  }
  
  console.log(`Running live sync test for ${testDuration / 1000} seconds...`);
  console.log('Will create database changes while connected to WebSocket...');
  
  let running = true;
  let changeInterval: NodeJS.Timeout;
  // Track number of changes created
  let changesCreated = 0;
  const maxChanges = 3; // Limit to 3 changes total

  // Create a promise that resolves when the test is complete
  const testFinished = new Promise<void>((resolve) => {
    // Set up an interval to create database changes
    changeInterval = setInterval(async () => {
      if (!running) return;
      
      // Stop after maxChanges created
      if (changesCreated >= maxChanges) {
        console.log(`Created ${maxChanges} changes, stopping test early...`);
        running = false;
        clearInterval(changeInterval);
        // Mark test as completed successfully
        stats.testCompletedSuccessfully = true;
        resolve();
        return;
      }
      
      try {
        // Create a single change in the database
        console.log(`Creating database change ${changesCreated + 1}/${maxChanges}...`);
        // Create a random insert operation for testing
        await createServerChange(sql as any, Task, 'insert');
        changesCreated++;
        console.log(`Database change ${changesCreated}/${maxChanges} created successfully`);
        
        // Log message count after each change to monitor for notifications
        console.log(`Current message count: ${stats.totalMessages}`);
        console.log(`Changes messages: ${stats.changesMessages}`);
        console.log(`LSN updates: ${stats.lsnUpdateMessages}`);
        
        // Optionally send a heartbeat to keep the connection alive
        try {
          // Ensure clientId is a string
          const clientIdForHeartbeat = stats.clientId || tester.getClientId();
          await tester.sendMessage({
            type: 'clt_heartbeat',
            messageId: `msg_${Date.now()}`,
            timestamp: Date.now(),
            clientId: clientIdForHeartbeat
          });
          console.log('Heartbeat sent to server');
        } catch (heartbeatError) {
          console.error('Failed to send heartbeat:', heartbeatError);
        }
      } catch (error: any) {
        console.error('Error creating database change:', error);
        console.error('Error details:', JSON.stringify(error, null, 2));
        if (error.statusCode === 426) {
          console.error('Received 426 error. Please check the server configuration.');
        }
      }
    }, 5000); // Create a change every 5 seconds
    
    // Set a timeout to end the test
    setTimeout(() => {
      console.log(`Test duration reached with ${changesCreated} changes created.`);
      console.log(`TIMEOUT: Test failed to create all ${maxChanges} changes in the allotted time.`);
      running = false;
      clearInterval(changeInterval);
      // Test timed out without completing all changes
      stats.testCompletedSuccessfully = false;
      resolve();
    }, testDuration);
  });
  
  // Wait for the test to complete
  await testFinished;
  
  // Give some extra time for final messages to arrive
  console.log('Test duration completed. Waiting for final messages...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Close the connection
  await tester.disconnect();
  
  // Analyze results
  console.log('\nMessage Analysis Summary:');
  console.log(`- Total messages received: ${stats.totalMessages}`);
  console.log(`- Found ${stats.changesMessages} srv_send_changes messages with ${stats.totalChangesReceived} total changes`);
  console.log(`- LSN updates: ${stats.lsnUpdateMessages}`);
  console.log(`- Sync completions: ${stats.syncCompletedMessages}`);
  console.log(`- Final LSN: ${stats.finalLSN}`);
  
  // Save the final LSN and client ID for future tests
  console.log(`Final LSN before saving: ${stats.finalLSN}`);
  
  // Only save the LSN if it's a valid value and not 0/0
  // This prevents overwriting a valid LSN with a default value
  if (stats.finalLSN && stats.finalLSN !== '0/0') {
    console.log(`Saving LSN to file: ${stats.finalLSN}`);
    saveLSNInfoToFile(stats.finalLSN, stats.clientId);
  } else {
    console.log(`Not saving invalid LSN: ${stats.finalLSN}`);
    console.log('This would reset the stored LSN value. Keeping the previous value.');
  }
  
  console.log('\nLive Sync Results:');
  console.log('--------------------');
  console.log(`Starting LSN: ${startLSN}`);
  console.log(`Final LSN: ${stats.finalLSN}`);
  console.log(`Client ID: ${stats.clientId}`);
  console.log(`Total messages: ${stats.totalMessages}`);
  console.log(`Changes messages: ${stats.changesMessages}`);
  console.log(`Total changes received: ${stats.totalChangesReceived}`);
  
  // Success criteria
  const lsnAdvanced = stats.finalLSN !== startLSN;
  const receivedAllChanges = stats.totalChangesReceived >= changesCreated;
  
  console.log(`Success: ${lsnAdvanced ? 'LSN advanced' : 'No LSN advancement'} from ${startLSN} to ${stats.finalLSN}`);
  console.log(`Success: ${changesReceived ? 'Received changes during live sync' : 'No changes received'}`);
  console.log(`Success: ${receivedAllChanges ? `Received all ${changesCreated} created changes` : `Missing some changes (received ${stats.totalChangesReceived}/${changesCreated})`}`);
  console.log(`Success: ${stats.testCompletedSuccessfully ? 'Test completed all changes' : 'Test timed out before creating all changes'}`);
  
  // Overall test success - now factors in whether the test completed all changes or timed out
  const testSucceeded = lsnAdvanced && changesReceived && receivedAllChanges && stats.testCompletedSuccessfully;
  console.log(`\nOverall Test Result: ${testSucceeded ? 'SUCCESS ✅' : 'FAILURE ❌'}`);
  
  console.log('Closing database connection...');
  // Don't actually need to close neon client
  console.log('Database connection closed');
  
  console.log('Test completed, checking results...');
  return testSucceeded ? 0 : 1; // Return non-zero exit code if test failed
}

// Run the live sync test if this file is executed directly
// In ESM, we can check if the current file path matches the entry point
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  testLiveSync()
    .then(exitCode => {
      process.exit(exitCode);
    })
    .catch(error => {
      console.error('Test failed with error:', error);
      process.exit(1);
    });
}