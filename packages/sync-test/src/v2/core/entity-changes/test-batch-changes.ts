/**
 * Test Batch Changes
 * 
 * A simple script to test the batch change generation functions.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { User, Project, Task, Comment } from '@repo/dataforge/server-entities';

import { createLogger } from '../logger.ts';
import { 
  generateMixedChanges, 
  generateAndApplyMixedChanges 
} from './batch-changes.ts';
import { initialize } from './db-utils.ts';
import { ChangeTracker } from './change-tracker.ts';

// Get directory path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file in the sync-test package root
const envPath = path.join(__dirname, '../../../../.env');
dotenv.config({ path: envPath });

// Initialize logger
const logger = createLogger('batch-test');

// Check DATABASE_URL environment variable
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  logger.error('DATABASE_URL environment variable not configured.');
  process.exit(1);
}

// Create our own DataSource directly
const dataSource = new DataSource({
  type: 'postgres',
  url: DATABASE_URL,
  synchronize: false,
  entities: [User, Project, Task, Comment],
});

/**
 * Run a simple test of the batch changes functionality
 */
async function runBatchTest() {
  // Initialize database connection
  logger.info('Initializing database connection');
  await dataSource.initialize();
  logger.info('Database connected');
  
  // Initialize our entity changes system with our dataSource
  await initialize(dataSource);

  try {
    // Create a change tracker to monitor our changes
    const changeTracker = new ChangeTracker({
      deduplicationEnabled: true,
      tolerance: 0
    });
    
    // Register a test client with the tracker
    const testClientId = 'batch-test-client';
    changeTracker.registerClients([testClientId]);

    // Test 1: Generate mixed changes (create, update, delete)
    // Note: In mixed mode, batch size is fixed at 20 with exactly one delete
    logger.info('Testing mixed changes generation');
    const mixedChanges = await generateMixedChanges(undefined, 'mixed');
    
    // Analyze the mixed changes
    const mixedInserts = mixedChanges.filter(change => change.operation === 'insert');
    const mixedUpdates = mixedChanges.filter(change => change.operation === 'update');
    const mixedDeletes = mixedChanges.filter(change => change.operation === 'delete');
    
    // Check for duplicates
    const uniqueIds = new Set();
    const duplicates = [];
    
    mixedChanges.forEach(change => {
      // Create a key for each change using table+id+operation
      if (change.data?.id) {
        const key = `${change.table}-${change.data.id}-${change.operation}`;
        if (uniqueIds.has(key)) {
          duplicates.push(key);
        } else {
          uniqueIds.add(key);
        }
      }
    });
    
    logger.info(`Mixed batch results: ${mixedChanges.length} total changes`);
    logger.info(`- ${mixedInserts.length} inserts, ${mixedUpdates.length} updates, ${mixedDeletes.length} deletes`);
    logger.info(`- ${duplicates.length} duplicates detected (expected 1)`);
    
    // Test 2: Generate seed changes (all inserts, dependency order)
    // In seed mode, requested size is respected (30 changes)
    logger.info('Testing seed changes generation');
    const seedCount = 30;
    const seedChanges = await generateMixedChanges(seedCount, 'seed');
    
    // Analyze the seed changes
    const seedInserts = seedChanges.filter(change => change.operation === 'insert');
    const seedUpdates = seedChanges.filter(change => change.operation === 'update');
    const seedDeletes = seedChanges.filter(change => change.operation === 'delete');
    
    logger.info(`Seed batch results: ${seedChanges.length} total changes (requested ${seedCount})`);
    logger.info(`- ${seedInserts.length} inserts, ${seedUpdates.length} updates, ${seedDeletes.length} deletes`);
    
    // Test 3: Generate and apply mixed changes with deduplication
    // THIS TEST MUST PASS OR THE ENTIRE SCRIPT FAILS
    logger.info('Testing generateAndApplyMixedChanges with mixed mode and deduplication');
    
    // Tell the tracker how many changes we expect to apply
    const expectedChanges = 20; // For mixed mode, will always be 20
    changeTracker.setClientExpectedCount(testClientId, expectedChanges);
    
    // Generate and apply the changes - this will now throw if it fails
    const appliedChanges = await generateAndApplyMixedChanges(undefined, 'mixed');
    
    // Analyze the applied changes
    const appliedInserts = appliedChanges.filter(change => change.operation === 'insert');
    const appliedUpdates = appliedChanges.filter(change => change.operation === 'update');
    const appliedDeletes = appliedChanges.filter(change => change.operation === 'delete');
    
    // Track these changes in our tracker
    changeTracker.trackChanges(testClientId, appliedChanges);
    changeTracker.trackDatabaseChanges(appliedChanges);
    
    logger.info(`Successfully applied ${appliedChanges.length} mixed changes`);
    logger.info(`- ${appliedInserts.length} inserts, ${appliedUpdates.length} updates, ${appliedDeletes.length} deletes`);
    
    // Get a validation report
    const report = changeTracker.getValidationReport();
    logger.info(`Change validation report: 
      - Total database changes: ${report.databaseChanges}
      - Total received changes: ${report.receivedChanges}
      - Missing changes: ${report.missingChanges.length}
      - Success: ${report.success}
    `);
    
    // Check completion status
    const completionStats = changeTracker.getCompletionStats();
    logger.info(`Completion stats: ${completionStats.percentComplete}% complete (${completionStats.receivedChanges}/${completionStats.expectedChanges})`);
  } catch (error) {
    logger.error(`Error running mixed mode tests: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      logger.error(`Stack trace: ${error.stack}`);
    }
    // Close the connection and exit with failure
    if (dataSource && dataSource.isInitialized) {
      await dataSource.destroy();
      logger.info('Database connection closed');
    }
    process.exit(1); // Fail the test if mixed mode fails
  }
  
  try {
    // Create a fresh tracker for the seed test
    const changeTracker = new ChangeTracker({
      deduplicationEnabled: true,
      tolerance: 0
    });
    
    // Register a test client with the tracker
    const testClientId = 'batch-test-client';
    changeTracker.registerClients([testClientId]);
    
    // Test 4: Generate and apply seed changes (all inserts)
    logger.info('Testing generateAndApplyMixedChanges with seed mode');
    
    // Set a smaller seed batch size
    const seedBatchSize = 15;
    changeTracker.setClientExpectedCount(testClientId, seedBatchSize);
    
    // Generate and apply seed changes
    const appliedSeedChanges = await generateAndApplyMixedChanges(seedBatchSize, 'seed');
    
    // Analyze the applied seed changes
    const appliedSeedInserts = appliedSeedChanges.filter(change => change.operation === 'insert');
    
    // Track these changes in our tracker
    changeTracker.trackChanges(testClientId, appliedSeedChanges);
    changeTracker.trackDatabaseChanges(appliedSeedChanges);
    
    logger.info(`Successfully applied ${appliedSeedChanges.length} seed changes (requested ${seedBatchSize})`);
    logger.info(`- ${appliedSeedInserts.length} inserts`);
    
    // Get a validation report for seed changes
    const seedReport = changeTracker.getValidationReport();
    logger.info(`Seed change validation report: 
      - Total database changes: ${seedReport.databaseChanges}
      - Total received changes: ${seedReport.receivedChanges}
      - Missing changes: ${seedReport.missingChanges.length}
      - Success: ${seedReport.success}
    `);
    
    // Check completion status for seed changes
    const seedCompletionStats = changeTracker.getCompletionStats();
    logger.info(`Seed completion stats: ${seedCompletionStats.percentComplete}% complete (${seedCompletionStats.receivedChanges}/${seedCompletionStats.expectedChanges})`);

    logger.info('All tests completed successfully');
  } catch (error) {
    logger.error(`Error running seed mode tests: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      logger.error(`Stack trace: ${error.stack}`);
    }
    process.exit(1);
  } finally {
    // Close database connection if we initialized it
    if (dataSource && dataSource.isInitialized) {
      await dataSource.destroy();
      logger.info('Database connection closed');
    }
  }
}

// Run the test
runBatchTest().catch(err => {
  logger.error(`Unhandled error running batch test: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    logger.error(`Stack trace: ${err.stack}`);
  }
  process.exit(1);
}); 