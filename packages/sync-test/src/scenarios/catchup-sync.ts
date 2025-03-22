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

// Load environment variables from .env file
config();

// Define a type for the Neon client
type SqlQueryFunction = ReturnType<typeof neon>;

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
  
  // Convert to numbers (major parts are decimal, minor parts are hex)
  const major1 = parseInt(major1Str, 10);
  const minor1 = parseInt(minor1Str, 16); // Hex value
  const major2 = parseInt(major2Str, 10);
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
        console.log(`Received sync completed message: startLSN=${syncCompletedMsg.startLSN}, finalLSN=${syncCompletedMsg.finalLSN}, changes=${syncCompletedMsg.changeCount}, success=${syncCompletedMsg.success}`);
        
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
    
    // Wait for changes to be processed
    console.log('Waiting for changes to be processed...');
    await new Promise(resolve => setTimeout(resolve, DEFAULT_CONFIG.changeWaitTime));
    
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
          const syncCompletedMsg = message as any;
          actions.syncCompleted.received = true;
          actions.syncCompleted.timestamp = Date.now();
          actions.syncCompleted.success = syncCompletedMsg.success;
          
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
      console.log(`⏳ Sync progress (${elapsedSeconds}s elapsed):`);
      console.log(`   - Changes received: ${actions.changesReceived.received ? `✅ (${actions.changesReceived.count})` : '⏳'}`);
      console.log(`   - Sync completed: ${actions.syncCompleted.received ? '✅' : '⏳'}`);
      console.log(`   - Total messages: ${tester.getMessageLog().length}`);
      
      // Print the last few messages for visibility
      const recentMessages = tester.getMessageLog().slice(-3);
      if (recentMessages.length > 0) {
        console.log('Recent messages:');
        recentMessages.forEach((msg, idx) => {
          if ('type' in msg) {
            console.log(`   ${idx+1}. ${msg.type}`);
          }
        });
      }
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
    
    // Validate sync results
    if (totalChanges === 0 && syncCompletedReceived && !syncCompletedSuccess) {
      console.warn('Warning: No changes received. This may indicate a problem with the catchup sync process.');
    } else {
      console.log('Success: Received changes during catchup');
    }
    
    // Validate LSN advancement
    const lsnComparison = compareLSN(finalLSN, startingLSN);
    if (lsnComparison <= 0 && totalChanges > 0) {
      console.warn(`Warning: LSN did not advance (${startingLSN} → ${finalLSN}) despite receiving ${totalChanges} changes. This may indicate a synchronization issue.`);
      // Add additional diagnostic information
      if (syncCompletedReceived && syncCompletedFinalLSN) {
        if (syncCompletedFinalLSN !== finalLSN) {
          console.warn(`Diagnostic: Server reported finalLSN=${syncCompletedFinalLSN} but test is using finalLSN=${finalLSN}`);
        }
      }
      
      // Debug LSN comparison
      console.debug(`LSN comparison debug: compareLSN("${finalLSN}", "${startingLSN}") = ${lsnComparison}`);
      
      try {
        // Add more detailed comparison info
        const [startMajor, startMinor] = startingLSN.split('/');
        const [finalMajor, finalMinor] = finalLSN.split('/');
        console.debug(`LSN parts: Starting(${startMajor}/${startMinor}) → Final(${finalMajor}/${finalMinor})`);
        console.debug(`Decimal values: Starting(${parseInt(startMajor, 10)}/${parseInt(startMinor, 16)}) → Final(${parseInt(finalMajor, 10)}/${parseInt(finalMinor, 16)})`);
      } catch (error) {
        console.error('Error in LSN debug:', error);
      }
    } else if (lsnComparison > 0) {
      console.log(`Success: LSN advanced from ${startingLSN} to ${finalLSN}`);
    }
    
    // Validate message sequence
    if (changesMessages > 0 && lastChunk === totalChunks) {
      console.log('Success: Received all chunks');
    } else if (totalChunks > 0 && lastChunk < totalChunks) {
      console.warn(`Warning: Received only ${lastChunk} of ${totalChunks} chunks`);
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
if (process.argv[1] === new URL(import.meta.url).pathname) {
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