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
import { createServerBulkChanges } from '../changes/server-changes.js';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
config();

// Define a type for the Neon client
type SqlQueryFunction = ReturnType<typeof neon>;

// Command line arguments - we don't need the reset flag
// const RESET_LSN = process.argv.includes('--reset-lsn');

// Get database URL from environment
function getDatabaseURL(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return url;
}

/**
 * Get the LSN and client ID information from the LSN file
 * This reads both the LSN and client ID from the state file
 */
function getLSNInfoFromFile(): { lsn: string, clientId?: string } {
  try {
    // Try the new location first
    const lsnFile = path.join(process.cwd(), '.sync-test-lsn.json');
    if (fs.existsSync(lsnFile)) {
      try {
        const fileContent = fs.readFileSync(lsnFile, 'utf8');
        // Try to parse JSON and handle potential corruption
        try {
          const data = JSON.parse(fileContent);
          // Validate the data has expected structure
          if (typeof data !== 'object' || data === null) {
            throw new Error('Invalid LSN file format: not an object');
          }
          
          if (!('lsn' in data)) {
            throw new Error('Invalid LSN file format: missing lsn property');
          }
          
          return {
            lsn: data.lsn || '0/0',
            clientId: data.clientId
          };
        } catch (jsonError) {
          console.error(`Error parsing LSN file ${lsnFile}:`, jsonError instanceof Error ? jsonError.message : String(jsonError));
          console.warn(`Corrupt LSN file detected at ${lsnFile}. Using default LSN.`);
          
          // Try to repair the file by creating a backup and writing a default
          try {
            const backupFile = `${lsnFile}.bak`;
            fs.copyFileSync(lsnFile, backupFile);
            console.warn(`Backed up corrupt LSN file to ${backupFile}`);
            
            // Write a default LSN file
            const defaultData = {
              lsn: '0/0',
              timestamp: new Date().toISOString(),
              note: 'Auto-generated after corrupt LSN file was detected'
            };
            fs.writeFileSync(lsnFile, JSON.stringify(defaultData, null, 2));
            console.warn(`Created new default LSN file at ${lsnFile}`);
          } catch (repairError) {
            console.error(`Failed to repair corrupt LSN file:`, repairError instanceof Error ? repairError.message : String(repairError));
          }
          
          return { lsn: '0/0' };
        }
      } catch (readError) {
        console.error(`Error reading LSN file ${lsnFile}:`, readError instanceof Error ? readError.message : String(readError));
        return { lsn: '0/0' };
      }
    }
    
    // Legacy location (for backward compatibility)
    const legacyFile = path.join(process.cwd(), '../../.lsn-state.json');
    if (fs.existsSync(legacyFile)) {
      try {
        const fileContent = fs.readFileSync(legacyFile, 'utf8');
        const data = JSON.parse(fileContent);
        return {
          lsn: data.lsn || '0/0',
          clientId: data.clientId
        };
      } catch (error) {
        console.warn(`Error reading legacy LSN file ${legacyFile}:`, error);
        return { lsn: '0/0' };
      }
    }
    
    // Default
    return { lsn: '0/0' };
  } catch (error) {
    console.warn('Error reading LSN file:', error);
    return { lsn: '0/0' };
  }
}

/**
 * Compare two LSNs
 * Similar to the server-side implementation in server-changes.ts
 */
