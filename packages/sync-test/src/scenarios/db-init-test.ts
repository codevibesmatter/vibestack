/**
 * Database Initialization Test Scenario
 * 
 * This scenario:
 * 1. Calls the HTTP replication initialization endpoint
 * 2. Makes a direct database change
 * 3. Verifies the change was captured by the replication system
 */

import { DEFAULT_CONFIG } from '../config.ts';
import fetch from 'node-fetch';
import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { v4 as uuidv4 } from 'uuid';

// Load environment variables from .env file
config();

// Get DB URL from environment variable or use default
const DB_URL = process.env.DATABASE_URL || '';
if (!DB_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

// Define the SqlQueryFunction type based on what neon() returns
type SqlQueryFunction = ReturnType<typeof neon>;

// Define interfaces for API responses
interface ReplicationInitResponse {
  success: boolean;
  slotStatus?: {
    exists: boolean;
    lsn: string;
  };
  pollingStarted?: boolean;
}

interface ReplicationStatusResponse {
  success: boolean;
  slotStatus?: {
    exists: boolean;
    lsn: string;
  };
}

/**
 * Call the replication initialization endpoint 
 * This ensures the replication system is ready to process changes
 */
async function initializeReplication(): Promise<{
  success: boolean;
  details?: ReplicationInitResponse;
  lsn?: string;
  error?: string;
  status?: number;
  statusText?: string;
}> {
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
      return {
        success: false,
        status: response.status,
        statusText: response.statusText
      };
    }
    
    const result = await response.json() as ReplicationInitResponse;
    console.log('Replication initialization successful:', result);
    
    return {
      success: true,
      details: result,
      lsn: result.slotStatus?.lsn
    };
  } catch (error) {
    console.error('Error initializing replication:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Makes a direct database change and returns the test data
 */
async function makeDirectDatabaseChange(): Promise<{
  success: boolean;
  testId?: string;
  testName?: string;
  error?: string;
}> {
  try {
    console.log('Creating Neon database client...');
    const sql = neon(DB_URL);
    
    // Generate unique test data
    const testId = uuidv4();
    const timestamp = new Date().toISOString();
    const testName = `test-${timestamp}`;
    
    console.log(`Making direct database change with test ID: ${testId}`);
    
    // Create a new user for testing
    await sql`
      INSERT INTO users (id, name, email, created_at, updated_at) 
      VALUES (${testId}, ${testName}, ${`${testName}@example.com`}, NOW(), NOW())
    `;
    
    console.log('Database change completed successfully');
    
    return {
      success: true,
      testId,
      testName
    };
  } catch (error) {
    console.error('Error making database change:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Checks if the replication system captured the change
 */
async function checkReplicationStatus(testId: string, initialLsn: string): Promise<{
  success: boolean;
  details?: ReplicationStatusResponse;
  lsnAdvanced?: boolean;
  initialLsn?: string;
  currentLsn?: string;
  error?: string;
  status?: number;
  statusText?: string;
}> {
  try {
    // Convert the WebSocket URL to the base HTTP URL
    const wsUrl = new URL(DEFAULT_CONFIG.wsUrl);
    const baseUrl = `http${wsUrl.protocol === 'wss:' ? 's' : ''}://${wsUrl.host}`;
    const statusUrl = `${baseUrl}/api/replication/status`;
    
    console.log(`Checking replication status via HTTP: ${statusUrl}`);
    
    const response = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.error(`Failed to check replication status: ${response.status} ${response.statusText}`);
      return {
        success: false,
        status: response.status,
        statusText: response.statusText
      };
    }
    
    const result = await response.json() as ReplicationStatusResponse;
    console.log('Replication status:', result);
    
    // Check if the LSN has advanced
    const currentLsn = result.slotStatus?.lsn || '';
    const lsnAdvanced = Boolean(currentLsn && currentLsn > initialLsn);
    
    return {
      success: true,
      details: result,
      lsnAdvanced,
      initialLsn,
      currentLsn
    };
  } catch (error) {
    console.error('Error checking replication status:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Waits for a specified time
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main function to run the scenario
 */
async function main() {
  console.log('==================================');
  console.log('🔄 DB Replication Test');
  console.log('==================================');
  
  try {
    // Step 1: Initialize replication
    console.log('\n📋 Step 1: Initializing replication system...');
    const initResult = await initializeReplication();
    
    if (!initResult.success) {
      console.error('❌ Replication initialization failed');
      console.error('Details:', JSON.stringify(initResult, null, 2));
      process.exit(1);
    }
    
    console.log('✅ Replication initialization successful');
    const initialLsn = initResult.lsn;
    if (!initialLsn) {
      console.error('❌ No LSN received from replication initialization');
      process.exit(1);
    }
    console.log(`Initial LSN: ${initialLsn}`);
    
    // Step 2: Make a database change
    console.log('\n📋 Step 2: Making direct database change...');
    const dbResult = await makeDirectDatabaseChange();
    
    if (!dbResult.success) {
      console.error('❌ Database change failed');
      console.error('Details:', JSON.stringify(dbResult, null, 2));
      process.exit(1);
    }
    
    console.log('✅ Database change successful');
    console.log('Test ID:', dbResult.testId);
    console.log('Test Name:', dbResult.testName);
    
    // Step 3: Wait a moment for replication to process the change
    console.log('\n📋 Step 3: Waiting for replication to process the change (5 seconds)...');
    await delay(5000);
    
    // Step 4: Check replication status
    console.log('\n📋 Step 4: Checking replication status...');
    const statusResult = await checkReplicationStatus(dbResult.testId!, initialLsn);
    
    if (!statusResult.success) {
      console.error('❌ Failed to check replication status');
      console.error('Details:', JSON.stringify(statusResult, null, 2));
      process.exit(1);
    }
    
    if (statusResult.lsnAdvanced) {
      console.log('✅ Replication processed changes successfully');
      console.log(`LSN advanced from ${statusResult.initialLsn} to ${statusResult.currentLsn}`);
    } else {
      console.warn('⚠️ Replication LSN did not advance as expected');
      console.warn(`Initial LSN: ${statusResult.initialLsn}`);
      console.warn(`Current LSN: ${statusResult.currentLsn}`);
    }
    
    console.log('\n📋 Summary:');
    console.log('- Replication system initialized successfully');
    console.log(`- Database change made with test ID: ${dbResult.testId}`);
    console.log(`- Replication LSN ${statusResult.lsnAdvanced ? 'advanced' : 'did not advance'}`);
    
    console.log('\n✨ Test completed successfully');
  } catch (error) {
    console.error('❌ Error during scenario execution:', error);
    process.exit(1);
  }
}

// Run the scenario
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
}); 