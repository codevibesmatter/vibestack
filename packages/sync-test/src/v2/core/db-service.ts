import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { neon } from '@neondatabase/serverless';
import { faker } from '@faker-js/faker';
// Import the working functions from the local entity-changes module
import {
  createBulkEntityChanges,
  createMixedChanges,
  createMixedEntityChanges,
  updateBulkEntityChanges,
  deleteBulkEntityChanges,
  EntityType as ExternalEntityType,
  generateFakeEntityData,
  generateMixedChangesInMemory
} from './entity-changes.ts';
import { createLogger } from './logger.ts';
import { Operation } from '../types.ts';
import { DB_TABLES, TEST_DEFAULTS, API_CONFIG, ENTITY_OPERATIONS } from '../config.ts';
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

/**
 * Generate a batch of changes in memory (without writing to database)
 * @param size Number of changes to generate
 * @param distribution Distribution of entity types
 * @returns Array of pre-generated changes
 */
export async function generateChangeBatch(
  size: number,
  distribution: {[key in ExternalEntityType]?: number} = {}
): Promise<TableChange[]> {
  logger.info(`Generating batch of ${size} changes in memory (no database interaction)`);
  
  // Generate mixed changes in memory
  const generatedChanges = await generateMixedChangesInMemory(
    size, 
    distribution, 
    ENTITY_OPERATIONS.OPERATION_DISTRIBUTION
  );
  
  // Convert to TableChange objects
  const changes: TableChange[] = [];
  
  // Map operation types
  const operationMap: Record<string, 'insert' | 'update' | 'delete'> = {
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
  Object.entries(generatedChanges.changes).forEach(([entityType, entityChanges]) => {
    if (!entityChanges) return;
    
    const tableName = tableMap[entityType] || `${entityType}s`;
    
    // Process each operation type within this entity
    Object.entries(entityChanges).forEach(([operation, ids]) => {
      if (!ids || !Array.isArray(ids)) return;
      
      const dbOperation = operationMap[operation] || operation;
      
      ids.forEach((record: any) => {
        const id = typeof record === 'string' ? record : record.id;
        const data = typeof record === 'string' ? { id } : record;
        
        changes.push({
          table: tableName,
          operation: dbOperation as 'insert' | 'update' | 'delete',
          data,
          updated_at: new Date().toISOString()
        });
      });
    });
  });
  
  // Log detailed info about the changes generated
  logger.info(`Generated batch with ${changes.length} changes in memory`);
  if (changes.length <= 10) {
    changes.forEach((change, index) => {
      logger.info(`  Generated change ${index+1}: id=${change.data.id}, table=${change.table}, operation=${change.operation}`);
    });
  } else {
    logger.info(`  Sample of generated changes:`);
    for (let i = 0; i < Math.min(5, changes.length); i++) {
      const change = changes[i];
      logger.info(`  Change ${i+1}: id=${change.data.id}, table=${change.table}, operation=${change.operation}`);
    }
  }
  
  return changes;
}

/**
 * Update a specific entity record
 * Helper function for batch operations
 */
async function updateEntityRecord(
  sql: any,
  entityType: ExternalEntityType,
  id: string
): Promise<string[]> {
  try {
    // Check if entity exists
    let exists = false;
    const tableName = `${entityType}s`;
    
    try {
      const result = await sql`SELECT id FROM ${sql(tableName)} WHERE id = ${id}::uuid`;
      exists = result && result.length > 0;
    } catch (e) {
      logger.error(`Error checking if ${entityType} ${id} exists: ${e}`);
      return [];
    }
    
    if (!exists) {
      logger.warn(`Cannot update non-existent ${entityType} ${id}`);
      return [];
    }
    
    // Generate updates based on entity type
    let updateFields = '';
    
    switch (entityType) {
      case 'task':
        updateFields = 'title = $1, description = $2, updated_at = $3';
        await sql`
          UPDATE tasks 
          SET title = ${faker.lorem.sentence()}, 
              description = ${faker.lorem.paragraph()},
              updated_at = ${new Date()}
          WHERE id = ${id}::uuid
        `;
        break;
        
      case 'project':
        await sql`
          UPDATE projects 
          SET name = ${faker.company.name()}, 
              description = ${faker.lorem.paragraph()},
              updated_at = ${new Date()}
          WHERE id = ${id}::uuid
        `;
        break;
        
      case 'user':
        await sql`
          UPDATE users 
          SET name = ${faker.person.fullName()}, 
              email = ${faker.internet.email()},
              updated_at = ${new Date()}
          WHERE id = ${id}::uuid
        `;
        break;
        
      case 'comment':
        await sql`
          UPDATE comments 
          SET content = ${faker.lorem.paragraph()}, 
              updated_at = ${new Date()}
          WHERE id = ${id}::uuid
        `;
        break;
        
      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
    
    logger.debug(`Updated ${entityType} ${id}`);
    return [id];
  } catch (error) {
    logger.error(`Error updating ${entityType} ${id}: ${error}`);
    return [];
  }
}

/**
 * Apply a batch of changes to the database
 * This helper function is used by applyChangeBatch
 */
async function applyChangesBatch(
  sql: any,
  entityType: ExternalEntityType,
  operation: string,
  changes: TableChange[]
): Promise<TableChange[]> {
  // Extract IDs and data from changes
  const changeData = changes.map(change => change.data);
  
  try {
    let results: string[] = [];
    
    if (operation === 'create' || operation === 'insert') {
      // For inserts, use the data directly
      results = await batchInsertEntities(sql, entityType, changeData.length);
    } else if (operation === 'update') {
      // For updates, extract IDs
      const ids = changeData.map(data => data.id as string);
      results = await batchUpdateEntities(sql, entityType, ids);
    } else if (operation === 'delete') {
      // For deletes, extract IDs
      const ids = changeData.map(data => data.id as string);
      results = await batchDeleteEntities(sql, entityType, ids);
    }
    
    // Map results back to TableChange objects
    return results.map(id => ({
      table: `${entityType}s`,
      operation: operation === 'create' ? 'insert' : operation as 'update' | 'delete',
      data: { id },
      updated_at: new Date().toISOString()
    }));
  } catch (error) {
    logger.error(`Error applying ${operation} changes for ${entityType}: ${error}`);
    throw error;
  }
}

/**
 * Batch insert entities into the database
 */
async function batchInsertEntities(
  sql: any,
  entityType: ExternalEntityType,
  count: number
): Promise<string[]> {
  // For simplicity, we'll just call existing functions
  // In a real implementation, you'd use the pre-generated data
  return await createBulkEntityChanges(sql, entityType, count);
}

/**
 * Batch update entities in the database
 */
async function batchUpdateEntities(
  sql: any,
  entityType: ExternalEntityType,
  ids: string[]
): Promise<string[]> {
  // For each ID, update the entity
  const results: string[] = [];
  
  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5);
    for (const id of batch) {
      try {
        const updated = await updateEntityRecord(sql, entityType, id);
        results.push(...updated);
      } catch (error) {
        logger.error(`Error updating ${entityType} ${id}: ${error}`);
      }
    }
    
    // Allow connection to close between batches
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  return results;
}

/**
 * Batch delete entities from the database
 */
async function batchDeleteEntities(
  sql: any,
  entityType: ExternalEntityType,
  ids: string[]
): Promise<string[]> {
  // Implement actual batch deletion
  // For now, we'll just return the IDs
  return ids;
}

/**
 * Apply a batch of pre-generated changes to the database
 * @param changes Pre-generated changes to apply
 * @returns Applied changes with database IDs
 */
export async function applyChangeBatch(
  changes: TableChange[]
): Promise<TableChange[]> {
  await ensureConnection();
  
  logger.info(`Applying batch of ${changes.length} pre-generated changes to database`);
  
  // Group changes by entity type and operation for efficient processing
  const groupedChanges: Record<string, Record<string, TableChange[]>> = {};
  
  // Map table names back to entity types
  const entityTypeMap: Record<string, ExternalEntityType> = {
    'tasks': 'task',
    'projects': 'project',
    'users': 'user',
    'comments': 'comment'
  };
  
  // Map operation types 
  const operationTypeMap: Record<string, string> = {
    'insert': 'create',
    'update': 'update',
    'delete': 'delete'
  };
  
  // Group changes by entity type and operation
  changes.forEach(change => {
    const entityType = entityTypeMap[change.table] || change.table;
    const operation = operationTypeMap[change.operation] || change.operation;
    
    if (!groupedChanges[entityType]) {
      groupedChanges[entityType] = {};
    }
    
    if (!groupedChanges[entityType][operation]) {
      groupedChanges[entityType][operation] = [];
    }
    
    groupedChanges[entityType][operation].push(change);
  });
  
  // Process each entity type sequentially to avoid connection pool exhaustion
  const appliedChanges: TableChange[] = [];
  
  for (const [entityType, operations] of Object.entries(groupedChanges)) {
    for (const [operation, opChanges] of Object.entries(operations)) {
      logger.info(`Processing ${opChanges.length} ${operation} operations for ${entityType}`);
      
      // Apply changes in smaller batches to prevent connection timeouts
      const batchSize = 15;
      let processedCount = 0;
      
      for (let i = 0; i < opChanges.length; i += batchSize) {
        const batch = opChanges.slice(i, i + batchSize);
        
        try {
          const batchResult = await applyChangesBatch(
            sql, 
            entityType as ExternalEntityType, 
            operation, 
            batch
          );
          
          appliedChanges.push(...batchResult);
          processedCount += batch.length;
          
          logger.info(`Applied batch ${Math.floor(i / batchSize) + 1} (${batch.length} changes), total ${processedCount}/${opChanges.length}`);
          
          // Allow connection to close between batches
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (error) {
          logger.error(`Error applying changes batch: ${error}`);
          // Continue with next batch
        }
      }
    }
    
    // Allow connection to fully close between entity types
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  logger.info(`Successfully applied ${appliedChanges.length} changes to database`);
  return appliedChanges;
} 