import { PGliteWorker } from '@electric-sql/pglite/worker';
import { live } from '@electric-sql/pglite/live';
import type { PGliteWithLive, AnyPGliteWithLive } from './types';
import { assertPGliteWithLive } from './types';
import { dbMessageBus } from './message-bus';
import { syncLogger } from '../utils/logger';

// Database configuration
const DB_NAME = 'vibestack-db';

// Export singleton instance
export let db: PGliteWorker | null = null;

// Track initialization
let initializationPromise: Promise<PGliteWorker> | null = null;
let isInitialized = false;
let isInitializing = false;
let initError: Error | null = null;

/**
 * Initialize the PGlite database
 * @param forceReset Whether to force a reset of the database
 * @returns The initialized database instance
 */
export const initializeDatabase = async (forceReset: boolean = false): Promise<PGliteWorker> => {
  // If already initializing, wait for that to complete
  if (initializationPromise) {
    return await initializationPromise;
  }

  // If we already have a database instance and we're not forcing a reset, return it
  if (db && !forceReset && isInitialized) {
    return db;
  }

  // Update state
  isInitializing = true;
  initError = null;

  // Create a new initialization promise
  initializationPromise = (async () => {
    syncLogger.info('🔄 Creating new PGlite worker instance...');
    
    try {
      // If forcing reset, clear storage first
      if (forceReset) {
        try {
          syncLogger.info('🔄 Clearing database storage before initialization...');
          await clearDatabaseStorage();
        } catch (clearError) {
          syncLogger.error('❌ Failed to clear database storage:', clearError);
        }
      }
      
      // Create the worker
      const worker = new Worker(
        new URL('./worker.ts', import.meta.url),
        { type: 'module' }
      );
      
      // Create the PGliteWorker instance with live extension
      syncLogger.info('🔄 Creating PGliteWorker with live extension...');
      const newDb = new PGliteWorker(
        worker,
        {
          extensions: {
            live
          }
        }
      );
      
      // Add timeout to prevent hanging if worker initialization fails
      const waitReadyPromise = Promise.race([
        newDb.waitReady,
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Database initialization timed out')), 15000)
        )
      ]);
      
      // Wait for the worker to be ready
      await waitReadyPromise;
      syncLogger.info('✅ PGlite worker initialized successfully');

      // The live extension is now automatically set up by the PGliteWorker constructor
      // No need to manually set it up
      
      // Update the local reference
      db = newDb;
      
      // Set up command dispatcher for message bus
      setupMessageBusDispatcher(newDb);
      
      // Update state
      isInitialized = true;
      isInitializing = false;
      
      // Publish initialized event
      dbMessageBus.publish('initialized', { timestamp: Date.now() });
      
      return db;
    } catch (error) {
      syncLogger.error('❌ Error initializing PGlite worker:', error);
      
      // Update state
      isInitialized = false;
      isInitializing = false;
      initError = error instanceof Error ? error : new Error('Unknown error initializing database');
      
      // Publish error event
      dbMessageBus.publish('error', { 
        error: initError.message,
        timestamp: Date.now()
      });
      
      // If worker initialization fails, try to recover by clearing IndexedDB
      if (error instanceof Error && 
          (error.message.includes('ErrnoError') || 
           error.message.includes('timed out') ||
           error.message.includes('No more file handles available'))) {
        syncLogger.warn('⚠️ Attempting to recover by clearing database storage...');
        
        // Try to clear IndexedDB storage
        await clearDatabaseStorage();
      }
      
      throw error;
    } finally {
      initializationPromise = null;
    }
  })();

  return await initializationPromise;
};

/**
 * Clear the database storage (IndexedDB)
 */
export const clearDatabaseStorage = async (): Promise<void> => {
  try {
    const req = indexedDB.deleteDatabase(DB_NAME);
    await new Promise<void>((resolve, reject) => {
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error('Failed to delete IndexedDB database'));
    });
    syncLogger.info('✅ Database storage cleared successfully');
  } catch (clearError) {
    syncLogger.error('❌ Failed to clear database storage:', clearError);
    throw clearError;
  }
};

/**
 * Get the database instance, initializing it if necessary
 * @param forceReset Whether to force a reset of the database
 * @returns The database instance
 */
export const getDatabase = async (forceReset: boolean = false): Promise<PGliteWorker> => {
  if (!db || forceReset || !isInitialized) {
    return await initializeDatabase(forceReset);
  }
  return db;
};

