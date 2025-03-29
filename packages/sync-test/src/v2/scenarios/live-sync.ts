// Load environment variables
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Determine the correct path to .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Go up 3 directories: /scenarios -> /v2 -> /src -> /sync-test (root)
const rootDir = resolve(__dirname, '../../../');
// Load the environment variables
dotenv.config({ path: resolve(rootDir, '.env') });

import { DB_TABLES, TEST_DEFAULTS, API_CONFIG } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { ScenarioRunner, Scenario, DbAction, WSAction, ApiAction, InteractiveAction, CompositeAction, OperationContext } from '../core/scenario-runner.ts';

// Logger for this module
const logger = createLogger('live-sync');

// Log environment status
logger.info(`Loaded environment from ${resolve(rootDir, '.env')}`);
logger.info(`Database URL configured: ${process.env.DATABASE_URL ? 'Yes' : 'No'}`);
logger.info(`API URL configured: ${process.env.API_URL ? 'Yes' : 'No'}`);
logger.info(`WebSocket URL configured: ${process.env.WS_URL ? 'Yes' : 'No'}`);

// Define our live sync test scenario
const liveSyncScenario: Scenario = {
  name: 'Live Sync Test',
  description: 'Tests the live sync capability with multiple clients',
  config: {
    timeout: 30000,
    changeCount: 5,
    customProperties: {
      clientCount: 1
    }
  },
  
  // Test steps define the flow of the test
  steps: [
    // Step 1: Initialize Database
    {
      name: 'Initialize Database',
      execution: 'serial',
      actions: [
        {
          type: 'db',
          name: 'Initialize Database Connection',
          operation: 'initializeDatabase'
        } as DbAction
      ]
    },
    
    // Step 2: Initialize Replication
    {
      name: 'Initialize Replication',
      execution: 'serial',
      actions: [
        {
          type: 'db',
          name: 'Initialize Database Replication Slot',
          operation: 'initializeReplication'
        } as DbAction,
        {
          type: 'api',
          name: 'Initialize Server Replication via API',
          method: 'POST',
          endpoint: API_CONFIG.REPLICATION_INIT,
          body: { action: 'initialize' }
        } as ApiAction
      ]
    },
    
    // Step 3: Create WebSocket Clients
    {
      name: 'Create WebSocket Clients',
      execution: 'serial',
      actions: [
        {
          type: 'db',
          name: 'Create Client Storage',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const customProperties = context.config.customProperties || {};
            const clientCount = customProperties.clientCount || 1;
            context.logger.info(`Creating ${clientCount} WebSocket clients`);
            
            // Initialize clients array
            context.state.clients = [];
            
            // Create clients sequentially
            for (let i = 0; i < clientCount; i++) {
              const profileId = i + 1;
              try {
                const clientId = await operations.ws.createClient(profileId);
                context.state.clients.push(clientId);
                context.logger.info(`Created client ${i+1}/${clientCount}: ${clientId} with profile ID ${profileId}`);
              } catch (err) {
                context.logger.error(`Failed to create client ${i+1}: ${err}`);
                throw err;
              }
            }
            
            context.logger.info(`Successfully created ${context.state.clients.length} clients`);
          }
        } as DbAction
      ]
    },
    
    // Step 4: Set up all clients and connect to WebSocket
    {
      name: 'Set Up Clients',
      execution: 'serial',
      actions: [
        {
          type: 'db',
          name: 'Setup All WebSocket Clients',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const clients = context.state.clients || [];
            context.logger.info(`Setting up ${clients.length} WebSocket clients`);
            
            // Set up clients in parallel using promises
            const setupPromises = clients.map(async (clientId: string, index: number) => {
              try {
                await operations.ws.setupClient(clientId);
                context.logger.info(`Client ${index+1}/${clients.length} setup complete: ${clientId}`);
              } catch (err) {
                context.logger.error(`Failed to setup client ${clientId}: ${err}`);
                throw err;
              }
            });
            
            await Promise.all(setupPromises);
            context.logger.info('All clients successfully set up and connected');
            
            return clients.length;
          }
        } as DbAction
      ]
    },
    
    // Step 5: Create database changes
    {
      name: 'Create Changes',
      execution: 'serial',
      actions: [
        {
          type: 'db',
          name: 'Create Database Changes',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const changeCount = context.config.changeCount || 3;
            context.logger.info(`Creating ${changeCount} database changes`);
            
            // Use the direct db operation
            const changes = await operations.db.createChangeBatch(
              changeCount,
              TEST_DEFAULTS.ENTITY_TYPES
            );
            
            context.logger.info(`Successfully created ${changes.length} database changes`);
            context.state.createdChanges = changes;
            return changes;
          }
        } as DbAction
      ]
    },
    
    // Step 6: Wait for changes to arrive on all clients
    {
      name: 'Wait for Changes on All Clients',
      execution: 'serial',
      actions: [
        {
          type: 'db',
          name: 'Wait for Change Messages on All Clients',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const clients = context.state.clients || [];
            const expectedChanges = context.config.changeCount || 3;
            const totalExpectedChanges = clients.length * expectedChanges;
            
            context.logger.info(`Waiting for ${expectedChanges} changes on each of ${clients.length} clients (total: ${totalExpectedChanges})`);
            
            // Initialize tracking
            context.state.clientChanges = {};
            clients.forEach((clientId: string) => {
              context.state.clientChanges[clientId] = 0;
            });
            
            // Set up message handlers for all clients
            const messagePromises = clients.map((clientId: string) => {
              return new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                  // Remove the handler to avoid memory leaks
                  operations.ws.removeMessageHandler(clientId, messageHandler);
                  reject(new Error(`Timeout waiting for changes on client ${clientId}`));
                }, 30000);
                
                const messageHandler = (message: any) => {
                  // Handle live changes
                  if (message.type === 'srv_live_changes') {
                    const newChanges = message.changes?.length || 0;
                    context.state.clientChanges[clientId] = (context.state.clientChanges[clientId] || 0) + newChanges;
                    
                    context.logger.info(`Client ${clientId} received ${newChanges} changes (total: ${context.state.clientChanges[clientId]}/${expectedChanges})`);
                    
                    // Send catchup acknowledgment 
                    operations.ws.sendMessage(clientId, {
                      type: 'clt_catchup_received',
                      lsn: message.lsn || '0/0',
                      timestamp: Date.now()
                    });
                    
                    // If this client has received all expected changes, resolve its promise
                    if (context.state.clientChanges[clientId] >= expectedChanges) {
                      clearTimeout(timeout);
                      operations.ws.removeMessageHandler(clientId, messageHandler);
                      resolve();
                    }
                  }
                };
                
                // Add the message handler
                operations.ws.addMessageHandler(clientId, messageHandler);
              });
            });
            
            try {
              // Wait for all clients to receive their changes
              await Promise.all(messagePromises);
              context.logger.info('All clients have received all expected changes!');
            } catch (error) {
              // Clean up any remaining handlers
              clients.forEach((clientId: string) => {
                try {
                  operations.ws.removeAllMessageHandlers(clientId);
                } catch (e) {
                  // Ignore cleanup errors
                }
              });
              
              throw error;
            }
            
            return context.state.clientChanges;
          }
        } as DbAction
      ]
    },
    
    // Step 7: Disconnect all clients
    {
      name: 'Disconnect Clients',
      execution: 'serial',
      actions: [
        {
          type: 'db',
          name: 'Disconnect All WebSocket Clients',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const clients = context.state.clients || [];
            context.logger.info(`Disconnecting ${clients.length} WebSocket clients`);
            
            // Disconnect clients with timeout protection
            const disconnectWithTimeout = async (clientId: string, index: number) => {
              return new Promise<boolean>((resolve) => {
                // Set timeout to avoid hanging
                const timeout = setTimeout(() => {
                  context.logger.warn(`Timeout disconnecting client ${clientId}, forcing cleanup`);
                  resolve(false);
                }, 5000);
                
                operations.ws.disconnectClient(clientId)
                  .then(() => {
                    clearTimeout(timeout);
                    context.logger.info(`Client ${index+1}/${clients.length} disconnected: ${clientId}`);
                    resolve(true);
                  })
                  .catch((err: Error) => {
                    clearTimeout(timeout);
                    context.logger.error(`Failed to disconnect client ${clientId}: ${err}`);
                    resolve(false);
                  });
              });
            };
            
            try {
              await Promise.all(clients.map((clientId: string, index: number) => disconnectWithTimeout(clientId, index)));
            } catch (error) {
              context.logger.error(`Error during disconnection: ${error}`);
            }
            
            // Force cleanup of any remaining clients
            for (const clientId of clients) {
              try {
                operations.ws.removeAllMessageHandlers(clientId);
              } catch (e) {
                // Ignore cleanup errors
              }
            }
            
            context.logger.info('Client disconnection complete');
            
            // Force exit after a short delay if the process is still running
            setTimeout(() => {
              context.logger.info('Force exiting process');
              process.exit(0);
            }, 1000);
            
            return clients.length;
          }
        } as DbAction
      ]
    }
  ],
  
  // Optional hooks for additional functionality
  hooks: {
    // Run before the scenario starts
    beforeScenario: async (context) => {
      context.state.clients = [];
      context.state.clientChanges = {};
      
      // Set client count from config
      const clientCount = context.config.customProperties?.clientCount || 1;
      context.logger.info(`Live sync test initialized with ${clientCount} clients`);
    },
    
    // Run before each step
    beforeStep: async (step, context) => {
      context.logger.info(`Starting step: ${step.name}`);
    },
    
    // Run after each step
    afterStep: async (step, context) => {
      context.logger.info(`Completed step: ${step.name}`);
    },
    
    // Run after the scenario completes
    afterScenario: async (context) => {
      const clientCount = context.state.clients?.length || 0;
      const expectedChangesPerClient = context.config.changeCount;
      
      // Calculate test success for each client
      const clientResults = [];
      let overallSuccess = true;
      
      if (context.state.clientChanges) {
        for (const clientId of context.state.clients) {
          const changesReceived = context.state.clientChanges[clientId] || 0;
          const success = changesReceived >= expectedChangesPerClient;
          
          clientResults.push({
            clientId,
            success,
            changesReceived,
            expectedChanges: expectedChangesPerClient,
            finalLSN: 'unknown'
          });
          
          if (!success) overallSuccess = false;
        }
      }
      
      // Log results
      if (overallSuccess) {
        context.logger.info('✅ Live sync test completed successfully on all clients!');
      } else {
        context.logger.info('❌ Live sync test failed on one or more clients!');
      }
      
      // Log results for each client
      clientResults.forEach(result => {
        context.logger.info(
          `Client ${result.clientId}: ${result.success ? '✅' : '❌'} ` +
          `Received ${result.changesReceived}/${result.expectedChanges} changes. ` +
          `Final LSN: ${result.finalLSN}`
        );
      });
      
      // Store results in state for return
      context.state.results = clientResults;
    }
  }
};

