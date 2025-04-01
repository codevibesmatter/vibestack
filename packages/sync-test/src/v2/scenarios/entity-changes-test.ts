// Entity Changes Test Scenario
// This file tests the entity-changes module independently of the live-sync functionality

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
  OperationContext 
} from '../core/scenario-runner.ts';
// Import the TableChange interface directly from the module we're testing
import * as entityChanges from '../core/entity-changes.ts';
import { EntityType } from '../core/entity-changes.ts';
import { TableChange } from '@repo/sync-types';

// Logger for this module
const logger = createLogger('entity-changes-test');

// Log environment status
logger.info(`Loaded environment from ${resolve(rootDir, '.env')}`);
logger.info(`Database URL configured: ${process.env.DATABASE_URL ? 'Yes' : 'No'}`);

// We don't need to check serverDataSource anymore since we manage our own in entity-changes.ts
// instead we'll check if the DATABASE_URL environment variable is set
if (!process.env.DATABASE_URL) {
  logger.error('No DATABASE_URL configured. Tests cannot run.');
  logger.error('Please ensure you have configured a proper database connection in .env file.');
  process.exit(1);
}

// Create a DataSource instance directly
const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: serverEntities,
  synchronize: false,
  logging: false
});

/**
 * Entity Changes Test Scenario
 * 
 * This scenario tests the entity-changes module functionality:
 * 1. Initialize database
 * 2. Generate and apply changes for each entity type
 * 3. Verify changes were applied correctly
 * 4. Test CRUD operations for entities
 */