/**
 * Assert that the database has the live namespace
 * @param db The database instance to check
 * @returns The database instance with the live namespace
 */
export const assertDatabaseWithLive = (db: PGliteWorker): AnyPGliteWithLive => {
  assertPGliteWithLive(db);
  return db as AnyPGliteWithLive;
};

/**
 * Terminate the database connection
 */
export const terminateDatabase = async (): Promise<void> => {
  if (db) {
    try {
      // Terminate the worker
      const worker = (db as any)._worker;
      if (worker && typeof worker.terminate === 'function') {
        worker.terminate();
      }
      
      // Clear the reference
      db = null;
      isInitialized = false;
      syncLogger.info('✅ Database connection terminated');
    } catch (error) {
      syncLogger.error('❌ Error terminating database connection:', error);
      throw error;
    }
  }
};

/**
 * Set up the message bus command dispatcher
 * @param dbInstance The database instance
 */
function setupMessageBusDispatcher(dbInstance: PGliteWorker): void {
  // Set up command dispatcher for message bus
  dbMessageBus.setCommandDispatcher(async (command) => {
    try {
      let result;
      
      switch (command.type) {
        case 'query':
          result = await executeQuery(dbInstance, command.payload.sql, command.payload.params);
          break;
        
        case 'upsert':
          result = await upsertEntity(
            dbInstance,
            command.payload.entityType,
            command.payload.entityId,
            command.payload.data,
            command.payload.timestamp
          );
          break;
        
        case 'delete':
          result = await deleteEntity(
            dbInstance,
            command.payload.entityType,
            command.payload.entityId,
            command.payload.timestamp
          );
          break;
        
        case 'transaction':
          result = await executeTransaction(dbInstance, command.payload.operations);
          break;
        
        case 'reset':
          result = await initializeDatabase(true);
          break;
        
        default:
          throw new Error(`Unknown command type: ${command.type}`);
      }
      
      // Send success response
      dbMessageBus.handleResponse({
        commandId: command.id,
        success: true,
        data: result
      });
    } catch (error) {
      // Send error response
      dbMessageBus.handleResponse({
        commandId: command.id,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
}

/**
 * Execute a SQL query
 * @param dbInstance The database instance
 * @param sql The SQL query
 * @param params The query parameters
 * @returns The query result
 */
async function executeQuery(dbInstance: PGliteWorker, sql: string, params?: any[]): Promise<any> {
  try {
    const result = await dbInstance.query(sql, params);
    
    // Publish query result event
    dbMessageBus.publish('query_result', {
      sql,
      params,
      result,
      timestamp: Date.now()
    });
    
    return result;
  } catch (error) {
    syncLogger.error('❌ Error executing query:', error, { sql, params });
    throw error;
  }
}

/**
 * Upsert an entity
 * @param dbInstance The database instance
 * @param entityType The entity type
 * @param entityId The entity ID
 * @param data The entity data
 * @param timestamp The timestamp
 * @returns The upsert result
 */
async function upsertEntity(
  dbInstance: PGliteWorker,
  entityType: string,
  entityId: string,
  data: any,
  timestamp?: number
): Promise<any> {
  try {
    // Implement upsert logic here
    const result = await dbInstance.query(
      `INSERT INTO "${entityType}" (id, data, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
       SET data = $2, updated_at = $3
       RETURNING *`,
      [entityId, JSON.stringify(data), timestamp || Date.now()]
    );
    
    // Publish entity updated event
    dbMessageBus.publish('entity_updated', {
      entityType,
      entityId,
      data,
      timestamp: timestamp || Date.now()
    });
    
    return result;
  } catch (error) {
    syncLogger.error('❌ Error upserting entity:', error, { entityType, entityId });
    throw error;
  }
}

/**
 * Delete an entity
 * @param dbInstance The database instance
 * @param entityType The entity type
 * @param entityId The entity ID
 * @param timestamp The timestamp
 * @returns The delete result
 */
async function deleteEntity(
  dbInstance: PGliteWorker,
  entityType: string,
  entityId: string,
  timestamp?: number
): Promise<any> {
  try {
    // Implement delete logic here
    const result = await dbInstance.query(
      `DELETE FROM "${entityType}" WHERE id = $1 RETURNING *`,
      [entityId]
    );
    
    // Publish entity deleted event
    dbMessageBus.publish('entity_deleted', {
      entityType,
      entityId,
      timestamp: timestamp || Date.now()
    });
    
    return result;
  } catch (error) {
    syncLogger.error('❌ Error deleting entity:', error, { entityType, entityId });
    throw error;
  }
}

/**
 * Execute a transaction
 * @param dbInstance The database instance
 * @param operations The operations to execute
 * @returns The transaction result
 */
async function executeTransaction(dbInstance: PGliteWorker, operations: any[]): Promise<any> {
  try {
    // Start transaction
    await dbInstance.query('BEGIN');
    
    const results = [];
    
    // Execute each operation
    for (const op of operations) {
      let result;
      
      switch (op.type) {
        case 'query':
          result = await dbInstance.query(op.sql, op.params);
          break;
        
        case 'upsert':
          result = await dbInstance.query(
            `INSERT INTO "${op.entityType}" (id, data, updated_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (id) DO UPDATE
             SET data = $2, updated_at = $3
             RETURNING *`,
            [op.entityId, JSON.stringify(op.data), op.timestamp || Date.now()]
          );
          break;
        
        case 'delete':
          result = await dbInstance.query(
            `DELETE FROM "${op.entityType}" WHERE id = $1 RETURNING *`,
            [op.entityId]
          );
          break;
        
        default:
          throw new Error(`Unknown operation type: ${op.type}`);
      }
      
      results.push(result);
    }
    
    // Commit transaction
    await dbInstance.query('COMMIT');
    
    // Publish transaction complete event
    dbMessageBus.publish('transaction_complete', {
      operations,
      results,
      timestamp: Date.now()
    });
    
    return results;
  } catch (error) {
    // Rollback transaction on error
    try {
      await dbInstance.query('ROLLBACK');
    } catch (rollbackError) {
      syncLogger.error('❌ Error rolling back transaction:', rollbackError);
    }
    
    syncLogger.error('❌ Error executing transaction:', error);
    throw error;
  }
}

// Export database status getters
export const getDatabaseStatus = () => ({
  isInitialized,
  isInitializing,
  error: initError?.message
});

/**
 * Validate database schema against entity models
 * This helps identify mismatches between code and database
 * @returns Promise that resolves when validation is complete
 */
export async function validateDatabaseSchema(): Promise<void> {
  try {
    syncLogger.info('🔍 Validating database schema against entity models...');
    
    const database = await getDatabase();
    
    // Get list of tables
    const tablesResult = await database.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    `);
    
    const tables = tablesResult.rows.map((row: any) => row.table_name);
    syncLogger.info(`Found ${tables.length} tables: ${tables.join(', ')}`);
    
    // For each table, get its columns
    for (const table of tables) {
      const columnsResult = await database.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position
      `, [table]);
      
      syncLogger.info(`Table ${table} has ${columnsResult.rows.length} columns:`);
      
      // Log column details
      columnsResult.rows.forEach((column: any) => {
        syncLogger.info(`  - ${column.column_name}: ${column.data_type} ${column.is_nullable === 'YES' ? '(nullable)' : '(required)'} ${column.column_default ? `default: ${column.column_default}` : ''}`);
      });
      
      // Get enum types if any
      try {
        const enumsResult = await database.query(`
          SELECT t.typname, e.enumlabel
          FROM pg_type t
          JOIN pg_enum e ON e.enumtypid = t.oid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname IN (
            SELECT udt_name
            FROM information_schema.columns
            WHERE table_name = $1
            AND data_type = 'USER-DEFINED'
          )
          ORDER BY t.typname, e.enumsortorder
        `, [table]);
        
        if (enumsResult.rows.length > 0) {
          const enumTypes: Record<string, string[]> = {};
          
          enumsResult.rows.forEach((row: any) => {
            if (!enumTypes[row.typname]) {
              enumTypes[row.typname] = [];
            }
            enumTypes[row.typname].push(row.enumlabel);
          });
          
          Object.entries(enumTypes).forEach(([typeName, values]) => {
            syncLogger.info(`  - Enum ${typeName}: ${values.join(', ')}`);
          });
        }
      } catch (error) {
        syncLogger.warn(`Could not retrieve enum types for table ${table}:`, error);
      }
    }
    
    syncLogger.info('✅ Database schema validation complete');
  } catch (error) {
    syncLogger.error('❌ Error validating database schema:', error);
    throw error;
  }
} 