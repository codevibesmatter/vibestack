import { DEFAULT_CONFIG } from './config.js';
import { SyncTester } from './test-sync.js';

async function runSyncTest(): Promise<void> {
  console.log('Starting sync test with configuration:', {
    ...DEFAULT_CONFIG,
    wsUrl: DEFAULT_CONFIG.wsUrl // Log URL separately for security
  });

  const tester = new SyncTester(DEFAULT_CONFIG);

  try {
    await tester.connect();
    console.log('Connected successfully');

    // Run the test scenario
    await tester.runTest();
    
    console.log('Test completed successfully');
  } catch (error) {
    console.error('Test failed:', error instanceof Error ? error.message : error);
    await tester.disconnect(4000, 'Test failed');
    throw error;
  }
}

// Only run if this is the main module
if (process.argv[1] === new URL(import.meta.url).pathname) {
  runSyncTest().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

export { runSyncTest }; 