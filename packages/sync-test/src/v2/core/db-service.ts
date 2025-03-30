import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { neon } from '@neondatabase/serverless';
// Import the working functions from the local entity-changes module
import {
  createBulkEntityChanges,
  createMixedChanges,
  createMixedEntityChanges,
  updateBulkEntityChanges,
  deleteBulkEntityChanges,
  EntityType as ExternalEntityType
} from './entity-changes.ts';
import { createLogger } from './logger.ts';
import { Operation } from '../types.ts';
import { DB_TABLES, TEST_DEFAULTS, API_CONFIG } from '../config.ts';
import type { TableChange } from '@repo/sync-types';

// Redefine EntityType locally to avoid import conflicts
type LocalEntityType = 'user' | 'project' | 'task' | 'comment';

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
  entityType: LocalEntityType, 
  operation: Operation, 
  count: number
): Promise<TableChange[]> {
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
  
  // Map operation types
  const operationMap: Record<Operation, 'insert' | 'update' | 'delete'> = {
    'create': 'insert',
    'update': 'update',
    'delete': 'delete'
  };
  
  // Map entity types to table names
  const tableName = `${entityType}s`;
  
  // Convert IDs to TableChange objects
  const changes: TableChange[] = ids.map((id: string) => {
    return {
      table: tableName,
      operation: operationMap[operation],
      data: { id },
      updated_at: new Date().toISOString()
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
  entityTypes: LocalEntityType[] = TEST_DEFAULTS.ENTITY_TYPES as LocalEntityType[],
  operations: Operation[] = ['create', 'update', 'delete']
): Promise<TableChange[]> {
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
  
  // Convert to TableChange objects
  const changes: TableChange[] = [];
  
  // Map operation types
  const operationMap: Record<Operation, 'insert' | 'update' | 'delete'> = {
    'create': 'insert',
    'update': 'update',
    'delete': 'delete'
  };
  
  // Map entity types to table names
  const tableMap: Record<string, string> = {
    'task': 'tasks',
    'project': 'projects',
    'user': 'users',
    'comment': 'comments'
  };
  
  // Process each entity type
  Object.entries(results).forEach(([entityType, result]) => {
    if (!result) return;
    
    const tableName = tableMap[entityType] || `${entityType}s`;
    
    // Add created entities
    result.created.forEach((id: string) => {
      changes.push({
        table: tableName,
        operation: 'insert',
        data: { id },
        updated_at: new Date().toISOString()
      });
    });
    
    // Add updated entities
    result.updated.forEach((id: string) => {
      changes.push({
        table: tableName,
        operation: 'update',
        data: { id },
        updated_at: new Date().toISOString()
      });
    });
    
    // Add deleted entities
    result.deleted.forEach((id: string) => {
      changes.push({
        table: tableName,
        operation: 'delete',
        data: { id },
        updated_at: new Date().toISOString()
      });
    });
  });
  
  // Log detailed info about the changes created
  logger.info(`Created batch with ${changes.length} changes`);
  if (changes.length <= 10) {
    // Log all changes in small batches
    changes.forEach((change, index) => {
      logger.info(`  Created change ${index+1}: id=${change.data.id}, table=${change.table}, operation=${change.operation}`);
    });
  } else {
    // Log a sample of changes for larger batches
    logger.info(`  Sample of change IDs created:`);
    for (let i = 0; i < Math.min(5, changes.length); i++) {
      const change = changes[i];
      logger.info(`  Change ${i+1}: id=${change.data.id}, table=${change.table}, operation=${change.operation}`);
    }
  }
  
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

/**
 * Check if an entity ID exists in the specified table
 * @param table The table name to check
 * @param id Entity ID to check
 * @returns Boolean indicating if the ID exists
 */
export async function checkEntityExists(table: string, id: string): Promise<boolean> {
  await ensureConnection();
  
  try {
    let result;
    
    // Use hardcoded table names for safety with Neon client
    if (table === DB_TABLES.USERS) {
      result = await sql`SELECT 1 FROM users WHERE id = ${id}::uuid`;
    } else if (table === DB_TABLES.PROJECTS) {
      result = await sql`SELECT 1 FROM projects WHERE id = ${id}::uuid`;
    } else if (table === DB_TABLES.TASKS) {
      result = await sql`SELECT 1 FROM tasks WHERE id = ${id}::uuid`;
    } else if (table === DB_TABLES.COMMENTS) {
      result = await sql`SELECT 1 FROM comments WHERE id = ${id}::uuid`;
    } else {
      logger.warn(`Unknown table: ${table}`);
      return false;
    }
    
    // Return true if any results were found
    return result && result.length > 0;
  } catch (error) {
    logger.warn(`Error checking if entity exists in ${table}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Retrieve entity data from the specified table
 * @param table The table name to query
 * @param id Entity ID to retrieve
 * @returns Entity data or null if not found
 */
export async function getEntityById(table: string, id: string): Promise<any | null> {
  await ensureConnection();
  
  try {
    let result;
    
    // Use hardcoded table names for safety with Neon client
    if (table === DB_TABLES.USERS) {
      result = await sql`SELECT * FROM users WHERE id = ${id}::uuid`;
    } else if (table === DB_TABLES.PROJECTS) {
      result = await sql`SELECT * FROM projects WHERE id = ${id}::uuid`;
    } else if (table === DB_TABLES.TASKS) {
      result = await sql`SELECT * FROM tasks WHERE id = ${id}::uuid`;
    } else if (table === DB_TABLES.COMMENTS) {
      result = await sql`SELECT * FROM comments WHERE id = ${id}::uuid`;
    } else {
      logger.warn(`Unknown table: ${table}`);
      return null;
    }
    
    // Return the first result or null
    return (result && result.length > 0) ? result[0] : null;
  } catch (error) {
    logger.warn(`Error retrieving entity from ${table}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Verify that a set of entity IDs exist in a table
 * @param table The table name to check
 * @param ids Array of IDs to check
 * @returns Array of IDs that exist in the table
 */
export async function verifyEntitiesExist(table: string, ids: string[]): Promise<string[]> {
  await ensureConnection();
  
  if (!ids || ids.length === 0) {
    return [];
  }
  
  try {
    const existingIds: string[] = [];
    
    // Process each ID individually instead of doing a batch query
    // This is more compatible with the sql template tag system
    for (const id of ids) {
      let exists = false;
      
      // Use hardcoded table names for safety with Neon client
      if (table === DB_TABLES.USERS) {
        const result = await sql`SELECT id FROM users WHERE id = ${id}::uuid`;
        exists = result && result.length > 0;
      } else if (table === DB_TABLES.PROJECTS) {
        const result = await sql`SELECT id FROM projects WHERE id = ${id}::uuid`;
        exists = result && result.length > 0;
      } else if (table === DB_TABLES.TASKS) {
        const result = await sql`SELECT id FROM tasks WHERE id = ${id}::uuid`;
        exists = result && result.length > 0;
      } else if (table === DB_TABLES.COMMENTS) {
        const result = await sql`SELECT id FROM comments WHERE id = ${id}::uuid`;
        exists = result && result.length > 0;
      } else {
        logger.warn(`Unknown table: ${table}`);
        continue;
      }
      
      if (exists) {
        existingIds.push(id);
      }
    }
    
    return existingIds;
  } catch (error) {
    logger.error(`Error verifying entities in ${table}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
} 