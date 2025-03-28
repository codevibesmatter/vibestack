import { SyncTester } from '../test-sync.js';
import { DEFAULT_CONFIG } from '../config.js';
import { Task, Project, User, Comment } from '@repo/dataforge/server-entities';
import { Client } from '@neondatabase/serverless';
import type { DataSource } from 'typeorm';
import type { 
  ServerChangesMessage,
  ServerStateChangeMessage,
  ServerLSNUpdateMessage,
  Message,
  ClientHeartbeatMessage,
  ServerSyncCompletedMessage,
  ServerCatchupCompletedMessage
} from '@repo/sync-types';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { createServerChange } from '../changes/server-changes.js';
import { generateFakeData } from '../utils/fake-data.js';
import inquirer from 'inquirer';
import { createMixedChanges, type EntityType } from '../changes/entity-changes.js';

// Load environment variables from .env file
config();

// Define test mode types
type TestMode = 'single' | 'batch' | 'custom';

// Define change types
type ChangeType = 'insert' | 'update' | 'delete';

// Interface for entity changes
interface EntityChanges {
  created: string[];
  updated: string[];
  deleted: string[];
}

// Interface for change distribution
interface ChangeDistribution {
  [key: string]: number;
}

// Interface for change tracking
interface ChangeTracker {
  pendingChanges: {
    [entityType: string]: {
      created: string[];
      updated: string[];
      deleted: string[];
    }
  };
  receivedChanges: {
    [changeId: string]: boolean;
  };
  batchSize: number;
  batchesCreated: number;
  changeDistribution: {[key: string]: number};
  totalChangesCreated: number;
  totalChangesReceived: number;
  allChangesReceived: boolean;
  testMode: TestMode;
}

// Enhanced test statistics
interface TestStats {
  totalMessages: number;
  changesMessages: number;
  catchupMessages: number;
  catchupChunksReceived: number;
  catchupChunksAcknowledged: number;
  lsnUpdateMessages: number;
  syncCompletedMessages: number;
  totalChangesReceived: number;
  finalLSN: string;
  clientId?: string;
  testCompletedSuccessfully: boolean;
  changeTracker: ChangeTracker;
}

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
 * Display an interactive menu to select test mode and configuration
 */
async function showTestMenu(): Promise<{
  testMode: TestMode;
  batchSize?: number;
  distribution?: ChangeDistribution;
}> {
  console.log('\n========================================');
  console.log('🔄 Catchup Sync Test Configuration');
  console.log('========================================\n');
  
  // Select test mode
  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: 'Select test mode:',
      choices: [
        { name: 'Single Changes (Original Test)', value: 'single' },
        { name: 'Batch Changes (Multiple entities)', value: 'batch' },
        { name: 'Custom Configuration', value: 'custom' }
      ]
    }
  ]);
  
  // Default configuration
  let batchSize = 3;
  let distribution: ChangeDistribution = { task: 0.5, project: 0.2, user: 0.2, comment: 0.1 };
  
  // If batch or custom mode, ask for batch size
  if (mode === 'batch' || mode === 'custom') {
    const batchSizeAnswer = await inquirer.prompt([
      {
        type: 'number',
        name: 'size',
        message: 'Enter batch size (number of changes to create):',
        default: mode === 'batch' ? 10 : 3,
        validate: (value) => value > 0 ? true : 'Please enter a number greater than 0'
      }
    ]);
    
    batchSize = batchSizeAnswer.size;
    
    // For custom mode, allow configuring distribution
    if (mode === 'custom') {
      console.log('\nEntity distribution (must sum to 1.0):');
      const distributionAnswer = await inquirer.prompt([
        {
          type: 'number',
          name: 'task',
          message: 'Task percentage (0.0-1.0):',
          default: 0.5,
          validate: (value) => (value >= 0 && value <= 1) ? true : 'Please enter a number between 0 and 1'
        },
        {
          type: 'number',
          name: 'project',
          message: 'Project percentage (0.0-1.0):',
          default: 0.2,
          validate: (value) => (value >= 0 && value <= 1) ? true : 'Please enter a number between 0 and 1'
        },
        {
          type: 'number',
          name: 'user',
          message: 'User percentage (0.0-1.0):',
          default: 0.2,
          validate: (value) => (value >= 0 && value <= 1) ? true : 'Please enter a number between 0 and 1'
        },
        {
          type: 'number',
          name: 'comment',
          message: 'Comment percentage (0.0-1.0):',
          default: 0.1,
          validate: (value) => (value >= 0 && value <= 1) ? true : 'Please enter a number between 0 and 1'
        }
      ]);
      
      // Safely calculate total and normalize distribution
      const values = Object.values(distributionAnswer) as number[];
      const total = values.reduce((sum, val) => sum + val, 0);
      
      // Create distribution object with normalized values
      distribution = {
        task: Number(distributionAnswer.task) / total,
        project: Number(distributionAnswer.project) / total,
        user: Number(distributionAnswer.user) / total,
        comment: Number(distributionAnswer.comment) / total
      };
      
      console.log('\nNormalized distribution:');
      Object.entries(distribution).forEach(([key, val]) => {
        console.log(`- ${key}: ${(val * 100).toFixed(1)}%`);
      });
    }
  }
  
  return {
    testMode: mode as TestMode,
    batchSize,
    distribution
  };
}