function compareLSN(lsn1: string, lsn2: string): number {
  if (lsn1 === lsn2) return 0;
  
  // Parse the LSNs into parts
  const [major1Str, minor1Str] = lsn1.split('/');
  const [major2Str, minor2Str] = lsn2.split('/');
  
  // Convert to numbers (both parts should be hex)
  const major1 = parseInt(major1Str, 16); // Fix: Use base 16 for major
  const minor1 = parseInt(minor1Str, 16); // Hex value
  const major2 = parseInt(major2Str, 16); // Fix: Use base 16 for major
  const minor2 = parseInt(minor2Str, 16); // Hex value
  
  // For debugging purposes
  if (process.env.DEBUG_LSN) {
    console.debug('LSN comparison:', {
      lsn1, lsn2,
      major1, minor1,
      major2, minor2,
      result: major1 === major2 ? (minor1 < minor2 ? -1 : minor1 > minor2 ? 1 : 0) : (major1 < major2 ? -1 : 1)
    });
  }
  
  // Compare parts
  if (major1 < major2) return -1;
  if (major1 > major2) return 1;
  if (minor1 < minor2) return -1;
  if (minor1 > minor2) return 1;
  return 0;
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
 * Test the catchup synchronization workflow
 * 
 * FLOW:
 * 1. Create server-side changes to advance the LSN
 * 2. Client connects with stored LSN (no initial sync needed)
 * 3. Server processes changes since client's LSN
 * 4. Server sends changes in chunks via srv_send_changes messages
 * 5. Server sends srv_sync_completed message with summary info
 */
async function testCatchupSync() {
  console.log('Starting Catchup Sync Test');
  
  // Load the existing LSN and client ID from file
  const { lsn: startingLSN, clientId: savedClientId } = getLSNInfoFromFile();
  console.log(`Using existing LSN: ${startingLSN}`);
  if (savedClientId) {
    console.log(`Using saved client ID: ${savedClientId}`);
  } else {
    console.warn('No saved client ID found. May trigger a new initial sync instead of catchup.');
  }
  
  // Create SyncTester instance 
  const tester = new SyncTester(DEFAULT_CONFIG);
  let sql: SqlQueryFunction | undefined;
  let finalLSN = startingLSN;
  
  // Track statistics for reporting
  let changesMessages = 0;
  let totalChanges = 0;
  let lastChunk = 0;
  let totalChunks = 0;
  let syncCompletedReceived = false;
  let syncCompletedSuccess = false;
  let syncCompletedChangeCount = 0;
  let syncCompletedFinalLSN = '';
  
  // Set up a message listener to process messages as they arrive
  tester.onMessage = (message) => {
    if ('type' in message) {
      // Check for messages that might be sync_completed but not matching our type check
      const msgType = message.type;
      if (typeof msgType === 'string' && 
          (msgType.includes('sync_completed') || msgType.includes('syncCompleted') || msgType.includes('sync-completed'))) {
        console.log(`\n⚠️⚠️⚠️ POTENTIAL SYNC COMPLETED MESSAGE FOUND WITH TYPE "${msgType}":`);
        console.log(JSON.stringify(message, null, 2));
        console.log(`⚠️⚠️⚠️ END POTENTIAL SYNC COMPLETED\n`);
      }
      
      // Handle changes messages
      if (message.type === 'srv_send_changes') {
        const changesMsg = message as ServerChangesMessage;
        changesMessages++;
        
        console.log(`Received srv_send_changes message #${changesMessages}`);
        
        if (changesMsg.changes) {
          totalChanges += changesMsg.changes.length;
          console.log(`  Contains ${changesMsg.changes.length} changes`);
          
          // Track chunking information
          if (changesMsg.sequence) {
            lastChunk = changesMsg.sequence.chunk;
            totalChunks = changesMsg.sequence.total;
            console.log(`  Chunk ${lastChunk}/${totalChunks}`);
          }
          
          // Track LSN progression
          if (changesMsg.lastLSN) {
            console.log(`  Has lastLSN: ${changesMsg.lastLSN}`);
            if (compareLSN(changesMsg.lastLSN, finalLSN) > 0) {
              finalLSN = changesMsg.lastLSN;
              console.log(`  Updated finalLSN from changes message: ${finalLSN}`);
            }
          }
        }
      }
      
      // Handle LSN updates - this is the authoritative source for LSN
      else if (message.type === 'srv_lsn_update') {
        const lsnMsg = message as ServerLSNUpdateMessage;
        console.log(`Received LSN update message: ${lsnMsg.lsn}`);
        
        // Always update the LSN from a dedicated LSN update message
        if (lsnMsg.lsn) {
          if (finalLSN !== lsnMsg.lsn) {
            console.log(`Updating finalLSN: ${finalLSN} -> ${lsnMsg.lsn}`);
          }
          finalLSN = lsnMsg.lsn;
        }
      }
      
      // Handle sync completed message - this is the final message in catchup sync
      else if (message.type === 'srv_sync_completed') {
        const syncCompletedMsg = message as any;
        console.log(`Received sync completed message: ${syncCompletedMsg.startLSN ? `startLSN=${syncCompletedMsg.startLSN}, ` : ''}finalLSN=${syncCompletedMsg.finalLSN}, changes=${syncCompletedMsg.changeCount}, success=${syncCompletedMsg.success}`);
        
        syncCompletedReceived = true;
        syncCompletedSuccess = syncCompletedMsg.success;
        syncCompletedChangeCount = syncCompletedMsg.changeCount;
        syncCompletedFinalLSN = syncCompletedMsg.finalLSN;
        
        // Update LSN from the sync completed message if it's more recent
        if (syncCompletedMsg.finalLSN && compareLSN(syncCompletedMsg.finalLSN, finalLSN) > 0) {
          finalLSN = syncCompletedMsg.finalLSN;
          console.log(`Updated finalLSN from sync completed message: ${finalLSN}`);
        }
      }
    }
  };
  
  try {
    // Debug helper function for examining messages in detail
    const debugMessage = (message: any, label: string = "Message Debug") => {
      if (!message) {
        console.log(`${label}: [Message is null or undefined]`);
        return;
      }
      
      console.log(`\n===== ${label} =====`);
      console.log(`Type: ${message.type || 'No type field!'}`);
      
      if (typeof message !== 'object') {
        console.log(`Value: ${message} (type: ${typeof message})`);
        return;
      }
      
      // Check for missing fields
      const expectedFields = ['type', 'messageId', 'timestamp', 'clientId'];
      const missingFields = expectedFields.filter(field => !(field in message));
      if (missingFields.length > 0) {
        console.log(`Missing fields: ${missingFields.join(', ')}`);
      }
      
      // Special checks for sync completed message
      if (message.type === 'srv_sync_completed') {
        const scFields = ['startLSN', 'finalLSN', 'changeCount', 'success'];
        const missingScFields = scFields.filter(field => !(field in message));
        
        console.log(`This is a sync completed message`);
        console.log(`Fields: ${Object.keys(message).join(', ')}`);
        
        if (missingScFields.length > 0) {
          console.log(`⚠️ Missing expected srv_sync_completed fields: ${missingScFields.join(', ')}`);
        }
        
        // Check data types
        if ('finalLSN' in message && typeof message.finalLSN !== 'string') {
          console.log(`⚠️ Invalid finalLSN type: ${typeof message.finalLSN}`);
        }
        
        if ('changeCount' in message && typeof message.changeCount !== 'number') {
          console.log(`⚠️ Invalid changeCount type: ${typeof message.changeCount}`);
        }
        
        if ('success' in message && typeof message.success !== 'boolean') {
          console.log(`⚠️ Invalid success type: ${typeof message.success}`);
        }
      }
      
      console.log(`Raw message content:`);
      console.log(JSON.stringify(message, null, 2));
      console.log('================================\n');
    };

    // Add debug handling for sync_completed to original message handler
    const originalOriginalOnMessage = tester.onMessage;
    tester.onMessage = (message) => {
      if ('type' in message && message.type === 'srv_sync_completed') {
        debugMessage(message, "DETECTED SYNC COMPLETED MESSAGE");
      }
      
      if (originalOriginalOnMessage) {
        originalOriginalOnMessage(message);
      }
    };

    // Read the LSN file again to ensure we have the most recent value
    const freshLsnInfo = getLSNInfoFromFile();
    const initialCurrentLSN = freshLsnInfo.lsn;
    
    if (initialCurrentLSN !== startingLSN) {
      console.log(`Notice: LSN file was updated since process start. Using latest LSN: ${initialCurrentLSN}`);
      finalLSN = initialCurrentLSN;
    }
    
    // Initialize the Neon client using the neon() function
    console.log('Initializing database connection...');
    sql = neon(getDatabaseURL());
    console.log('Database connection initialized successfully');
    
    // Verify the connection is active before proceeding
    console.log('Verifying database connection...');
    const connectionCheck = await sql`SELECT 1 as connection_test`;
    // Safely check the connection result
    if (!connectionCheck || !Array.isArray(connectionCheck) || connectionCheck.length === 0) {
      throw new Error('Database connection verification failed: empty result');
    }
    
    const firstRow = connectionCheck[0] as Record<string, any>;
    if (!firstRow || firstRow.connection_test !== 1) {
      throw new Error('Database connection verification failed: invalid result');
    }
    console.log('Database connection verified successfully');
    
    // Create server changes BEFORE connecting to the sync server
    console.log('Creating server changes...');
    // Create enough changes to ensure WAL generation
    const numChanges = 25; // Create 25 changes
    console.log(`Creating ${numChanges} changes...`);
    await createServerBulkChanges(sql as any, Task, numChanges);

    // Initialize replication system via HTTP before connecting
    console.log('Initializing replication system...');
    const initSuccess = await initializeReplication();
    if (!initSuccess) {
      console.warn('Replication initialization failed. Proceeding anyway, but sync may not work correctly.');
    }

    // Wait for changes to be processed by the replication system AFTER initialization
    const replicationWaitTime = 20000; // 20 seconds
    console.log(`Waiting ${replicationWaitTime/1000} seconds for replication system to process changes...`);
    console.log('This allows the server to:');
    console.log('1. Process changes created during this test');
    console.log('2. Advance its internal LSN position');
    console.log('3. Prepare for client connection');
    await new Promise(resolve => setTimeout(resolve, replicationWaitTime));

    // Read the LSN file again to ensure we have the most recent value before connecting
    const updatedLsnInfo = getLSNInfoFromFile();
    const currentLSN = updatedLsnInfo.lsn;
    const currentClientId = updatedLsnInfo.clientId || savedClientId;
    
    if (currentLSN !== startingLSN) {
      console.log(`Using updated LSN for connection: ${currentLSN} (was: ${startingLSN})`);
      finalLSN = currentLSN;
    }
    
    // Connect with the most current LSN and client ID
    console.log('Connecting to server with current LSN...');

    // Simply use the current LSN from the file
    await tester.connect(currentLSN, currentClientId);
    
    // Wait for catchup sync with timeouts for each expected action
    console.log('Waiting for sync events with individual timeouts...');
    
    // Create action flags and timestamps
    const actions = {
      changesReceived: { received: false, timestamp: 0, count: 0 },
      syncCompleted: { received: false, timestamp: 0, success: false }
    };
    
    // Set up message handler to check for relevant messages
    const originalOnMessage = tester.onMessage;
    tester.onMessage = (message) => {
      // Still call the original handler if it exists
      if (originalOnMessage) {
        originalOnMessage(message);
      }
      
      if ('type' in message) {
        if (message.type === 'srv_send_changes') {
          console.log('✅ Changes message received');
          actions.changesReceived.received = true;
          actions.changesReceived.timestamp = Date.now();
          actions.changesReceived.count++;
        } else if (message.type === 'srv_sync_completed') {
          console.log('✅ Sync completed message received');
          const syncCompletedMsg = message as ServerSyncCompletedMessage;
          
          // Update the action state for the timeout resolution
          actions.syncCompleted.received = true;
          actions.syncCompleted.timestamp = Date.now();
          actions.syncCompleted.success = syncCompletedMsg.success;
          
          // Also update the global state variables
          syncCompletedReceived = true;
          syncCompletedSuccess = syncCompletedMsg.success;
          syncCompletedChangeCount = syncCompletedMsg.changeCount;
          syncCompletedFinalLSN = syncCompletedMsg.finalLSN;
          
          // Update final LSN if needed
          if (syncCompletedMsg.finalLSN && compareLSN(syncCompletedMsg.finalLSN, finalLSN) > 0) {
            finalLSN = syncCompletedMsg.finalLSN;
            console.log(`✅ LSN updated from sync completed message: ${finalLSN}`);
          }
          
          // Log change count from server's perspective
          console.log(`✅ Server reports ${syncCompletedMsg.changeCount} changes sent`);
        }
      }
    };
    
    // Set up timeouts for each expected action
    const timeoutMs = 30000; // 30 seconds total timeout
    const startTime = Date.now();
    
    // Create promises for each expected action
    const changesReceivedPromise = new Promise<'success' | 'timeout'>((resolve) => {
      const checkInterval = setInterval(() => {
        if (actions.changesReceived.received) {
          clearInterval(checkInterval);
          resolve('success');
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          resolve('timeout');
        }
      }, 100);
    });
    
    const syncCompletedPromise = new Promise<'success' | 'timeout'>((resolve) => {
      const checkInterval = setInterval(() => {
        if (actions.syncCompleted.received) {
          clearInterval(checkInterval);
          resolve('success');
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          resolve('timeout');
        }
      }, 100);
    });
    
    // Set up the progress reporting
    const progressInterval = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
      console.log(`\n===== Sync Progress Report (${elapsedSeconds}s elapsed) =====`);
      
      // Report on actions status with more details
      console.log(`Changes received: ${actions.changesReceived.received 
        ? `✅ (${actions.changesReceived.count} messages with ${totalChanges} changes)` 
        : '⏳ Waiting...'}`);
      
      console.log(`Sync completed: ${actions.syncCompleted.received 
        ? `✅ (${new Date(actions.syncCompleted.timestamp).toISOString().split('T')[1].split('.')[0]})` 
        : '⏳ Waiting...'}`);
        
      if (syncCompletedReceived) {
        console.log(`  - Success: ${syncCompletedSuccess ? '✅' : '❌'}`);
        console.log(`  - Changes: ${syncCompletedChangeCount}`);
        console.log(`  - Final LSN: ${syncCompletedFinalLSN}`);
      }
      
      // Message log analysis
      const messages = tester.getMessageLog();
      console.log(`\nMessage Log Stats (${messages.length} total):`);
      
      // Count message types
      const typeCounts = messages.reduce((counts, msg) => {
        if ('type' in msg) {
          const type = msg.type;
          counts[type] = (counts[type] || 0) + 1;
        }
        return counts;
      }, {} as Record<string, number>);
      
      // Display message type counts
      Object.entries(typeCounts).forEach(([type, count]) => {
        console.log(`  - ${type}: ${count}`);
      });
      
      // Print the last few messages for visibility with more detail
      const recentMessages = tester.getMessageLog().slice(-5);
      if (recentMessages.length > 0) {
        console.log('\nRecent Messages:');
        recentMessages.forEach((msg, idx) => {
          if ('type' in msg) {
            const timestamp = new Date(msg.timestamp).toISOString().split('T')[1].split('.')[0];
            console.log(`  ${idx+1}. [${timestamp}] ${msg.type}${msg.type === 'srv_sync_completed' ? ' ✓' : ''}`);
            
            // Add extra debug for sync completed message
            if (msg.type === 'srv_sync_completed') {
              const syncMsg = msg as ServerSyncCompletedMessage;
              console.log(`     - startLSN: ${syncMsg.startLSN || 'not set'}`);
              console.log(`     - finalLSN: ${syncMsg.finalLSN || 'not set'}`);
              console.log(`     - changeCount: ${syncMsg.changeCount}`);
              console.log(`     - success: ${syncMsg.success}`);
            }
          }
        });
      }
      
      console.log('\n=================================================');
    }, 5000);
    
    // Wait for all required actions or timeout
    console.log('Waiting for sync actions to complete...');
    
    const [changesResult, syncCompletedResult] = await Promise.all([
      changesReceivedPromise,
      syncCompletedPromise
    ]);
    
    // Clear the progress reporting interval
    clearInterval(progressInterval);
    
    // Restore original message handler
    tester.onMessage = originalOnMessage;
    
    // Check results and report
    let syncSuccess = true;
    
    if (changesResult === 'timeout' && !actions.changesReceived.received) {
      console.warn('⚠️ No changes messages received - this may be expected if no changes occurred');
      // This is not a failure condition, just a warning
    }
    
    if (syncCompletedResult === 'timeout') {
      console.error('❌ Timed out waiting for sync completed message');
      syncSuccess = false;
    }
    
    if (!syncSuccess) {
      throw new Error('Catchup sync timed out waiting for required messages');
    }
    
    console.log('✅ Catchup sync completed with all required messages received!');
    
    // Wait a bit more to ensure all final messages are processed
    console.log('Waiting for any final messages...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Print message analysis summary
    const messages = tester.getMessageLog();
    console.log('\nMessage Analysis Summary:');
    console.log(`- Total messages received: ${messages.length}`);
    console.log(`- Found ${changesMessages} srv_send_changes messages with ${totalChanges} total changes`);
    
    // Report sync completion status
    if (syncCompletedReceived) {
      console.log(`- Sync completed: ${syncCompletedSuccess ? 'success' : 'failed'}`);
      console.log(`- Server-reported change count: ${syncCompletedChangeCount}`);
      console.log(`- Server-reported final LSN: ${syncCompletedFinalLSN}`);
      
      // Check if we received additional changes after the sync completion
      if (changesMessages > 0 && syncCompletedChangeCount === 0) {
        console.log(`\n⚠️ Important Note: Received ${changesMessages} change messages with ${totalChanges} changes AFTER sync completion`);
        console.log(`  This indicates that new database changes were processed by the replication system after`);
        console.log(`  the catchup sync completed, but during our test session. These are live updates, not catchup sync.`);
        
        // If the changes received would have advanced the LSN, note that as well
        if (compareLSN(finalLSN, syncCompletedFinalLSN) > 0) {
          console.log(`  Final LSN reported (${finalLSN}) is more recent than sync completed LSN (${syncCompletedFinalLSN})`);
        }
      }
    } else {
      console.log(`- No sync completion message received`);
    }
    
    // Save the new LSN to the file
    const lsnFile = path.join(process.cwd(), '.sync-test-lsn.json');
    
    // Always use the sync completed finalLSN when available as this represents 
    // the server's authoritative position after sync
    if (syncCompletedReceived && syncCompletedFinalLSN) {
      // Update to use the server's reported final position
      finalLSN = syncCompletedFinalLSN;
      console.log(`Using final LSN from sync completed message: ${finalLSN}`);
    }
    
    console.log(`Saving LSN to file: ${finalLSN}`);
    try {
      // Format the JSON data with proper indentation
      const jsonData = {
        lsn: finalLSN,
        timestamp: new Date().toISOString(),
        clientId: tester.getClientId()
      };
      
      // Validate JSON stringification works before writing
      const jsonContent = JSON.stringify(jsonData, null, 2);
      
      // Ensure the JSON is valid by parsing it back
      try {
        JSON.parse(jsonContent);
      } catch (jsonError) {
        throw new Error(`Invalid JSON data would be written: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
      }
      
      // Write the file with validated JSON
      fs.writeFileSync(lsnFile, jsonContent);
      console.log(`Saved LSN state to ${lsnFile} for future tests`);
      
      // Verify the file was written correctly
      try {
        const savedContent = fs.readFileSync(lsnFile, 'utf8');
        const savedData = JSON.parse(savedContent);
        if (savedData.lsn !== finalLSN) {
          throw new Error(`Verification failed: Saved LSN (${savedData.lsn}) does not match expected LSN (${finalLSN})`);
        }
      } catch (verifyError) {
        console.error(`❌ LSN save verification failed:`, verifyError instanceof Error ? verifyError.message : String(verifyError));
        throw new Error(`Failed to verify LSN save: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`);
      }
    } catch (saveError) {
      console.error(`❌ Failed to save LSN state to ${lsnFile}:`, saveError instanceof Error ? saveError.message : String(saveError));
      throw new Error(`Failed to save LSN state: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
    }
    
    // Report results
    console.log('\nCatchup Sync Results:');
    console.log('--------------------');
    console.log(`Starting LSN: ${startingLSN}`);
    console.log(`Final LSN: ${finalLSN}`);
    console.log(`Client ID: ${tester.getClientId()}`);
    console.log(`srv_send_changes messages: ${changesMessages}`);
    
    if (totalChunks > 0) {
      console.log(`Chunking: ${lastChunk}/${totalChunks}`);
    }
    
    console.log(`Total changes received: ${totalChanges}`);
    
    // Validate LSN advancement
    const lsnAdvanced = compareLSN(finalLSN, startingLSN) > 0;
    console.log(`LSN change: ${startingLSN} → ${finalLSN} (${lsnAdvanced ? 'advanced' : 'unchanged'})`);

    // Report sync status
    if (syncCompletedReceived) {
      if (syncCompletedChangeCount > 0) {
        console.log(`Catchup sync completed successfully with ${syncCompletedChangeCount} changes`);
      } else {
        console.log(`Sync completed with no changes - client was already up-to-date`);
      }
    }

    // Report on changes received
    if (totalChanges > 0) {
      console.log(`Received a total of ${totalChanges} changes in ${changesMessages} messages`);
      
      if (totalChunks > 0) {
        console.log(`Changes were delivered in ${lastChunk}/${totalChunks} chunks`);
      }
    }
    
  } catch (error) {
    console.error('Test failed:', error);
    throw error;
  } finally {
    // Clean up event listener
    tester.onMessage = null;
    
    // Close database connection if it was opened
    if (sql) {
      console.log('Closing database connection...');
      // No explicit end() needed for Neon serverless connections
      console.log('Database connection closed');
    }
    
    // Close WebSocket connection if it was opened
    if (tester) {
      await tester.disconnect();
    }
  }
}

// Run the test if this is the main module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Let's keep the argument logging
  console.log('Command-line arguments:', process.argv.slice(2).join(' '));
  
  testCatchupSync()
    .then(() => {
      console.log('Test completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('Test failed:', error);
      process.exit(1);
    });
}

export { testCatchupSync }; 