export const EntityChangesTestScenario: Scenario = {
  name: 'Entity Changes Test',
  description: 'Tests the entity-changes module functionality independently',
  config: {
    timeout: 30000,
    changeCount: 10, // Default number of changes to generate
    customProperties: {
      testAllEntityTypes: true
    }
  },
  
  hooks: {
    beforeScenario: async (context) => {
      context.logger.info(`Starting entity changes test with ${context.config.changeCount} changes`);
      
      // Verify database connection before continuing
      try {
        // Initialize our entity-changes module (which will initialize its own dataSource)
        await entityChanges.initialize();
      } catch (error) {
        context.logger.error(`Database connection error: ${error}`);
        context.state.shouldExit = true;
        throw new Error('Database connection not available');
      }
      
      // Initialize state to track test results
      context.state.testResults = {
        initialized: false,
        entitiesCreated: {},
        entitiesUpdated: {},
        entitiesDeleted: {},
        generatedChanges: [],
        success: false
      };
    },
    
    afterScenario: async (context) => {
      // Log test summary
      const results = context.state.testResults;
      
      context.logger.info('=== Entity Changes Test Summary ===');
      context.logger.info(`Database initialized: ${results.initialized}`);
      
      // Entities created
      context.logger.info('Entities created:');
      Object.entries(results.entitiesCreated).forEach(([type, count]) => {
        context.logger.info(`  ${type}: ${count}`);
      });
      
      // Entities updated
      context.logger.info('Entities updated:');
      Object.entries(results.entitiesUpdated).forEach(([type, count]) => {
        context.logger.info(`  ${type}: ${count}`);
      });
      
      // Entities deleted
      context.logger.info('Entities deleted:');
      Object.entries(results.entitiesDeleted).forEach(([type, count]) => {
        context.logger.info(`  ${type}: ${count}`);
      });
      
      context.logger.info(`Total changes generated: ${results.generatedChanges.length}`);
      context.logger.info(`Overall success: ${results.success}`);
    }
  },
  
  steps: [
    // Step 1: Initialize Database
    {
      name: 'Initialize Database',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Initialize Database',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            context.logger.info('Initializing database for entity changes test');
            
            try {
              // Call the initialize function directly
              const result = await entityChanges.initialize();
              
              // Store initialization result
              context.state.testResults.initialized = result;
              
              return { 
                success: result,
                message: result ? 'Database initialized successfully' : 'Database initialization failed'
              };
            } catch (error) {
              context.logger.error(`Database initialization error: ${error}`);
              return {
                success: false,
                error: String(error)
              };
            }
          }
        } as ChangesAction
      ]
    },
    
    // Step 2: Test Creating Entities
    {
      name: 'Create Entities',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Create Entities',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            context.logger.info('Testing entity creation');
            
            const results: Record<string, number> = {};
            const entityTypes: EntityType[] = ['user', 'project', 'task', 'comment'];
            
            // Create a small number of each entity type
            for (const entityType of entityTypes) {
              try {
                // For simplicity, we'll create a small number of each type
                const count = 2;
                
                // Create entities using the entity-changes module
                const createdIds = await entityChanges.createEntities(entityType, count);
                
                // Store results
                results[entityType] = createdIds.length;
                context.logger.info(`Created ${createdIds.length} ${entityType} entities`);
                
                // Store entity IDs for later use
                context.state[`${entityType}Ids`] = createdIds;
              } catch (error) {
                context.logger.error(`Error creating ${entityType} entities: ${error}`);
                results[entityType] = 0;
              }
            }
            
            // Store results in test state
            context.state.testResults.entitiesCreated = results;
            
            // Check if any entities were created successfully
            const totalCreated = Object.values(results).reduce((sum: number, count: unknown) => sum + (count as number), 0);
            
            return {
              success: totalCreated > 0,
              created: results,
              totalCreated
            };
          }
        } as ChangesAction
      ]
    },
    
    // Step 3: Test Updating Entities
    {
      name: 'Update Entities',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Update Entities',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            context.logger.info('Testing entity updates');
            
            const results: Record<string, number> = {};
            const entityTypes: EntityType[] = ['user', 'project', 'task', 'comment'];
            
            // Update entities of each type
            for (const entityType of entityTypes) {
              try {
                // Update one entity of each type
                const updateCount = 1;
                
                // Update entities using the entity-changes module
                const updatedIds = await entityChanges.updateEntities(entityType, updateCount);
                
                // Store results
                results[entityType] = updatedIds.length;
                context.logger.info(`Updated ${updatedIds.length} ${entityType} entities`);
                
                // Store updated entity IDs
                context.state[`${entityType}UpdatedIds`] = updatedIds;
              } catch (error) {
                context.logger.error(`Error updating ${entityType} entities: ${error}`);
                results[entityType] = 0;
              }
            }
            
            // Store results in test state
            context.state.testResults.entitiesUpdated = results;
            
            // Check if any entities were updated successfully
            const totalUpdated = Object.values(results).reduce((sum: number, count: unknown) => sum + (count as number), 0);
            
            return {
              success: totalUpdated > 0,
              updated: results,
              totalUpdated
            };
          }
        } as ChangesAction
      ]
    },
    
    // Step 4: Test Mixed CRUD Operations
    {
      name: 'Test Mixed CRUD Operations',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Test Mixed CRUD Operations',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            context.logger.info('Testing mixed CRUD operations');
            
            const results: Record<string, any> = {};
            const entityTypes: EntityType[] = ['task', 'project']; // Focus on just two types for simplicity
            
            // Test mixed operations for each entity type
            for (const entityType of entityTypes) {
              try {
                // Use the generateAndApplyChanges function with balanced distribution
                const mixedResults = await entityChanges.generateAndApplyChanges(
                  3,  // Small number of changes for each type
                  { [entityType]: 1.0 } // Only focus on this entity type
                );
                
                // Store results
                results[entityType] = {
                  count: mixedResults.changes.length,
                  success: mixedResults.success,
                  error: mixedResults.error
                };
                
                context.logger.info(
                  `Mixed operations for ${entityType}: ` +
                  `${mixedResults.changes.length} changes applied`
                );
              } catch (error) {
                context.logger.error(`Error in mixed operations for ${entityType}: ${error}`);
                results[entityType] = {
                  count: 0,
                  success: false,
                  error: String(error)
                };
              }
            }
            
            return {
              success: Object.keys(results).length > 0,
              mixedResults: results
            };
          }
        } as ChangesAction
      ]
    },
    
    // Step 5: Test generateAndApplyChanges
    {
      name: 'Test Generate and Apply Changes',
      execution: 'serial',
      actions: [
        {
          type: 'changes',
          name: 'Generate and Apply Changes',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            const changeCount = context.config.changeCount || 10;
            
            context.logger.info(`Testing generateAndApplyChanges with ${changeCount} changes`);
            
            try {
              // Define a custom distribution to test all entity types
              const distribution: Record<string, number> = {
                task: 0.3,
                project: 0.3,
                user: 0.2,
                comment: 0.2
              };
              
              // Generate and apply changes in a single operation
              const result = await entityChanges.generateAndApplyChanges(changeCount, distribution);
              
              if (!result.success) {
                context.logger.error(`Failed to generate and apply changes: ${result.error}`);
                return result;
              }
              
              // Store the results
              context.state.testResults.generatedChanges = result.changes;
              
              // Analyze the applied changes
              const changesByType: Record<string, number> = {};
              const changesByOperation: Record<string, number> = {};
              
              result.changes.forEach((change: TableChange) => {
                // Count by table/entity type
                changesByType[change.table] = (changesByType[change.table] || 0) + 1;
                
                // Count by operation
                changesByOperation[change.operation] = (changesByOperation[change.operation] || 0) + 1;
              });
              
              context.logger.info(`Generated ${result.changes.length} changes:`);
              context.logger.info(`By type: ${JSON.stringify(changesByType)}`);
              context.logger.info(`By operation: ${JSON.stringify(changesByOperation)}`);
              
              return {
                success: result.success,
                changeCount: result.changes.length,
                byType: changesByType,
                byOperation: changesByOperation
              };
            } catch (error) {
              context.logger.error(`Error in generateAndApplyChanges: ${error}`);
              return {
                success: false,
                error: String(error)
              };
            }
          }
        } as ChangesAction
      ]
    },
    
    // Step 6: Validate Results
    {
      name: 'Validate Test Results',
      execution: 'serial',
      actions: [
        {
          type: 'validation',
          name: 'Validate Entity Changes Test Results',
          operation: 'exec',
          params: async (context: OperationContext, operations: Record<string, any>) => {
            context.logger.info('Validating entity changes test results');
            
            const testResults = context.state.testResults;
            const validations: Record<string, boolean> = {};
            
            // Validate initialization
            validations.initialized = testResults.initialized === true;
            
            // Validate entity creation
            const createdEntityCount = Object.values(testResults.entitiesCreated)
              .reduce((sum: number, count: unknown) => sum + (count as number), 0);
            validations.entitiesCreated = createdEntityCount > 0;
            
            // Validate entity updates
            const updatedEntityCount = Object.values(testResults.entitiesUpdated)
              .reduce((sum: number, count: unknown) => sum + (count as number), 0);
            validations.entitiesUpdated = updatedEntityCount > 0;
            
            // Validate generateAndApplyChanges
            validations.changesGenerated = Array.isArray(testResults.generatedChanges) && 
              testResults.generatedChanges.length > 0;
            
            // Overall success - all validations must pass
            const success = Object.values(validations).every(value => value === true);
            
            // Update test results with final success status
            testResults.success = success;
            
            return {
              success,
              validations,
              message: success 
                ? 'Entity changes test passed all validations' 
                : 'Entity changes test failed one or more validations'
            };
          }
        } as ValidationAction
      ]
    }
  ]
};

