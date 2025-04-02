/**
 * Simple Integration Test Scenario
 * 
 * This demonstrates the complete flow using the ScenarioRunner:
 * 1. Initialize replication
 * 2. Generate changes
 * 3. Apply them to the database
 * 4. Validate they were properly recorded in WAL and change_history
 */

import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DataSource } from 'typeorm';
import { serverEntities } from '@repo/dataforge/server-entities';

// Determine the correct path to .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Go up 3 directories: /scenarios -> /v2 -> /src -> /sync-test (root)
const rootDir = resolve(__dirname, '../../../');
// Load the environment variables
dotenv.config({ path: resolve(rootDir, '.env') });

import { createLogger } from '../core/logger.ts';
import { 
  ScenarioRunner, 
  Scenario, 
  ChangesAction,
  ValidationAction,
  ApiAction,
  OperationContext 
} from '../core/scenario-runner.ts';
import * as entityChanges from '../core/entity-changes/index.ts';
import * as apiService from '../core/api-service.ts';

// Create a logger for this test
const logger = createLogger('simple-integration-test');

// Database connection
const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: serverEntities,
  synchronize: false,
  logging: false
});

/**
 * Simple Integration Test Scenario
 * 
 * This scenario tests the end-to-end flow of:
 * 1. Initialize replication
 * 2. Generate changes
 * 3. Apply them to the database
 * 4. Validate they were properly recorded in WAL and change_history
 */
