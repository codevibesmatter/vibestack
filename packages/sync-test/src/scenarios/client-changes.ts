import { SyncTester } from '../test-sync.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { SrvMessageType, CltMessageType, TableChange } from '@repo/sync-types';
import { fileURLToPath } from 'url';

interface ServerMessage {
  type: SrvMessageType;
  state?: 'initial' | 'catchup' | 'live';
  changes?: TableChange[];
}

interface ClientMessage {
  type: CltMessageType;
}

type Message = ServerMessage | ClientMessage;

async function testClientChanges() {
  console.log('Starting Client Changes Test');
  
  const tester = new SyncTester(DEFAULT_CONFIG);
  
  try {
    // Connect and wait for initial sync
    console.log('Connecting to sync server...');
    await tester.connect();
    
    // Wait for initial sync to complete
    console.log('Waiting for initial sync to complete...');
    await new Promise(resolve => setTimeout(resolve, DEFAULT_CONFIG.syncWaitTime * 2));
    
    console.log('Initial sync complete. Testing client changes...');
    
    // Test single change
    console.log('\nTesting single change...');
    await (tester as any).sendSingleChange();
    
    // Wait for change to be processed
    await new Promise(resolve => setTimeout(resolve, DEFAULT_CONFIG.changeWaitTime));
    
    // Test bulk changes
    console.log('\nTesting bulk changes...');
    await (tester as any).sendBulkChanges();
    
    // Wait for changes to be processed
    await new Promise(resolve => setTimeout(resolve, DEFAULT_CONFIG.changeWaitTime));
    
    // Analyze server responses
    const messages = tester.getMessageLog() as Message[];
    let changesReceived = 0;
    let changesApplied = 0;
    
    for (const msg of messages) {
      if (msg.type === 'srv_changes_received') {
        changesReceived++;
      } else if (msg.type === 'srv_changes_applied') {
        changesApplied++;
      }
    }
    
    // Report results
    console.log('\nClient Changes Results:');
    console.log('---------------------');
    console.log(`Server received acknowledgments: ${changesReceived}`);
    console.log(`Server applied acknowledgments: ${changesApplied}`);
    
    if (changesApplied === 0) {
      console.error('Warning: No changes were applied by server');
    } else {
      console.log('Success: Changes were applied by server');
    }
    
    // Get final LSN
    const finalLSN = (tester as any).lastLSN;
    console.log(`Final LSN: ${finalLSN}`);
    
  } catch (error) {
    console.error('Test failed:', error);
    throw error;
  } finally {
    await tester.disconnect(1000, 'Test complete');
  }
}

// Run the test if this is the main module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  testClientChanges().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
  });
} 