// Register this scenario with the default export
export default EntityChangesTestScenario;

/**
 * Run the entity changes test
 * @param changeCount Number of changes to generate in testing
 */
export async function runEntityChangesTest(changeCount: number = 10): Promise<any> {
  logger.info(`Starting entity changes test with ${changeCount} changes`);
  
  // Try to initialize the database connection using our new approach
  try {
    const initialized = await entityChanges.initialize();
    if (!initialized) {
      logger.error('Failed to initialize the database. Test cannot run.');
      return { 
        success: false, 
        error: 'Database initialization failed. Please check the logs for details.'
      };
    }
  } catch (error) {
    logger.error(`Failed to initialize database connection: ${error}`);
    return { success: false, error: `Database initialization failed: ${error}` };
  }
  
  // Proceed with the test
  const scenario = { ...EntityChangesTestScenario };
  scenario.config.changeCount = changeCount;
  
  // Create and run the scenario
  const runner = new ScenarioRunner();
  
  try {
    // Run the scenario
    const result = await runner.runScenario(scenario);
    
    logger.info('Entity changes test completed');
    return result;
  } catch (error) {
    logger.error(`Test failed: ${error instanceof Error ? error.message : String(error)}`);
    return { success: false, error: String(error) };
  }
}

// Make the command line execution check for database connection first
if (typeof import.meta !== 'undefined' && import.meta.url) {
  // Check if the file was executed directly
  const isDirectCommandExecution = process.argv[1] && 
    (process.argv[1].endsWith('entity-changes-test.ts') || process.argv[1].includes('entity-changes-test.ts'));
    
  if (isDirectCommandExecution) {
    // Early check for database connection
    if (!process.env.DATABASE_URL) {
      logger.error('ERROR: No DATABASE_URL environment variable available.');
      logger.error('Please ensure DATABASE_URL is properly configured in your .env file.');
      process.exit(1);
    }
    
    // Parse command line arguments
    const args = process.argv.slice(2);
    const changeCount = parseInt(args[0] || '10', 10);
    
    logger.info(`Starting entity changes test with ${changeCount} changes from command line`);
    
    runEntityChangesTest(changeCount)
      .then(results => {
        // Check if test failed
        const success = results && results.success;
        
        // Log summary
        if (success) {
          logger.info('✅ Entity changes test completed successfully!');
        } else {
          logger.error('❌ Entity changes test failed!');
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
    logger.debug('Entity changes test module imported by another module, not running automatically');
  }
} else {
  // Initialize the module and run tests
  entityChanges.initialize()
    .then(initialized => {
      if (initialized) {
        console.log('Database has been initialized!');
        // Run the tests
        runEntityChangesTest(5)
          .then(() => {
            console.log('Tests completed');
            process.exit(0);
          })
          .catch(error => {
            console.error('Test failed:', error);
            process.exit(1);
          });
      } else {
        console.error('Failed to initialize database');
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('Error during database initialization:', err);
      process.exit(1);
    });
} 