function getRandomChangeType(): ChangeType {
  const types: ChangeType[] = ['insert', 'update', 'delete'];
  return types[Math.floor(Math.random() * types.length)];
}

/**
 * Create database changes based on the selected test mode
 */
async function createChanges(
  sql: any, 
  tracker: ChangeTracker,
  testMode: TestMode
): Promise<boolean> {
  try {
    console.log(`\nCreating changes in ${testMode} mode...`);
    
    // Initialize pendingChanges for all entity types if not already present
    ['task', 'project', 'user', 'comment'].forEach(entityType => {
      tracker.pendingChanges[entityType] = tracker.pendingChanges[entityType] || 
        { created: [], updated: [], deleted: [] };
    });
    
    if (testMode === 'single') {
      // Original single change mode
      console.log(`Creating single Task insert...`);
      await createServerChange(sql, Task, 'insert');
      tracker.totalChangesCreated++;
      tracker.pendingChanges['task'].created.push('single-task'); // Add a placeholder ID for single mode
      
      console.log(`Successfully created single change (total: ${tracker.totalChangesCreated})`);
      return true;
    }
    else {
      // Batch mode with mixed entity types
      console.log(`Creating mixed entity batch of size ${tracker.batchSize}...`);
      console.time('batch-creation');
      
      // Create a batch of mixed changes using the entity-changes module
      const results = await createMixedChanges(sql, tracker.batchSize, tracker.changeDistribution);
      
      // Process results and update tracker
      let totalChangesInBatch = 0;
      
      // Update tracker with created changes
      Object.entries(results).forEach(([entityType, entityChanges]) => {
        if (!entityChanges) return;
        
        // Track created entities
        if (entityChanges.created && entityChanges.created.length > 0) {
          console.log(`- Created ${entityChanges.created.length} ${entityType}s`);
          tracker.pendingChanges[entityType].created.push(...entityChanges.created);
          totalChangesInBatch += entityChanges.created.length;
        }
        
        // Track updated entities
        if (entityChanges.updated && entityChanges.updated.length > 0) {
          console.log(`- Updated ${entityChanges.updated.length} ${entityType}s`);
          tracker.pendingChanges[entityType].updated.push(...entityChanges.updated);
          totalChangesInBatch += entityChanges.updated.length;
        }
        
        // Track deleted entities
        if (entityChanges.deleted && entityChanges.deleted.length > 0) {
          console.log(`- Deleted ${entityChanges.deleted.length} ${entityType}s`);
          tracker.pendingChanges[entityType].deleted.push(...entityChanges.deleted);
          totalChangesInBatch += entityChanges.deleted.length;
        }
      });
      
      // Update batch and change counts
      tracker.batchesCreated++;
      tracker.totalChangesCreated += totalChangesInBatch;
      
      console.timeEnd('batch-creation');
      console.log(`Successfully created batch ${tracker.batchesCreated} with ${totalChangesInBatch} changes`);
      return true;
    }
  } catch (error) {
    console.error('Failed to create changes:', error);
    return false;
  }
}