/**
 * Run a live sync test with multiple clients
 * @param clientCount Number of clients to run in parallel
 * @param changeCount Number of changes to create per client
 */
export async function runLiveSyncTest(clientCount: number = 1, changeCount: number = 10): Promise<any[]> {
  logger.info(`Starting live sync test with ${clientCount} clients and ${changeCount} changes`);
  
  // Configure the scenario
  const scenario = { ...liveSyncScenario };
  scenario.config.changeCount = changeCount;
  scenario.config.customProperties = { clientCount };
  
  // Create and run the scenario
  const runner = new ScenarioRunner();
  
  try {
    // Create a state object to capture results
    const state: Record<string, any> = {};
    
    // Modify the scenario's afterScenario hook to capture results
    const originalAfterScenario = scenario.hooks?.afterScenario;
    if (scenario.hooks && originalAfterScenario) {
      scenario.hooks.afterScenario = async (context) => {
        // Run the original hook
        await originalAfterScenario(context);
        
        // Capture the results
        state.results = context.state.results;
      };
    }
    
    // Run the scenario
    await runner.runScenario(scenario);
    
    // Return the results stored in state
    return state.results || [{ success: true }];
  } catch (error) {
    logger.error(`Test failed: ${error instanceof Error ? error.message : String(error)}`);
    return [{ success: false, error: String(error) }];
  }
}

// If run directly
if (typeof import.meta !== 'undefined' && 
    import.meta.url && 
    (import.meta.url.endsWith('live-sync.ts') || import.meta.url.includes('live-sync.ts'))) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const clientCount = parseInt(args[0] || '1', 10);
  const changeCount = parseInt(args[1] || '5', 10);
  
  runLiveSyncTest(clientCount, changeCount)
    .then(results => {
      // Check if any test failed
      const anyFailed = results.some(result => !result.success);
      
      // Log summary
      if (!anyFailed) {
        logger.info('✅ Live sync test completed successfully!');
      } else {
        logger.error('❌ Live sync test failed!');
      }
      
      // Exit the process with appropriate code
      process.exit(anyFailed ? 1 : 0);
    })
    .catch(error => {
      console.error('Test failed:', error);
      process.exit(1);
    });
} 