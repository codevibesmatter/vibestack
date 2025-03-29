/**
 * Init Replication Scenario
 * 
 * This scenario only calls the HTTP replication initialization endpoint
 * without establishing a WebSocket connection. This is useful for:
 * 
 * 1. Testing that the replication system initializes correctly
 * 2. Pre-initializing the replication system before other operations
 * 3. Troubleshooting replication issues separately from WebSocket connectivity
 */

import { DEFAULT_CONFIG } from '../config.ts';
import fetch from 'node-fetch';
import { config } from 'dotenv';

// Load environment variables from .env file
config();

/**
 * Call the replication initialization endpoint 
 * This ensures the replication system is ready to process changes
 */
async function initializeReplication(): Promise<any> {
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
    
    const result = await response.json();
    console.log('Replication initialization successful:', result);
    
    return {
      success: true,
      details: result
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
 * Main function to run the scenario
 */
async function main() {
  console.log('==================================');
  console.log('🔄 Replication Initialization Test');
  console.log('==================================');
  
  try {
    // Attempt to initialize replication
    console.log('Initializing replication system...');
    const result = await initializeReplication();
    
    if (result.success) {
      console.log('✅ Replication initialization successful');
      console.log('Details:', JSON.stringify(result.details, null, 2));
    } else {
      console.error('❌ Replication initialization failed');
      console.error('Details:', JSON.stringify(result, null, 2));
      process.exit(1);
    }
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