// Type guard for entity types
function isEntityType(value: string): value is EntityType {
  return ['task', 'project', 'user', 'comment'].includes(value);
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
  
  // Allow user to select test mode and configuration
  const testConfig = await showTestMenu();
  
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
  
  // Initialize change tracker based on test mode
  const changeTracker: ChangeTracker = {
    pendingChanges: {},
    receivedChanges: {},
    batchSize: testConfig.batchSize || 3,
    batchesCreated: 0,
    changeDistribution: testConfig.distribution || { task: 0.5, project: 0.2, user: 0.2, comment: 0.1 },
    totalChangesCreated: 0,
    totalChangesReceived: 0,
    allChangesReceived: false,
    testMode: testConfig.testMode
  };
  
  // Track statistics for reporting
  const stats: TestStats = {
    totalMessages: 0,
    changesMessages: 0,
    catchupMessages: 0,
    catchupChunksReceived: 0,
    catchupChunksAcknowledged: 0,
    lsnUpdateMessages: 0,
    syncCompletedMessages: 0,
    totalChangesReceived: 0,
    finalLSN: startingLSN,
    clientId: savedClientId,
    testCompletedSuccessfully: false,
    changeTracker
  };
  
  // Track various message types
  let changesReceived = false;
  let catchupCompleted = false;
  let batchChangesStarted = false; // Flag to prevent multiple batch starts
  let catchupHandled = false; // Global flag to track catchup handling

  // Test completion promise
  let resolveTestFinished: (value: void) => void;
  const testFinished = new Promise<void>((resolve) => {
    resolveTestFinished = resolve;
  });
  
  // Helper function to check if all changes have been received
  function checkAllChangesReceived() {
    // In single mode, we just check if we've received at least the number of changes we created
    if (testConfig.testMode === 'single') {
      if (stats.totalChangesReceived >= stats.changeTracker.totalChangesCreated) {
        console.log(`✅ Received all ${stats.changeTracker.totalChangesCreated} changes`);
        stats.changeTracker.allChangesReceived = true;
        stats.testCompletedSuccessfully = true;
        resolveTestFinished();
      }
      return;
    }
    
    // For batch modes, we check each specific entity ID
    let totalTracked = 0;
    let totalMatched = 0;
    
    // Count the total number of changes we're explicitly tracking
    Object.entries(stats.changeTracker.pendingChanges).forEach(([entityType, entityChanges]) => {
      const entityTotal = entityChanges.created.length + entityChanges.updated.length + entityChanges.deleted.length;
      totalTracked += entityTotal;
      
      // Count how many have been received
      let entityMatched = 0;
      entityChanges.created.forEach(id => {
        if (stats.changeTracker.receivedChanges[id]) entityMatched++;
      });
      entityChanges.updated.forEach(id => {
        if (stats.changeTracker.receivedChanges[id]) entityMatched++;
      });
      entityChanges.deleted.forEach(id => {
        if (stats.changeTracker.receivedChanges[id]) entityMatched++;
      });
      
      totalMatched += entityMatched;
      
      // Log progress for each entity type
      if (entityTotal > 0) {
        console.log(`${entityType}: ${entityMatched}/${entityTotal} changes received`);
      }
    });
    
    // Only log progress if we have tracked changes
    if (totalTracked > 0) {
      console.log(`Overall progress: ${totalMatched}/${totalTracked} tracked changes have been received`);
    }
    
    // If we've matched all changes, we're done
    if (totalMatched >= totalTracked && totalTracked > 0) {
      console.log(`✅ All ${totalTracked} changes have been received!`);
      stats.changeTracker.allChangesReceived = true;
      stats.testCompletedSuccessfully = true;
      resolveTestFinished();
    }
  }
  
  // Set up a message listener to process messages as they arrive
  tester.onMessage = (message) => {
    if ('type' in message) {
      stats.totalMessages++;
      
      // Handle changes messages
      if (message.type === 'srv_catchup_changes' as any) {
        const changesMsg = message as ServerChangesMessage;
        stats.catchupMessages++;
        stats.catchupChunksReceived++;
        
        console.log(`Received srv_catchup_changes message #${stats.catchupMessages}`);
        
        if (changesMsg.changes) {
          stats.totalChangesReceived += changesMsg.changes.length;
          console.log(`  Contains ${changesMsg.changes.length} changes`);
          
          // Track chunking information
          if (changesMsg.sequence) {
            console.log(`  Chunk ${changesMsg.sequence.chunk}/${changesMsg.sequence.total}`);
          }
          
          // Track LSN progression
          if (changesMsg.lastLSN) {
            console.log(`  Has lastLSN: ${changesMsg.lastLSN}`);
            if (compareLSN(changesMsg.lastLSN, finalLSN) > 0) {
              finalLSN = changesMsg.lastLSN;
              console.log(`  Updated finalLSN from changes message: ${finalLSN}`);
            }
          }
          
          // Track received changes by ID
          changesMsg.changes.forEach(change => {
            if (change?.data?.id) {
              const changeId = String(change.data.id);
              stats.changeTracker.receivedChanges[changeId] = true;
            }
          });
          
          // Send chunk acknowledgment
          try {
            const ackMessage: any = {
              type: 'clt_catchup_received',
              messageId: `clt_ack_${Date.now()}`,
              timestamp: Date.now(),
              clientId: tester.getClientId(),
              chunk: changesMsg.sequence?.chunk || 1,
              lsn: changesMsg.lastLSN || finalLSN
            };
            
            // Send the acknowledgment
            tester.sendMessage(ackMessage).then(() => {
              stats.catchupChunksAcknowledged++;
              console.log(`  ✅ Sent acknowledgment for chunk ${ackMessage.chunk} with LSN ${ackMessage.lsn}`);
            }).catch(err => {
              console.error(`  ❌ Failed to send acknowledgment:`, err);
            });
          } catch (ackError) {
            console.error(`  ❌ Error creating acknowledgment:`, ackError);
          }
        }
      }
      
      // Handle LSN updates
      else if (message.type === 'srv_lsn_update') {
        const lsnMsg = message as ServerLSNUpdateMessage;
        stats.lsnUpdateMessages++;
        console.log(`Received LSN update message: ${lsnMsg.lsn}`);
        
        if (lsnMsg.lsn) {
          if (compareLSN(lsnMsg.lsn, finalLSN) > 0) {
            console.log(`  Updated finalLSN from LSN update: ${lsnMsg.lsn}`);
            finalLSN = lsnMsg.lsn;
          }
        }
      }
      
      // Handle catchup sync completed message
      else if (message.type === 'srv_catchup_completed') {
        const syncCompletedMsg = message as ServerCatchupCompletedMessage;
        stats.syncCompletedMessages++;
        console.log(`Received catchup sync completed message: ${syncCompletedMsg.startLSN ? `startLSN=${syncCompletedMsg.startLSN}, ` : ''}finalLSN=${syncCompletedMsg.finalLSN}, changes=${syncCompletedMsg.changeCount}, success=${syncCompletedMsg.success}`);
        
        if (syncCompletedMsg.finalLSN) {
          if (compareLSN(syncCompletedMsg.finalLSN, finalLSN) > 0) {
            console.log(`  Updated finalLSN from sync completed message: ${syncCompletedMsg.finalLSN}`);
            finalLSN = syncCompletedMsg.finalLSN;
          }
        }
        
        // Check if we've received all expected changes
        checkAllChangesReceived();
      }
    }
  };
  
  try {
    // Initialize the Neon client using the neon() function
    console.log('Initializing database connection...');
    sql = neon(getDatabaseURL());
    console.log('Database connection initialized successfully');
    
    // Verify the connection is active before proceeding
    console.log('Verifying database connection...');
    const connectionCheck = await sql`SELECT 1 as connection_test`;
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
    
    // Create changes based on test mode
    const maxBatches = testConfig.testMode === 'single' ? 3 : 1; // For single mode, create 3 changes; for batch modes, create 1 batch
    
    for (let batchNum = 0; batchNum < maxBatches; batchNum++) {
      // Create the changes
      const success = await createChanges(sql, stats.changeTracker, testConfig.testMode);
      
      if (!success) {
        console.error(`Failed to create batch ${batchNum + 1}/${maxBatches}`);
        continue;
      }
      
      console.log(`Waiting for changes to be processed...`);
      
      // If we're doing multiple batches, wait a bit between them
      if (batchNum < maxBatches - 1) {
        console.log(`Waiting 5 seconds before next batch...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    // Initialize replication system via HTTP before connecting
    console.log('Initializing replication system...');
    const initSuccess = await initializeReplication();
    if (!initSuccess) {
      console.warn('Replication initialization failed. Proceeding anyway, but sync may not work correctly.');
    }
    
    // Wait for changes to be processed by the replication system AFTER initialization
    const replicationWaitTime = 10000; // 10 seconds
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
    await tester.connect(currentLSN, currentClientId);
    
    // Set a 30 second timeout for receiving all changes
    console.log(`Setting 30 second timeout to receive all changes...`);
    setTimeout(() => {
      if (!stats.changeTracker.allChangesReceived) {
        console.warn(`⚠️ Not all changes were received within timeout`);
        console.log(`Created ${stats.changeTracker.totalChangesCreated} changes, received ${stats.totalChangesReceived}`);
        
        // Complete the test even though not all changes were received
        stats.testCompletedSuccessfully = false;
      }
    }, 30000);
    
    // Wait for test completion
    await testFinished;
    
    // Save the new LSN to the file
    const lsnFile = path.join(process.cwd(), '.sync-test-lsn.json');
    
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
    console.log(`Test mode: ${testConfig.testMode}`);
    console.log(`Starting LSN: ${startingLSN}`);
    console.log(`Final LSN: ${finalLSN}`);
    console.log(`Client ID: ${tester.getClientId()}`);
    console.log(`Total changes created: ${stats.changeTracker.totalChangesCreated}`);
    
    // Calculate total tracked changes received
    let totalTrackedChanges = 0;
    Object.entries(stats.changeTracker.pendingChanges).forEach(([entityType, entityChanges]) => {
      totalTrackedChanges += entityChanges.created.length + entityChanges.updated.length + entityChanges.deleted.length;
    });
    console.log(`Total changes received: ${totalTrackedChanges}`);
    
    // Validate LSN advancement
    const lsnAdvanced = compareLSN(finalLSN, startingLSN) > 0;
    console.log(`LSN change: ${startingLSN} → ${finalLSN} (${lsnAdvanced ? 'advanced' : 'unchanged'})`);
    
    // Report sync status
    if (stats.syncCompletedMessages > 0) {
      if (totalTrackedChanges > 0) {
        console.log(`Catchup sync completed successfully with ${totalTrackedChanges} changes`);
      } else {
        console.log(`Sync completed with no changes - client was already up-to-date`);
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