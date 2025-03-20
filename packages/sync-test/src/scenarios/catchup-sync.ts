import { SyncTester } from '../test-sync.js';
import { DEFAULT_CONFIG } from '../config.js';
import { serverDataSource } from '@repo/dataforge';
import { Task } from '@repo/dataforge/server-entities';
import type { SrvMessageType, CltMessageType, TableChange } from '@repo/sync-types';
import { createServerBulkChanges } from '../changes/server-changes.js';
import fs from 'fs';
import path from 'path';

interface ServerMessage {
  type: SrvMessageType;
  state?: 'initial' | 'catchup' | 'live';
  changes?: TableChange[];
}

interface ClientMessage {
  type: CltMessageType;
}

type Message = ServerMessage | ClientMessage;

function getLSNFromFile(): string {
  const lsnFile = path.join(process.cwd(), '.sync-test-lsn.json');
  try {
    if (fs.existsSync(lsnFile)) {
      const data = JSON.parse(fs.readFileSync(lsnFile, 'utf8'));
      return data.lsn;
    }
  } catch (err) {
    console.warn('Error loading LSN file:', err);
  }
  return '0/0';
}

async function testCatchupSync() {
  console.log('Starting Catchup Sync Test');
  
  const tester = new SyncTester(DEFAULT_CONFIG);
  
  try {
    // Connect and wait for initial sync
    console.log('Connecting to sync server...');
    await tester.connect();
    
    // Wait for initial sync to complete
    console.log('Waiting for initial sync to complete...');
    await new Promise(resolve => setTimeout(resolve, DEFAULT_CONFIG.syncWaitTime * 2));
    
    // Store LSN after initial sync
    const initialLSN = getLSNFromFile();
    console.log(`Initial sync complete. LSN: ${initialLSN}`);
    
    // Disconnect client
    console.log('Disconnecting client...');
    await tester.disconnect(1000, 'Test disconnect');
    
    // Create some server changes while disconnected
    console.log('Creating server changes...');
    await createServerBulkChanges(serverDataSource, Task, 5);
    
    // Wait for changes to be processed
    await new Promise(resolve => setTimeout(resolve, DEFAULT_CONFIG.changeWaitTime));
    
    // Reconnect client
    console.log('Reconnecting client...');
    await tester.connect();
    
    // Wait for catchup sync
    console.log('Waiting for catchup sync...');
    await new Promise(resolve => setTimeout(resolve, DEFAULT_CONFIG.syncWaitTime * 2));
    
    // Analyze catchup messages
    const messages = tester.getMessageLog() as Message[];
    let catchupMessages = 0;
    let catchupChanges = 0;
    
    for (const msg of messages) {
      if (msg.type === 'srv_send_changes') {
        const serverMsg = msg as ServerMessage;
        if (serverMsg.state === 'catchup') {
          catchupMessages++;
          if (serverMsg.changes) {
            catchupChanges += serverMsg.changes.length;
          }
        }
      }
    }
    
    // Get final LSN
    const finalLSN = getLSNFromFile();
    
    // Report results
    console.log('\nCatchup Sync Results:');
    console.log('--------------------');
    console.log(`Initial LSN: ${initialLSN}`);
    console.log(`Final LSN: ${finalLSN}`);
    console.log(`Catchup messages received: ${catchupMessages}`);
    console.log(`Catchup changes received: ${catchupChanges}`);
    
    if (catchupChanges === 0) {
      console.error('Warning: No catchup changes received');
    } else {
      console.log('Success: Received catchup changes');
    }
    
  } catch (error) {
    console.error('Test failed:', error);
    throw error;
  } finally {
    await tester.disconnect(1000, 'Test complete');
  }
}

// Run the test if this is the main module
if (process.argv[1] === new URL(import.meta.url).pathname) {
  testCatchupSync().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
  });
} 