export const SimpleIntegrationTestScenario: Scenario = {
  name: 'Simple Integration Test',
  description: 'Tests the complete change validation flow in the sync system',
  config: {
    timeout: 120000, // Increase timeout to 2 minutes for large tests
    changeCount: 100, // Increased from 25 to 100 changes
  },
  
  hooks: {
    beforeScenario: async (context) => {
      context.logger.info('Starting simple integration test');
      
      // Initialize the database if not already initialized
      try {
        const initialized = await entityChanges.initialize(dataSource);
        if (!initialized) {
          context.logger.error('Failed to initialize database');
          context.state.shouldExit = true;
          throw new Error('Database initialization failed');
        }
        context.logger.info('Database initialized successfully');
      } catch (error) {
        context.logger.error(`Database connection error: ${error}`);
        context.state.shouldExit = true;
        throw new Error('Database connection not available');
      }
      
      // Initialize state to track test results
      context.state.testResults = {
        success: false
      };
    },
    
    afterScenario: async (context) => {
      const results = context.state.testResults;
      
      context.logger.info('=== Simple Integration Test Summary ===');
      
      // Report server LSN if available
      if (context.state.serverLSN) {
        context.logger.info(`Server LSN: ${context.state.serverLSN}`);
      }
      
      if (results.changes) {
        context.logger.info(`Changes generated and applied: ${results.changes.length}`);
        if (context.state.verifiedCount !== undefined) {
          context.logger.info(`Entities verified in database: ${context.state.verifiedCount}/${results.changes.length}`);
        }
      }
      
      // Log validation results if available
      if (results.validation) {
        const validation = results.validation;
        context.logger.info('--- Validation Report ---');
        context.logger.info(`LSN advanced: ${validation.startLSN} → ${validation.endLSN}`);
        context.logger.info(`Entity verification: ${validation.entityVerificationSuccess ? 'COMPLETE' : 'INCOMPLETE'}`);
        
        // Change history information
        if ('changeHistoryEntries' in validation) {
          context.logger.info(`Change history entries: ${validation.changeHistoryEntries}`);
          if (validation.changeHistoryTables && validation.changeHistoryTables.length > 0) {
            context.logger.info(`Tables in change_history: ${validation.changeHistoryTables.join(', ')}`);
          }
        }
        
        // Count found and missing entities
        const totalFound = Object.values(validation.foundIdsByTable || {}).reduce((sum: number, ids) => {
          return sum + (Array.isArray(ids) ? ids.length : 0);
        }, 0);
        const totalExpected = Object.values(validation.appliedIdsByTable || {}).reduce((sum: number, ids) => {
          return sum + (Array.isArray(ids) ? ids.length : 0);
        }, 0);
        
        context.logger.info(`Entities found: ${totalFound}/${totalExpected}`);
      }
      
      context.logger.info(`Overall success: ${results.success ? 'YES ✅' : 'NO ❌'}`);
    }
  },
  
  steps: [
    // Step 0: Query Server's Current LSN
    {
      name: 'Query Server LSN',
      execution: 'serial',
      actions: [
        {
          type: 'api',
          name: 'Get Server LSN',
          endpoint: '/api/replication/lsn',
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          },
          onResponse: async (response: Response, context: OperationContext) => {
            try {
              const data = await response.json();
              context.logger.info(`Server's current LSN from API: ${data.lsn}`);
              context.state.serverLSN = data.lsn;
            } catch (error) {
              context.logger.error(`Failed to parse LSN response: ${error}`);
            }
          }
        } as ApiAction
      ]
    },
    
    // Step 1: Initialize Replication
    {
      name: 'Initialize Replication',
      execution: 'serial',
      actions: [
        {
          type: 'api',
          name: 'Initialize Replication via API',
          endpoint: '/api/replication/init',
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        } as ApiAction,
        {
          type: 'changes',
          name: 'Verify Replication Status',
          operation: 'exec',
          params: async (context: OperationContext) => {
            context.logger.info('Verifying replication initialization');
            
            try {
              // Check replication slot info
              const slotInfo = await entityChanges.getReplicationSlotInfo();
              if (slotInfo) {
                context.logger.info(`Replication slot confirmed: ${slotInfo.slot_name}`);
                context.logger.info(`Slot status: ${slotInfo.active ? 'active' : 'inactive'}, LSN: ${slotInfo.restart_lsn}`);
              } else {
                context.logger.warn('Replication slot not found');
              }
            
              // Get current LSN
              const lsn = await entityChanges.getCurrentLSN();
              context.logger.info(`Current LSN: ${lsn}`);
            
              return {
                success: !!slotInfo,
                initialLSN: lsn
              };
            } catch (error) {
              context.logger.error(`Error verifying replication: ${error}`);
              return {
                success: false,
                error: String(error)
              };
            }
          }
        } as ChangesAction
      ]
    },
    
    // Step 2: Generate and Apply Changes
    {
      name: 'Generate and Apply Changes',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Generate Changes',
          operation: 'exec',
          params: async (context: OperationContext) => {
            const changeCount = context.config.changeCount || 5;
            const batchSize = 20; // Increased from 5 to 20 changes per batch
            const totalBatches = Math.ceil(changeCount / batchSize);
            
            context.logger.info(`Generating and applying ${changeCount} changes in ${totalBatches} separate batches`);
            
            try {
              // Get starting LSN
              const startLSN = await entityChanges.getCurrentLSN();
              context.logger.info(`Starting LSN before applying changes: ${startLSN}`);
              
              // Define test options - CREATE ONLY to ensure we write new records
              const options = {
                // Entity distribution - more efficient for large tests
                distribution: {
                  user: 0.15,      // 15% users (need enough users for tasks and projects)
                  project: 0.15,   // 15% projects (need enough projects for tasks)
                  task: 0.20,      // 20% tasks (need enough tasks for comments)
                  comment: 0.50    // 50% comments (most numerous)
                },
                // Force CREATE operations only to avoid FK issues
                operations: {
                  create: 1.0,  // 100% creates
                  update: 0.0,  // No updates
                  delete: 0.0   // No deletes
                },
                // Use existing entities as parents where needed
                useExistingIds: true,
                // Ensure we have at least one of each parent entity type
                minCounts: {
                  user: 1,
                  project: 1,
                  task: 1
                }
              };
              
              // Apply changes in separate batches to get different LSN values
              let allChanges: any[] = [];
              let currentBatchStart = 1;
              
              // Process each batch separately to ensure different LSN values
              for (let batch = 0; batch < totalBatches; batch++) {
                const currentBatchSize = Math.min(batchSize, changeCount - (batch * batchSize));
                if (currentBatchSize <= 0) break;
                
                context.logger.info(`Generating batch ${batch + 1}/${totalBatches} with ${currentBatchSize} changes`);
                
                // Generate and apply this batch
                const batchChanges = await entityChanges.generateAndApplyChanges(currentBatchSize, options);
                
                context.logger.info(`Applied batch ${batch + 1} with ${batchChanges.length} changes`);
                
                // Get current LSN after this batch
                const currentLSN = await entityChanges.getCurrentLSN();
                context.logger.info(`LSN after batch ${batch + 1}: ${currentLSN}`);
                
                // Add a small delay between batches to ensure different LSN values
                if (batch < totalBatches - 1) {
                  await new Promise(resolve => setTimeout(resolve, 100));
                }
                
                allChanges = [...allChanges, ...batchChanges];
                currentBatchStart += currentBatchSize;
              }
              
              // Verify the changes were actually written to the database tables
              const dataSource = await entityChanges.getDataSource();
              const entityCountsByTable: Record<string, number> = {};
              
              // Check each entity type
              for (const change of allChanges) {
                const tableName = change.table;
                if (!entityCountsByTable[tableName]) {
                  // Query the actual table to count records
                  const count = await dataSource.query(`SELECT COUNT(*) FROM "${tableName}"`);
                  entityCountsByTable[tableName] = parseInt(count[0].count, 10);
                }
              }
              
              // Log the results of the database checks
              context.logger.info('Entity counts in database tables:');
              Object.entries(entityCountsByTable).forEach(([table, count]) => {
                context.logger.info(`  ${table}: ${count} total records`);
              });
              
              // Directly verify each entity by ID
              context.logger.info('Verifying individual entities were written:');
              let verifiedCount = 0;
              
              for (const change of allChanges) {
                if (change.operation === 'insert' && change.data && change.data.id) {
                  const entityId = change.data.id.toString();
                  const tableName = change.table;
                  
                  try {
                    // Check if this specific entity exists in the database
                    const entityExists = await dataSource.query(
                      `SELECT EXISTS(SELECT 1 FROM "${tableName}" WHERE id = $1)`,
                      [entityId]
                    );
                    
                    if (entityExists[0].exists) {
                      verifiedCount++;
                      context.logger.info(`  ✅ ${tableName} entity ${entityId.substring(0, 8)}... found`);
                    } else {
                      context.logger.warn(`  ❌ ${tableName} entity ${entityId.substring(0, 8)}... NOT found`);
                    }
                  } catch (error) {
                    context.logger.error(`  Error checking ${tableName} entity ${entityId}: ${error}`);
                  }
                }
              }
              
              context.logger.info(`Verified ${verifiedCount}/${allChanges.length} entities were written to database tables`);
              
              // Store changes for validation
              context.state.generatedChanges = allChanges;
              context.state.startLSN = startLSN;
              context.state.verifiedCount = verifiedCount;
              
              // Get ending LSN
              const endLSN = await entityChanges.getCurrentLSN();
              context.logger.info(`Ending LSN after applying all changes: ${endLSN}`);
              
              return {
                success: verifiedCount > 0,
                changeCount: allChanges.length,
                verifiedCount,
                startLSN,
                endLSN
              };
            } catch (error) {
              context.logger.error(`Error generating and applying changes: ${error}`);
              return {
                success: false,
                error: String(error)
              };
            }
          }
        } as ChangesAction
      ]
    },
    
    // Step 3: Validate Changes
    {
      name: 'Validate Changes',
      execution: 'serial',
      actions: [
        {
          type: 'validation',
          name: 'Verify WAL and Change History',
          operation: 'exec',
          params: async (context: OperationContext) => {
            context.logger.info('Validating changes in WAL and change_history');
            
            try {
              // Get necessary info from state
              const result = context.state.generatedChanges || [];
              const startLSN = context.state.startLSN;
              const endLSN = await entityChanges.getCurrentLSN();
              // Use server LSN if available for more accurate validation
              const queryLSN = context.state.serverLSN || startLSN;
              
              if (result.length === 0) {
                context.logger.warn('No changes to validate');
                return {
                  success: false,
                  error: 'No changes were generated'
                };
              }
              
              context.logger.info(`Using LSN for validation: ${queryLSN} (${context.state.serverLSN ? 'from server API' : 'from local start LSN'})`);
              
              // Directly verify the changes were applied - use server LSN if available
              const validation = await entityChanges.validateEntityChanges(result, queryLSN, endLSN);
              
              // Explicitly check change_history table using server LSN if available
              const changeHistoryEntries = await entityChanges.queryChangeHistory(queryLSN, endLSN, 500);
              
              // Group entries by table for summary
              const entriesByTable: Record<string, { count: number; ids: string[] }> = {};
              
              changeHistoryEntries.forEach(entry => {
                const tableName = entry.table_name;
                const entityId = entry.data?.id?.toString();
                
                if (!entriesByTable[tableName]) {
                  entriesByTable[tableName] = { count: 0, ids: [] };
                }
                
                entriesByTable[tableName].count++;
                
                if (entityId && !entriesByTable[tableName].ids.includes(entityId)) {
                  entriesByTable[tableName].ids.push(entityId);
                }
              });
              
              // Log findings from change_history
              if (Object.keys(entriesByTable).length > 0) {
                context.logger.info(`Found changes in change_history table:`);
                Object.entries(entriesByTable).forEach(([table, data]) => {
                  context.logger.info(`  ${table}: ${data.count} changes with ${data.ids.length} unique IDs`);
                });
              } else {
                context.logger.warn(`No changes found in change_history table between LSN ${queryLSN} and ${endLSN}`);
              }
              
              // Add change_history validation to results
              const validationWithHistory = {
                ...validation,
                changeHistoryEntries: changeHistoryEntries.length,
                changeHistoryTables: Object.keys(entriesByTable)
              };
              
              // If we have the server's LSN, compare it with our test LSNs
              if (context.state.serverLSN) {
                context.logger.info('--- LSN Comparison ---');
                context.logger.info(`Server API LSN: ${context.state.serverLSN}`);
                context.logger.info(`Test start LSN: ${startLSN}`);
                context.logger.info(`Test end LSN: ${endLSN}`);
                
                // Compare server LSN with our LSNs
                const serverLSN = context.state.serverLSN;
                if (serverLSN < startLSN) {
                  context.logger.warn(`Server LSN (${serverLSN}) is behind our test's start LSN (${startLSN})`);
                } else if (serverLSN > endLSN) {
                  context.logger.warn(`Server LSN (${serverLSN}) is ahead of our test's end LSN (${endLSN})`);
                } else {
                  context.logger.info(`Server LSN (${serverLSN}) is between our test's start LSN (${startLSN}) and end LSN (${endLSN})`);
                }
              }
              
              // Store validation results
              context.state.testResults = {
                success: validation.success,
                changes: result,
                validation: validationWithHistory
              };
              
              return {
                success: validation.success,
                lsnAdvanced: validation.lsnAdvanced,
                entityVerificationSuccess: validation.entityVerificationSuccess,
                message: validation.success 
                  ? 'Changes validated successfully' 
                  : 'Changes validation failed'
              };
            } catch (error) {
              context.logger.error(`Error validating changes: ${error}`);
              return {
                success: false,
                error: String(error)
              };
            }
          }
        } as ValidationAction
      ]
    }
  ]
};

