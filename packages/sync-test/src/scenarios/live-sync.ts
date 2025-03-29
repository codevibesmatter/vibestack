import { SyncTester } from '../test-sync.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { Task } from '@repo/dataforge/server-entities';
import { Client } from '@neondatabase/serverless';
import type { DataSource } from 'typeorm';
import type { 
  ServerChangesMessage,
  ServerStateChangeMessage,
  ServerLSNUpdateMessage,
  Message,
  ClientHeartbeatMessage,
  ServerSyncCompletedMessage,
  ClientMessage,
  CltMessageType,
  ServerCatchupCompletedMessage
} from '@repo/sync-types';
import { createServerBulkChanges, createServerChange } from '../changes/server-changes.ts';
import { createMixedChanges } from '../changes/entity-changes.ts';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import inquirer from 'inquirer';

// Load environment variables from .env file
config();

// Configure the LSN state file path
const LSN_STATE_FILE = path.join(process.cwd(), '.sync-test-lsn.json');

// Structure for the LSN state file
interface LSNState {
  lsn: string;
  clientId?: string;
}

// Define catchup message types using type instead of interface to avoid extension issues
type ServerCatchupChangesMessage = {
  type: 'srv_catchup_changes';
  messageId: string;
  timestamp: number;
  changes: any[];
  sequence?: {
    chunk: number;
    total: number;
  };
  lastLSN?: string;
};

// Define our own ClientCatchupReceivedMessage interface since it's not exported from sync-types
interface ClientCatchupReceivedMessage {
  type: 'clt_catchup_received';
  messageId: string;
  timestamp: number;
  clientId: string;
  chunk: number;
  lsn: string;
}

// Define test mode types
type TestMode = 'single' | 'batch' | 'custom';

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
 * Get current LSN value from server
 */
async function getCurrentLSN(): Promise<string | null> {
  try {
    // Convert the WebSocket URL to the base HTTP URL
    const wsUrl = new URL(DEFAULT_CONFIG.wsUrl);
    const baseUrl = `http${wsUrl.protocol === 'wss:' ? 's' : ''}://${wsUrl.host}`;
    const lsnUrl = `${baseUrl}/api/replication/lsn`;
    
    console.log(`Fetching current LSN: ${lsnUrl}`);
    
    const response = await fetch(lsnUrl);
    if (!response.ok) {
      console.error(`Failed to fetch LSN: ${response.status} ${response.statusText}`);
      return null;
    }
    
    const result = await response.json() as any;
    if (result && result.success && result.lsn) {
      console.log(`Current server LSN: ${result.lsn}`);
      return result.lsn;
    } else {
      console.error('Invalid LSN response:', result);
      return null;
    }
  } catch (error) {
    console.error('Error fetching current LSN:', error);
    return null;
  }
}

/**
 * Compare two LSNs
 * Similar to the server-side implementation
 */
function compareLSN(lsn1: string, lsn2: string): number {
  if (lsn1 === lsn2) return 0;
  
  // Parse the LSNs into parts
  const [major1Str, minor1Str] = lsn1.split('/');
  const [major2Str, minor2Str] = lsn2.split('/');
  
  // Convert to numbers (both parts should be hex)
  const major1 = parseInt(major1Str, 16); 
  const minor1 = parseInt(minor1Str, 16);
  const major2 = parseInt(major2Str, 16);
  const minor2 = parseInt(minor2Str, 16);
  
  // Compare parts
  if (major1 < major2) return -1;
  if (major1 > major2) return 1;
  if (minor1 < minor2) return -1;
  if (minor1 > minor2) return 1;
  return 0;
}

/**
 * Test live synchronization with concurrent database operations
 */
