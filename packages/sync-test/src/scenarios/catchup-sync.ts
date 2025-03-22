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
  ClientHeartbeatMessage
} from '@repo/sync-types';
import { createServerBulkChanges } from '../changes/server-changes.js';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

// Load environment variables from .env file
config();

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
      const fileContent = fs.readFileSync(lsnFile, 'utf8');
      const data = JSON.parse(fileContent);
      return {
        lsn: data.lsn || '0/0',
        clientId: data.clientId
      };
    }
    
    // Legacy location (for backward compatibility)
    const legacyFile = path.join(process.cwd(), '../../.lsn-state.json');
    if (fs.existsSync(legacyFile)) {
      const fileContent = fs.readFileSync(legacyFile, 'utf8');
      const data = JSON.parse(fileContent);
      return {
        lsn: data.lsn || '0/0',
        clientId: data.clientId
      };
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
  const [major1, minor1] = lsn1.split('/').map(Number);
  const [major2, minor2] = lsn2.split('/').map(Number);
  
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
 * 3. Server processes WAL changes since client's LSN
 * 4. Server sends changes in chunks via srv_send_changes messages
 * 5. Server updates client with final LSN via srv_lsn_update
 * 6. Server transitions to live state via srv_state_change
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
  let sql;
  
  try {
    // Initialize the Neon client using the neon() function
    console.log('Initializing database connection...');
    sql = neon(getDatabaseURL());
    console.log('Database connection initialized successfully');
    
    // Create server changes BEFORE connecting to the sync server
    console.log('Creating server changes...');
    await createServerBulkChanges(sql, Task, 10);
    
    // Wait for changes to be processed
    console.log('Waiting for changes to be processed...');
    await new Promise(resolve => setTimeout(resolve, DEFAULT_CONFIG.changeWaitTime));
    
    // Connect with existing LSN and client ID
    console.log('Connecting to server with existing LSN...');
    await tester.connect(startingLSN, savedClientId);
    
    // Send heartbeat with stored LSN to trigger catchup
    console.log('Sending heartbeat with stored LSN to trigger catchup...');
    const heartbeatMsg: ClientHeartbeatMessage = {
      type: 'clt_heartbeat',
      messageId: `clt_${Date.now()}`,
      timestamp: Date.now(),
      clientId: tester.getClientId(),
      lsn: startingLSN,
      active: true
    };
    await tester.sendMessage(heartbeatMsg);
    
    // Wait for catchup sync
    console.log('Waiting for catchup sync...');
    await new Promise(resolve => setTimeout(resolve, DEFAULT_CONFIG.syncWaitTime * 2));
    
    // Analyze messages
    const messages = tester.getMessageLog();
    
    // Track changes and state
    let changesMessages = 0;
    let totalChanges = 0;
    let lastReceivedLSN = startingLSN;
    let stateTransitions: string[] = [];
    let lastChunk = 0;
    let totalChunks = 0;
    
    // Organize by message type
    for (const msg of messages) {
      if ('type' in msg) {
        // Check for changes messages
        if (msg.type === 'srv_send_changes') {
          const changesMsg = msg as ServerChangesMessage;
          changesMessages++;
          
          if (changesMsg.changes) {
            totalChanges += changesMsg.changes.length;
            
            // Track chunking information
            if (changesMsg.sequence) {
              lastChunk = changesMsg.sequence.chunk;
              totalChunks = changesMsg.sequence.total;
            }
            
            // Track LSN progression
            if (changesMsg.lastLSN && compareLSN(changesMsg.lastLSN, lastReceivedLSN) > 0) {
              lastReceivedLSN = changesMsg.lastLSN;
            }
          }
        }
        
        // Check for state changes (legacy API)
        else if (msg.type === 'srv_state_change') {
          const stateMsg = msg as ServerStateChangeMessage;
          stateTransitions.push(stateMsg.state);
        }
        
        // Check for LSN updates (new API)
        else if (msg.type === 'srv_lsn_update') {
          const lsnMsg = msg as ServerLSNUpdateMessage;
          console.log(`LSN update received: ${lsnMsg.lsn}`);
          if (compareLSN(lsnMsg.lsn, lastReceivedLSN) > 0) {
            lastReceivedLSN = lsnMsg.lsn;
          }
        }
      }
    }
    
    // Get final LSN
    const finalLSN = lastReceivedLSN;
    
    // Save the new LSN to the file
    const lsnFile = path.join(process.cwd(), '.sync-test-lsn.json');
    fs.writeFileSync(
      lsnFile, 
      JSON.stringify({
        lsn: finalLSN,
        timestamp: new Date().toISOString(),
        clientId: tester.getClientId()
      }, null, 2)
    );
    
    // Report results
    console.log('\nCatchup Sync Results:');
    console.log('--------------------');
    console.log(`Starting LSN: ${startingLSN}`);
    console.log(`Final LSN: ${finalLSN}`);
    console.log(`srv_send_changes messages: ${changesMessages}`);
    
    if (totalChunks > 0) {
      console.log(`Chunking: ${lastChunk}/${totalChunks}`);
    }
    
    console.log(`Total changes received: ${totalChanges}`);
    
    if (stateTransitions.length > 0) {
      console.log(`State transitions: ${stateTransitions.join(' -> ')}`);
    }
    
    // Validate sync results
    if (totalChanges === 0) {
      console.warn('Warning: No changes received. This may indicate a problem with the catchup sync process.');
    } else {
      console.log('Success: Received changes during catchup');
    }
    
    // Validate LSN advancement
    if (startingLSN === finalLSN && totalChanges > 0) {
      console.warn('Warning: LSN did not advance despite receiving changes. This may indicate a synchronization issue.');
    } else if (compareLSN(finalLSN, startingLSN) > 0) {
      console.log('Success: LSN advanced as expected and saved to file');
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
    // Close database connection if it was opened
    if (sql) {
      console.log('Closing database connection...');
      await sql.end();
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
  testCatchupSync().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
  });
}

export { testCatchupSync }; 