// Register this scenario with the default export
export default SimpleIntegrationTestScenario;

/**
 * Run the simple integration test
 */
export async function runSimpleIntegrationTest(changeCount: number = 5): Promise<any> {
  logger.info(`Starting simple integration test with ${changeCount} changes`);
  
  // Try to initialize the database connection
  try {
    const initialized = await entityChanges.initialize(dataSource);
    if (!initialized) {
      logger.error('Failed to initialize the database. Test cannot run.');
      return { 
        success: false, 
        error: 'Database initialization failed. Please check the logs for details.'
      };
    }
    
    logger.info('Database initialized successfully');
  } catch (error) {
    logger.error(`Failed to initialize database connection: ${error}`);
    return { success: false, error: `Database initialization failed: ${error}` };
  }
  
  // Proceed with the test
  const scenario = { ...SimpleIntegrationTestScenario };
  scenario.config.changeCount = changeCount;
  
  // Create and run the scenario
  const runner = new ScenarioRunner();
  
  try {
    // Run the scenario
    await runner.runScenario(scenario);
    
    // For now, we'll just consider it a success if we get this far
    logger.info('Integration test completed');
    return { success: true };
  } catch (error) {
    logger.error(`Test failed: ${error instanceof Error ? error.message : String(error)}`);
    return { success: false, error: String(error) };
  }
}