async function testLiveSync(): Promise<number> {
  console.log('Starting Live Sync Test');
  
  // Allow user to select test mode and configuration
  const testConfig = await showTestMenu();
  
  // Get the current LSN from the server first
  const currentServerLSN = await getCurrentLSN();
  if (!currentServerLSN) {
    console.error('Failed to get current LSN from server');
    return 1;
  }
  
  // Load existing client ID from file if available
  const lsnInfo = getLSNInfoFromFile();
  let savedClientId = lsnInfo.clientId;
  
  // Use server's current LSN instead of the saved one
  const currentLSN = currentServerLSN;
  console.log(`Using current server LSN: ${currentLSN}`);
  
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
  
  // Track stats for reporting
  const stats: TestStats = {
    totalMessages: 0,
    changesMessages: 0,
    catchupMessages: 0,
    catchupChunksReceived: 0,
    catchupChunksAcknowledged: 0,
    lsnUpdateMessages: 0,
    syncCompletedMessages: 0,
    totalChangesReceived: 0,
    finalLSN: currentLSN,
    clientId: savedClientId,
    testCompletedSuccessfully: false,
    changeTracker
  };
  
  // Setup sync tester with default config
  const tester = new SyncTester();
  
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
  
  // Log message receipt
  const logMessageReceipt = (type: string) => {
    console.log(`📩 RECEIVED: ${type.substring(0, 12)} (total messages: ${stats.totalMessages})`);
  };
  
  // Check if all changes have been received
  const checkAllChangesReceived = () => {
    const allExpectedChanges = new Set<string>();
    const allReceivedChanges = new Set<string>();
    
    // Collect all expected changes
    Object.entries(stats.changeTracker.pendingChanges).forEach(([entityType, entityChanges]) => {
      entityChanges.created.forEach(id => allExpectedChanges.add(id));
      entityChanges.updated.forEach(id => allExpectedChanges.add(id));
      entityChanges.deleted.forEach(id => allExpectedChanges.add(id));
    });
    
    // Collect all received changes
    Object.keys(stats.changeTracker.receivedChanges).forEach(id => {
      allReceivedChanges.add(id);
    });
    
    // Find missing changes
    const missingChanges = Array.from(allExpectedChanges).filter(id => !allReceivedChanges.has(id));
    
    // Check if we've received all expected changes
    const allReceived = Array.from(allExpectedChanges).every(id => allReceivedChanges.has(id));
    
    // Only show progress and missing changes if we're actually done waiting
    if (allReceived || stats.totalChangesReceived >= stats.changeTracker.totalChangesCreated) {
      if (missingChanges.length > 0) {
        console.log('\nMissing changes:');
        missingChanges.forEach(id => {
          // Find which entity type and change type this ID belongs to
          let found = false;
          Object.entries(stats.changeTracker.pendingChanges).forEach(([entityType, changes]) => {
            if (changes.created.includes(id)) {
              console.log(`❌ Missing created change for ${entityType}: ${id}`);
              found = true;
            }
            if (changes.updated.includes(id)) {
              console.log(`❌ Missing updated change for ${entityType}: ${id}`);
              found = true;
            }
            if (changes.deleted.includes(id)) {
              console.log(`❌ Missing deleted change for ${entityType}: ${id}`);
              found = true;
            }
          });
          
          if (!found) {
            console.log(`❌ Missing change with unknown type: ${id}`);
          }
        });
        
        console.log(`\nTotal missing changes: ${missingChanges.length}`);
        console.log(`Expected: ${allExpectedChanges.size}`);
        console.log(`Received: ${allReceivedChanges.size}`);
      }
      
      console.log('\n✅ All expected changes received!');
      console.log(`Total changes created: ${stats.changeTracker.totalChangesCreated}`);
      console.log(`Total changes received: ${stats.totalChangesReceived}`);
      console.log('\nChange summary by entity type:');
      
      Object.entries(stats.changeTracker.pendingChanges).forEach(([entityType, entityChanges]) => {
        const totalExpected = entityChanges.created.length + entityChanges.updated.length + entityChanges.deleted.length;
        const totalReceived = Object.keys(stats.changeTracker.receivedChanges).filter(id => 
          entityChanges.created.includes(id) || 
          entityChanges.updated.includes(id) || 
          entityChanges.deleted.includes(id)
        ).length;
        
        console.log(`${entityType}: ${totalReceived}/${totalExpected} changes received`);
      });
      
      // Only complete if we've received exactly the number of changes we created
      if (stats.totalChangesReceived === stats.changeTracker.totalChangesCreated) {
        stats.changeTracker.allChangesReceived = true;
        stats.testCompletedSuccessfully = true;
        resolveTestFinished();
      } else {
        console.log(`\nWaiting for more changes... (received ${stats.totalChangesReceived}/${stats.changeTracker.totalChangesCreated})`);
      }
    }
    
    return allReceived;
  };
  
  // Setup message listener
  tester.onMessage = async (message: any) => {
    stats.totalMessages++;
    
    // Handle different message types
    const msgType = message.type as string;
    switch (msgType) {
      case 'srv_catchup_changes':
        const catchupMsg = message as ServerCatchupChangesMessage;
        logMessageReceipt(msgType);
        stats.catchupMessages++;
        stats.catchupChunksReceived++;
        
        console.log(`Received catchup chunk ${catchupMsg.sequence?.chunk}/${catchupMsg.sequence?.total} with ${catchupMsg.changes?.length || 0} changes`);
        
        if (catchupMsg.lastLSN) {
          console.log(`  Last LSN in catchup: ${catchupMsg.lastLSN}`);
          stats.finalLSN = catchupMsg.lastLSN;
        }
        
        if (catchupMsg.changes) {
          stats.totalChangesReceived += catchupMsg.changes.length;
          stats.changeTracker.totalChangesReceived += catchupMsg.changes.length;
          
          // Track each change by ID
          catchupMsg.changes.forEach(change => {
            if (change?.data?.id) {
              stats.changeTracker.receivedChanges[change.data.id] = true;
            }
          });
        }
        
        // Send acknowledgment for the catchup chunk
        try {
          if (catchupMsg.sequence) {
            const ackMessage: ClientCatchupReceivedMessage = {
              type: 'clt_catchup_received',
              messageId: `ack_${Date.now()}`,
              timestamp: Date.now(),
              clientId: stats.clientId || tester.getClientId(),
              chunk: catchupMsg.sequence.chunk,
              lsn: catchupMsg.lastLSN || stats.finalLSN
            };
            
            // Cast the message to any to avoid type checking issues
            await tester.sendMessage(ackMessage as any);
            stats.catchupChunksAcknowledged++;
            console.log(`✅ Acknowledged catchup chunk ${catchupMsg.sequence.chunk}/${catchupMsg.sequence.total}`);
            
            // Check if this is the last chunk
            if (catchupMsg.sequence.chunk === catchupMsg.sequence.total) {
              console.log('All catchup chunks received and acknowledged');
              catchupCompleted = true;
              
              // If we're in catchup mode only, complete the test after catchup
              if (testConfig.testMode === 'single' && testConfig.batchSize === 0) {
                resolveTestFinished();
              } else {
                // Otherwise, start creating changes after catchup is complete
                console.log('Catchup complete, proceeding to create changes...');
                await runBatchedChanges();
              }
            }
          } else {
            console.warn('Catchup message missing sequence information, cannot acknowledge');
          }
        } catch (error) {
          console.error('Failed to send catchup acknowledgment:', error);
        }
        break;
        
      case 'srv_live_changes':
        const changesMsg = message as ServerChangesMessage;
        logMessageReceipt(msgType);
        stats.changesMessages++;
        changesReceived = true;
        
        console.log(`Received srv_live_changes message #${stats.changesMessages}`);
        console.log(`  Contains ${changesMsg.changes.length} changes`);
        
        // Check if sequence information is available
        if (changesMsg.sequence) {
          console.log(`  Chunk ${changesMsg.sequence.chunk}/${changesMsg.sequence.total}`);
        }
        
        if (changesMsg.lastLSN) {
          console.log(`  Has lastLSN: ${changesMsg.lastLSN}`);
          // Only update the LSN if the new one is greater
          if (compareLSN(changesMsg.lastLSN, stats.finalLSN) > 0) {
            console.log(`  Updated finalLSN from changes message: ${changesMsg.lastLSN} (previous: ${stats.finalLSN})`);
            stats.finalLSN = changesMsg.lastLSN;
          }
        }
        
        // Process and track received changes
        if (changesMsg.changes && changesMsg.changes.length > 0) {
          // Track unique entity IDs to avoid counting duplicates
          const processedIds = new Set<string>();
          
          // Track unique changes for counting
          changesMsg.changes.forEach((change: any) => {
            if (change?.data?.id) {
              const changeId = String(change.data.id);
              if (!processedIds.has(changeId)) {
                stats.totalChangesReceived++;
                stats.changeTracker.totalChangesReceived++;
                processedIds.add(changeId);
              }
            }
          });
          
          // Process all changes for matching against our expected changes
          changesMsg.changes.forEach((change: any) => {
            if (change?.data?.id) {
              const changeId = String(change.data.id);
              stats.changeTracker.receivedChanges[changeId] = true;
              
              // Check if we're tracking this change in our pending changes
              let matchFound = false;
              Object.values(stats.changeTracker.pendingChanges).forEach(entityChanges => {
                const isCreated = entityChanges.created.includes(changeId);
                const isUpdated = entityChanges.updated.includes(changeId);
                const isDeleted = entityChanges.deleted.includes(changeId);
                
                if (isCreated) {
                  console.log(`✅ Matched created entity: ${changeId}`);
                  matchFound = true;
                } else if (isUpdated) {
                  console.log(`✅ Matched updated entity: ${changeId}`);
                  matchFound = true;
                } else if (isDeleted) {
                  console.log(`✅ Matched deleted entity: ${changeId}`);
                  matchFound = true;
                }
              });
              
              if (!matchFound && testConfig.testMode !== 'single') {
                // For non-single mode, this might be a secondary notification
                console.log(`ℹ️ Received notification for entity: ${changeId} (not in tracked changes)`);
              }
            }
          });
          
          // Check if we've received all expected changes
          const allReceived = checkAllChangesReceived();
          
          // Only complete the test if we've received all changes
          if (allReceived && stats.totalChangesReceived >= stats.changeTracker.totalChangesCreated) {
            console.log(`\n✅ All ${stats.changeTracker.totalChangesCreated} changes received!`);
            stats.testCompletedSuccessfully = true;
            resolveTestFinished();
          } else {
            console.log(`\nWaiting for more changes... (received ${stats.totalChangesReceived}/${stats.changeTracker.totalChangesCreated})`);
          }
        }
        break;
        
      case 'srv_lsn_update':
        const lsnMsg = message as ServerLSNUpdateMessage;
        logMessageReceipt(message.type);
        stats.lsnUpdateMessages++;
        
        console.log(`Received LSN update: ${lsnMsg.lsn}`);
        if (lsnMsg.lsn) {
          // Always update from a dedicated LSN update message
          if (stats.finalLSN !== lsnMsg.lsn) {
            console.log(`  Updated finalLSN from LSN update: ${lsnMsg.lsn} (previous: ${stats.finalLSN})`);
          }
          stats.finalLSN = lsnMsg.lsn;
        }
        break;
        
      case 'srv_catchup_completed':
        const catchupCompletedMsg = message as ServerCatchupCompletedMessage;
        logMessageReceipt(message.type);
        stats.syncCompletedMessages++;
        
        console.log(`Received catchup completed message: ${catchupCompletedMsg.startLSN ? `startLSN=${catchupCompletedMsg.startLSN}, ` : ''}finalLSN=${catchupCompletedMsg.finalLSN}, changes=${catchupCompletedMsg.changeCount}, success=${catchupCompletedMsg.success}`);
        
        if (catchupCompletedMsg.finalLSN) {
          // Only update if the sync completion LSN is more recent
          if (compareLSN(catchupCompletedMsg.finalLSN, stats.finalLSN) > 0) {
            console.log(`  Updated finalLSN from catchup completed message: ${catchupCompletedMsg.finalLSN} (previous: ${stats.finalLSN})`);
            stats.finalLSN = catchupCompletedMsg.finalLSN;
          } else {
            console.log(`  Keeping current finalLSN: ${stats.finalLSN} (catchup completed LSN: ${catchupCompletedMsg.finalLSN})`);
          }
        }
        
        if (!catchupCompleted) {
          catchupCompleted = true;
          console.log('🔄 Catchup synchronization complete, proceeding with live changes');
          
          // Only try to start batch changes if they haven't been started yet
          // and the waitForCatchupToComplete function hasn't already handled it
          if (!batchChangesStarted && !catchupHandled) {
            console.log('Starting batch changes from catchup_completed handler...');
            startBatchChanges();
          } else {
            console.log(`Not starting batch changes: batchStarted=${batchChangesStarted}, catchupHandled=${catchupHandled}`);
          }
        }
        break;
        
      case 'srv_sync_completed':
        // Keep for backward compatibility with older server versions
        const syncMsg = message as ServerSyncCompletedMessage;
        logMessageReceipt(message.type);
        stats.syncCompletedMessages++;
        
        console.log(`Received sync completed message: ${syncMsg.startLSN ? `startLSN=${syncMsg.startLSN}, ` : ''}finalLSN=${syncMsg.finalLSN}, changes=${syncMsg.changeCount}, success=${syncMsg.success}`);
        
        if (syncMsg.finalLSN) {
          // Only update if the sync completion LSN is more recent
          if (compareLSN(syncMsg.finalLSN, stats.finalLSN) > 0) {
            console.log(`  Updated finalLSN from sync completed message: ${syncMsg.finalLSN} (previous: ${stats.finalLSN})`);
            stats.finalLSN = syncMsg.finalLSN;
          } else {
            console.log(`  Keeping current finalLSN: ${stats.finalLSN} (sync completed LSN: ${syncMsg.finalLSN})`);
          }
        }
        break;
        
      default:
        logMessageReceipt(message.type);
        console.log(`Received other message type: ${message.type}`);
    }
  };
  
  // Wait for catchup to complete before proceeding with live test
  async function waitForCatchupToComplete() {
    console.log('Waiting for catchup synchronization to complete...');
    
    if (catchupCompleted) {
      console.log('Catchup already completed, proceeding to create changes...');
      if (!batchChangesStarted) {
        console.log('Starting batch changes from waitForCatchupToComplete...');
        startBatchChanges();
      }
      catchupHandled = true;
      return;
    }
    
    console.log('(Waiting up to 30 seconds for catchup to complete)');
    
    // Create a promise that resolves when catchup completes or times out
    return new Promise<void>((resolve) => {
      // Function to handle when catchup completes
      const handleCatchupComplete = () => {
        // Only execute this once
        if (catchupHandled) {
          console.log('Catchup already handled, ignoring duplicate completion');
          return;
        }
        
        console.log('✅ Catchup synchronization completed successfully.');
        clearTimeout(timeoutId);
        catchupHandled = true;
        
        // Start batch changes if they haven't been started yet
        if (!batchChangesStarted) {
          console.log('Starting batch changes from handleCatchupComplete...');
          startBatchChanges();
        }
        
        resolve();
      };
      
      // Flag to track if timeout was triggered
      let catchupTimeoutTriggered = false;
      
      // Set up a timeout for catchup
      const timeoutId = setTimeout(() => {
        catchupTimeoutTriggered = true;
        console.warn('⚠️ Catchup did not complete within timeout. Proceeding with test anyway.');
        
        // Only start batch changes if they haven't been started yet
        if (!batchChangesStarted && !catchupHandled) {
          console.log('Starting batch changes after timeout...');
          startBatchChanges();
        }
        
        catchupHandled = true;
        resolve();
      }, 30000);
      
      // If catchup is already complete, resolve immediately
      if (catchupCompleted) {
        handleCatchupComplete();
      }
      
      // Set a flag on the message handler to notify when catchup completes
      const originalOnMessage = tester.onMessage;
      tester.onMessage = async (message: any) => {
        // Call the original handler
        if (originalOnMessage) {
          await originalOnMessage(message);
        }
        
        // Check if catchup completed during message processing
        if (catchupCompleted && !catchupTimeoutTriggered && !catchupHandled) {
          handleCatchupComplete();
        }
      };
    });
  }
  
  // Helper function to safely start batch changes exactly once
  function startBatchChanges() {
    if (batchChangesStarted) {
      console.log('Batch changes already started, ignoring duplicate call');
      return;
    }
    
    console.log('🚀 ACTUALLY STARTING BATCH CHANGES NOW');
    batchChangesStarted = true;
    runBatchedChanges();
  }
  
  // Function to create changes in batches
  async function runBatchedChanges() {
    console.log(`\nStarting ${testConfig.testMode} change creation...`);
    
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
    
    // Set a 120 second timeout for receiving all changes
    console.log(`Setting 120 second timeout to receive all changes...`);
    setTimeout(() => {
      if (!stats.changeTracker.allChangesReceived) {
        console.warn(`⚠️ Not all changes were received within timeout`);
        console.log(`Created ${stats.changeTracker.totalChangesCreated} changes, received ${stats.totalChangesReceived}`);
        
        // Complete the test even though not all changes were received
        stats.testCompletedSuccessfully = false;
        resolveTestFinished();
      }
    }, 120000); // Increased timeout to 120 seconds
  }
  
  // Connect to the server with the current LSN and client ID
  console.log('Connecting to server with current LSN...');
  await tester.connect(currentLSN, savedClientId);
  
  // If we don't have a client ID yet, get it from the tester
  if (!stats.clientId) {
    stats.clientId = tester.getClientId();
    console.log(`New client ID assigned: ${stats.clientId}`);
  }
  
  // Wait for catchup to complete before proceeding
  await waitForCatchupToComplete();
  
  // Set up heartbeat interval to keep the connection alive
  const heartbeatInterval = setInterval(() => {
    if (!stats.changeTracker.allChangesReceived) {
      try {
        tester.sendMessage({
          type: 'clt_heartbeat',
          messageId: `hb_${Date.now()}`,
          timestamp: Date.now(),
          clientId: stats.clientId || tester.getClientId()
        });
        console.log('Heartbeat sent to server');
      } catch (error) {
        console.warn('Failed to send heartbeat:', error);
      }
    } else {
      // Clear the interval when test is complete
      clearInterval(heartbeatInterval);
    }
  }, 10000);
  
  // Wait for the test to complete
  await testFinished;
  
  // Give some extra time for final messages to arrive
  console.log('Test completed. Waiting for final messages...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Close the connection
  await tester.disconnect();
  
  // Analyze results
  console.log('\nMessage Analysis Summary:');
  console.log(`- Total messages received: ${stats.totalMessages}`);
  console.log(`- Catchup: ${stats.catchupMessages} messages, ${stats.catchupChunksReceived} chunks received, ${stats.catchupChunksAcknowledged} chunks acknowledged`);
  console.log(`- Found ${stats.changesMessages} changes messages with ${stats.totalChangesReceived} total changes`);
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
  console.log(`Test mode: ${testConfig.testMode}`);
  console.log(`Starting LSN: ${currentLSN}`);
  console.log(`Final LSN: ${stats.finalLSN}`);
  console.log(`Client ID: ${stats.clientId}`);
  console.log(`Total changes created: ${stats.changeTracker.totalChangesCreated}`);
  console.log(`Total changes received: ${stats.totalChangesReceived}`);
  
  // Find missing changes for the summary
  const allExpectedChanges = new Set<string>();
  const allReceivedChanges = new Set<string>();
  
  // Collect all expected changes
  Object.entries(stats.changeTracker.pendingChanges).forEach(([entityType, entityChanges]) => {
    entityChanges.created.forEach(id => allExpectedChanges.add(id));
    entityChanges.updated.forEach(id => allExpectedChanges.add(id));
    entityChanges.deleted.forEach(id => allExpectedChanges.add(id));
  });
  
  // Collect all received changes
  Object.keys(stats.changeTracker.receivedChanges).forEach(id => {
    allReceivedChanges.add(id);
  });
  
  // Find missing changes
  const missingChanges = Array.from(allExpectedChanges).filter(id => !allReceivedChanges.has(id));
  
  if (missingChanges.length > 0) {
    console.log('\nMissing Changes Summary:');
    console.log('------------------------');
    console.log(`Total missing changes: ${missingChanges.length}`);
    
    // Group missing changes by entity type and change type
    const missingByType: {[key: string]: {created: string[], updated: string[], deleted: string[]}} = {};
    
    missingChanges.forEach(id => {
      Object.entries(stats.changeTracker.pendingChanges).forEach(([entityType, changes]) => {
        if (!missingByType[entityType]) {
          missingByType[entityType] = { created: [], updated: [], deleted: [] };
        }
        
        if (changes.created.includes(id)) {
          missingByType[entityType].created.push(id);
        }
        if (changes.updated.includes(id)) {
          missingByType[entityType].updated.push(id);
        }
        if (changes.deleted.includes(id)) {
          missingByType[entityType].deleted.push(id);
        }
      });
    });
    
    // Print missing changes by type
    Object.entries(missingByType).forEach(([entityType, changes]) => {
      console.log(`\n${entityType}:`);
      if (changes.created.length > 0) {
        console.log(`  Created: ${changes.created.length} changes`);
        changes.created.forEach(id => console.log(`    - ${id}`));
      }
      if (changes.updated.length > 0) {
        console.log(`  Updated: ${changes.updated.length} changes`);
        changes.updated.forEach(id => console.log(`    - ${id}`));
      }
      if (changes.deleted.length > 0) {
        console.log(`  Deleted: ${changes.deleted.length} changes`);
        changes.deleted.forEach(id => console.log(`    - ${id}`));
      }
    });
  }
  
  // Success criteria
  const lsnAdvanced = compareLSN(stats.finalLSN, currentLSN) > 0;
  const receivedAllChanges = stats.totalChangesReceived >= stats.changeTracker.totalChangesCreated;
  const catchupHandledCorrectly = stats.catchupChunksReceived === stats.catchupChunksAcknowledged;
  
  console.log('\nTest Results:');
  console.log('-------------');
  console.log(`LSN status: ${lsnAdvanced ? 'Advanced' : 'No change'} from ${currentLSN} to ${stats.finalLSN} (may not change with small number of changes)`);
  console.log(`Success: ${catchupHandledCorrectly ? 'Catchup handled correctly' : 'Catchup acknowledgment mismatch'}`);
  console.log(`Success: ${changesReceived ? 'Received changes during live sync' : 'No changes received'}`);
  console.log(`Success: ${receivedAllChanges ? `Received all ${stats.changeTracker.totalChangesCreated} created changes` : `Missing ${missingChanges.length} changes (received ${stats.totalChangesReceived}/${stats.changeTracker.totalChangesCreated})`}`);
  console.log(`Success: ${stats.testCompletedSuccessfully ? 'Test completed all changes' : 'Timed out before receiving all changes'}`);
  
  // Overall test success - factors in catchup handling and live notifications
  const testSucceeded = (catchupHandledCorrectly || stats.catchupMessages === 0) && 
                         (changesReceived || stats.totalChangesReceived > 0) && 
                         receivedAllChanges && 
                         stats.testCompletedSuccessfully;
                         
  console.log(`\nOverall Test Result: ${testSucceeded ? 'SUCCESS ✅' : 'FAILURE ❌'}`);
  
  console.log('Closing database connection...');
  // Don't actually need to close neon client
  console.log('Database connection closed');
  
  console.log('Test completed, checking results...');
  return testSucceeded ? 0 : 1; // Return non-zero exit code if test failed
}

/**
 * Display an interactive menu to select test mode and configuration
 */
async function showTestMenu(): Promise<{
  testMode: TestMode;
  batchSize?: number;
  distribution?: {[key: string]: number};
}> {
  console.log('\n========================================');
  console.log('🔄 Live Sync Test Configuration');
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
  let distribution: {[key: string]: number} = { task: 0.5, project: 0.2, user: 0.2, comment: 0.1 };
  
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
      const customDistribution: {[key: string]: number} = {};
      for (const [key, val] of Object.entries(distributionAnswer)) {
        customDistribution[key] = Number(val) / total;
      }
      
      console.log('\nNormalized distribution:');
      Object.entries(customDistribution).forEach(([key, val]) => {
        console.log(`- ${key}: ${(val * 100).toFixed(1)}%`);
      });
      
      distribution = customDistribution;
    }
  }
  
  return {
    testMode: mode as TestMode,
    batchSize,
    distribution: distribution
  };
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
      
      // Create a batch of mixed changes
      const results = await createMixedChanges(sql, tracker.batchSize, tracker.changeDistribution);
      
      // Process results and update tracker
      let totalChangesInBatch = 0;
      
      // First, update tracker with all created changes
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
      
      // Then add one duplicate change for the first entity type
      const firstEntityType = Object.keys(results)[0] as keyof typeof results;
      const firstEntityChanges = results[firstEntityType];
      if (firstEntityType && firstEntityChanges && firstEntityChanges.created && firstEntityChanges.created.length > 0) {
        const duplicateId = firstEntityChanges.created[0];
        console.log(`- Adding duplicate update for ${firstEntityType} ${duplicateId}`);
        await createServerChange(sql, Task, 'update');
        tracker.pendingChanges[firstEntityType].updated.push(duplicateId);
        totalChangesInBatch++;
      }
      
      // Update batch and change counts
      tracker.batchesCreated++;
      tracker.totalChangesCreated += totalChangesInBatch;
      
      console.timeEnd('batch-creation');
      console.log(`Successfully created batch ${tracker.batchesCreated} with ${totalChangesInBatch} changes`);
      console.log(`Total changes created so far: ${tracker.totalChangesCreated}`);
      
      // Log the current state of pending changes
      console.log('\nCurrent pending changes:');
      Object.entries(tracker.pendingChanges).forEach(([entityType, changes]) => {
        console.log(`${entityType}:`);
        console.log(`  Created: ${changes.created.length}`);
        console.log(`  Updated: ${changes.updated.length}`);
        console.log(`  Deleted: ${changes.deleted.length}`);
      });
      
      return totalChangesInBatch > 0;
    }
  } catch (error) {
    console.error('Error creating changes:', error);
    return false;
  }
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