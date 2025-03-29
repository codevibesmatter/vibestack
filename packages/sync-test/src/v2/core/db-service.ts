import { neon } from '@neondatabase/serverless';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
// Import the working functions from the local entity-changes module
import {
  createBulkEntityChanges,
  createMixedChanges,
  createMixedEntityChanges,
  EntityType as ExternalEntityType
} from './entity-changes.ts';
import { createLogger } from './logger.ts';
import { EntityChange, Operation } from '../types.ts';
import { DB_TABLES, TEST_DEFAULTS, API_CONFIG } from '../config.ts';

// Map our local EntityType to the external one
type EntityType = 'user' | 'project' | 'task' | 'comment';

// Logger instance
const logger = createLogger('db-service');

// Database connection
let sql: any = null;
let dbInitialized = false;

/**
 * Initialize database connection
 */
export async function initializeDatabase(): Promise<void> {
  if (dbInitialized && sql) {
    return;
  }
  
  const dbConnectionString = process.env.DATABASE_URL || '';
  
  if (!dbConnectionString) {
    throw new Error('Database connection string not provided - make sure DATABASE_URL is set in your environment');
  }
  
  try {
    // Create neon HTTP client
    sql = neon(dbConnectionString);
    
    // Test the connection
    const result = await sql`SELECT NOW() as connection_test`;
    
    if (!result || !Array.isArray(result) || result.length === 0) {
      throw new Error('Database connection test failed: empty result');
    }
    
    // Verify tables
    await verifyTables();
    
    dbInitialized = true;
    logger.info('Database connection initialized successfully');
  } catch (error) {
    logger.error(`Database initialization error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Verify that required tables exist
 */
async function verifyTables(): Promise<void> {
  if (!sql) {
    throw new Error('Database not connected');
  }
  
  try {
    // Check each table
    const tables = [
      DB_TABLES.USERS,
      DB_TABLES.PROJECTS,
      DB_TABLES.TASKS,
      DB_TABLES.COMMENTS
    ];
    
    for (const table of tables) {
      const result = await sql`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = ${table}
        )
      `;
      
      if (!result[0].exists) {
        logger.warn(`Table '${table}' does not exist in the database`);
      }
    }
  } catch (error) {
    logger.error(`Error verifying tables: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Clear all data from test tables
 */
async function clearAllData(sql: any): Promise<void> {
  try {
    // Delete in reverse order to respect foreign keys
    await sql`DELETE FROM ${DB_TABLES.COMMENTS}`;
    await sql`DELETE FROM ${DB_TABLES.TASKS}`;
    await sql`DELETE FROM ${DB_TABLES.PROJECTS}`;
    await sql`DELETE FROM ${DB_TABLES.USERS}`;
    
    logger.info('Cleared all data from database tables');
  } catch (error) {
    logger.error(`Error clearing data: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Clear all data from the database
 */
export async function clearDatabase(): Promise<void> {
  await ensureConnection();
  await clearAllData(sql);
  logger.info('Cleared all data from database');
}

/**
 * Create changes for a specific operation type 
 */
export async function createChanges(
  entityType: EntityType, 
  operation: Operation, 
  count: number
): Promise<EntityChange[]> {
  await ensureConnection();
  
  logger.info(`Creating ${count} ${operation} operations for ${entityType}`);
  
  let ids: string[] = [];
  
  // Delegate to the appropriate function based on operation
  if (operation === 'create') {
    ids = await createBulkEntityChanges(sql, entityType as ExternalEntityType, count);
  } else if (operation === 'update') {
    // Use mixed entity changes with only update operation
    const result = await createMixedEntityChanges(
      sql, 
      entityType as ExternalEntityType,
      count, 
      {create: 0, update: 1, delete: 0}
    );
    ids = result.updated;
  } else if (operation === 'delete') {
    // Use mixed entity changes with only delete operation
    const result = await createMixedEntityChanges(
      sql, 
      entityType as ExternalEntityType,
      count, 
      {create: 0, update: 0, delete: 1}
    );
    ids = result.deleted;
  }
  
  // Convert IDs to EntityChange objects
  const changes: EntityChange[] = ids.map((id: string) => {
    return {
      id,
      type: entityType,
      operation,
      timestamp: Date.now(),
      data: { id } // Minimal data
    };
  });
  
  logger.info(`Created ${changes.length} changes`);
  return changes;
}

/**
 * Create a batch of mixed changes
 */
export async function createChangeBatch(
  size: number,
  entityTypes: EntityType[] = TEST_DEFAULTS.ENTITY_TYPES as EntityType[],
  operations: Operation[] = ['create', 'update', 'delete']
): Promise<EntityChange[]> {
  await ensureConnection();
  
  logger.info(`Creating batch of ${size} changes`);
  
  // Create distribution object for mixed changes
  const distribution: {[key in ExternalEntityType]?: number} = {};
  const typeWeight = 1 / entityTypes.length;
  
  entityTypes.forEach(type => {
    distribution[type as ExternalEntityType] = typeWeight;
  });
  
  // Create mixed changes using the imported function from entity-changes
  const results = await createMixedChanges(sql, size, distribution);
  
  // Convert to EntityChange objects
  const changes: EntityChange[] = [];
  
  // Process each entity type
  Object.entries(results).forEach(([entityType, result]) => {
    if (!result) return;
    
    // Add created entities
    result.created.forEach((id: string) => {
      changes.push({
        id,
        type: entityType as EntityType,
        operation: 'create',
        timestamp: Date.now(),
        data: { id }
      });
    });
    
    // Add updated entities
    result.updated.forEach((id: string) => {
      changes.push({
        id,
        type: entityType as EntityType,
        operation: 'update',
        timestamp: Date.now(),
        data: { id }
      });
    });
    
    // Add deleted entities
    result.deleted.forEach((id: string) => {
      changes.push({
        id,
        type: entityType as EntityType,
        operation: 'delete',
        timestamp: Date.now(),
        data: { id }
      });
    });
  });
  
  logger.info(`Created batch with ${changes.length} changes`);
  return changes;
}

/**
 * Get the current server LSN
 */
export async function getCurrentLSN(): Promise<string> {
  await ensureConnection();
  
  try {
    // Query the replication slot for current LSN
    const result = await sql`
      SELECT confirmed_flush_lsn AS lsn
      FROM pg_replication_slots 
      WHERE slot_name = 'vibestack_replication'
    `;
    
    if (!result || result.length === 0) {
      throw new Error('No replication slot found');
    }
    
    const lsn = result[0].lsn;
    logger.info(`Current server LSN: ${lsn}`);
    return lsn;
  } catch (error) {
    logger.error(`Error getting current LSN: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Initialize the replication system
 */
export async function initializeReplication(): Promise<void> {
  await ensureConnection();
  
  try {
    // Check if replication is already set up
    const checkResult = await sql`
      SELECT COUNT(*) as count
      FROM pg_replication_slots 
      WHERE slot_name = 'vibestack_replication'
    `;
    
    if (checkResult[0].count > 0) {
      logger.info('Replication already initialized');
      return;
    }
    
    // Create the replication slot
    await sql`
      SELECT pg_create_logical_replication_slot(
        'vibestack_replication', 
        'wal2json'
      )
    `;
    
    logger.info('Replication system initialized');
  } catch (error) {
    logger.error(`Error initializing replication: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Ensure database connection is established
 */
async function ensureConnection(): Promise<void> {
  if (!dbInitialized || !sql) {
    await initializeDatabase();
  }
} 