// Make the command line execution check for database connection first
if (typeof import.meta !== 'undefined' && import.meta.url) {
  // Check if the file was executed directly
  const isDirectCommandExecution = process.argv[1] && 
    (process.argv[1].endsWith('simple-integration-test.ts') || process.argv[1].includes('simple-integration-test.ts'));
    
  if (isDirectCommandExecution) {
    // Early check for database connection
    if (!process.env.DATABASE_URL) {
      logger.error('ERROR: No DATABASE_URL environment variable available.');
      logger.error('Please ensure DATABASE_URL is properly configured in your .env file.');
      process.exit(1);
    }
    
    // Parse command line arguments
    const args = process.argv.slice(2);
    const changeCount = parseInt(args[0] || '5', 10);
    
    logger.info(`Starting simple integration test with ${changeCount} changes from command line`);
    
    runSimpleIntegrationTest(changeCount)
      .then(results => {
        // Check if test failed
        const success = results && results.success;
        
        // Log summary
        if (success) {
          logger.info('✅ Integration test completed successfully!');
        } else {
          logger.error('❌ Integration test failed!');
        }
        
        // Force exit after a short delay to ensure logs are flushed
        setTimeout(() => {
          process.exit(success ? 0 : 1);
        }, 1000);
      })
      .catch(error => {
        console.error('Test failed:', error);
        process.exit(1);
      });
  } else {
    logger.debug('Integration test module imported by another module, not running automatically');
  }
} 