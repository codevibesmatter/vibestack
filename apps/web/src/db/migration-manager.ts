/**
 * Migration Manager
 * 
 * This module provides functionality to check and apply database migrations
 * during application initialization. It compares server migrations with local
 * client_migration_status table and applies any missing migrations.
 */

import type { PGlite } from '@electric-sql/pglite';
import type { PGliteWorker } from '@electric-sql/pglite/worker';
import { config } from '../config';
import { syncLogger } from '../utils/logger';

// Interface for raw migration data from server
export interface RawMigration {
  migration_name: string;
  timestamp: string;
  schema_version?: string;
  up_queries: string[];
  down_queries: string[];
  client_applied?: boolean;
  created_at?: string;
}

// Migration class with helper methods to handle both naming conventions
export class Migration implements RawMigration {
  migration_name!: string;
  timestamp!: string;
  schema_version?: string;
  up_queries!: string[];
  down_queries!: string[];
  client_applied?: boolean;
  created_at?: string;

  constructor(data: RawMigration) {
    Object.assign(this, data);
  }

  // Helper getters for more readable code
  get name(): string {
    return this.migration_name;
  }
  
  get version(): string | undefined {
    return this.schema_version;
  }
  
  get up(): string[] {
    return this.up_queries;
  }
  
  get down(): string[] {
    return this.down_queries;
  }
}

/**
 * Check if the client_migration_status table exists
 * @param db Database instance
 * @returns Promise that resolves to true if the table exists
 */
export const checkMigrationTableExists = async (db: PGlite | PGliteWorker): Promise<boolean> => {
  try {
    const result = await db.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename = 'client_migration_status'
      ) as exists;
    `);
    return result.rows[0]?.exists || false;
  } catch (error) {
    syncLogger.error('❌ Error checking if migration table exists:', error);
    return false;
  }
};

/**
 * Get the latest applied migration from the client database
 * @param db Database instance
 * @returns Promise that resolves to the latest migration or null if none found
 */
export const getLatestAppliedMigration = async (db: PGlite | PGliteWorker): Promise<{ migration_name: string; timestamp: string } | null> => {
  try {
    const result = await db.query<{ migration_name: string; timestamp: string }>(`
      SELECT "migration_name", "timestamp"
      FROM client_migration_status
      WHERE status = 'completed'
      ORDER BY "timestamp" DESC
      LIMIT 1;
    `);
    return result.rows[0] || null;
  } catch (error) {
    syncLogger.error('❌ Error getting latest applied migration:', error);
    return null;
  }
};

/**
 * Fetch migrations from the server
 * @returns Promise that resolves to an array of migrations or null if fetch fails
 */
export const fetchMigrationsFromServer = async (): Promise<Migration[] | null> => {
  try {
    syncLogger.info('🔄 Fetching migrations from server...');
    
    const apiUrl = `${config.apiUrl}/api/migrations`;
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      mode: 'cors',
      credentials: 'same-origin',
      // Add a timeout to prevent hanging
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}: ${response.statusText}`);
    }
    
    const text = await response.text();
    const data = JSON.parse(text);
    
    // Handle different response formats
    let rawMigrations: RawMigration[];
    
    if (data.success && Array.isArray(data.data)) {
      rawMigrations = data.data;
    } else if (data.success && data.data && Array.isArray(data.data.migrations)) {
      rawMigrations = data.data.migrations;
    } else if (Array.isArray(data.migrations)) {
      rawMigrations = data.migrations;
    } else if (Array.isArray(data)) {
      rawMigrations = data;
    } else {
      throw new Error('Invalid migrations data format');
    }
    
    // Convert raw migrations to Migration objects
    const migrationsArray = rawMigrations.map(rawMigration => new Migration(rawMigration));
    
    syncLogger.info(`✅ Fetched ${migrationsArray.length} migrations from server`);
    return migrationsArray;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      syncLogger.warn('⚠️ Migration fetch timed out');
    } else {
      syncLogger.error('❌ Error fetching migrations from server:', error);
    }
    return null;
  }
};

/**
 * Apply migrations to the database
 * @param db Database instance
 * @param migrations Migrations to apply
 * @returns Promise that resolves to true if all migrations were applied successfully
 */
// Note: The helper functions migrationCreatesStatusTable and modifySqlForSafeCreation have been removed
// as they are no longer needed. We now directly create the migration status table and use
// inline replacements for adding IF NOT EXISTS to SQL statements.

/**
 * Check if the database is empty (no tables exist)
 * This is used to determine if this is the first migration run
 */
const isDatabaseEmpty = async (db: PGlite | PGliteWorker): Promise<boolean> => {
  try {
    // Check if any tables exist in the public schema
    const result = await db.query<{ table_count: number }>(`
      SELECT count(*) as table_count FROM pg_tables 
      WHERE schemaname = 'public'
    `);
    
    // Make sure we have a valid result with the expected structure
    if (result && result.rows && result.rows.length > 0) {
      const count = Number(result.rows[0].table_count);
      return count === 0;
    }
    
    // If we can't determine, assume it's not empty to be safe
    syncLogger.warn('⚠️ Could not determine if database is empty, assuming it is not empty');
    return false;
  } catch (err) {
    syncLogger.warn(`⚠️ Could not check if database is empty: ${err instanceof Error ? err.message : String(err)}`);
    // If we can't check, assume it's not empty to be safe
    return false;
  }
};

export const applyMigrations = async (db: PGlite | PGliteWorker, migrations: Migration[], forceInitial: boolean = false): Promise<boolean> => {
  if (migrations.length === 0) {
    syncLogger.info('✅ No migrations to apply');
    return true;
  }
  
  syncLogger.info(`🔄 Applying ${migrations.length} migrations...`);
  
  // Check if this is the first migration run (database is empty)
  const isEmpty = forceInitial || await isDatabaseEmpty(db);
  const isFirstMigration = isEmpty;
  
  syncLogger.info(isFirstMigration ? '🔄 Empty database detected, applying initial migrations without status checking' : '🔄 Existing database detected, applying pending migrations with status tracking');
  
  // For initial migrations, apply all up commands directly without status checking
  if (isFirstMigration) {
    try {
      // First, execute all CREATE TABLE and CREATE TYPE statements
      // to ensure tables exist before other operations
      syncLogger.info('🔄 First pass: Creating tables and types...');
      for (const migration of migrations) {
        if (!migration.up || migration.up.length === 0) continue;
        
        for (const sql of migration.up) {
          // Only execute CREATE TABLE and CREATE TYPE statements in first pass
          if (sql.includes('CREATE TABLE') || sql.includes('CREATE TYPE')) {
            try {
              await db.exec(sql);
              syncLogger.info(`✅ Created table/type from migration: ${migration.migration_name}`);
            } catch (sqlErr) {
              // Log the error but continue with other statements
              syncLogger.warn(`⚠️ Error creating table/type in initial migration: ${sqlErr instanceof Error ? sqlErr.message : String(sqlErr)}`);
            }
          }
        }
      }
      
      // Now start a transaction for the rest of the operations
      await db.exec('BEGIN');
      
      // Second pass: Apply all other statements
      syncLogger.info('🔄 Second pass: Applying remaining SQL statements...');
      for (const migration of migrations) {
        syncLogger.info(`🔄 Applying migration: ${migration.migration_name}`);
        
        if (!migration.up || migration.up.length === 0) {
          syncLogger.warn(`⚠️ Migration ${migration.migration_name} has no up queries, skipping`);
          continue;
        }
        
        // Apply each query in the migration that isn't a CREATE TABLE or CREATE TYPE
        for (const sql of migration.up) {
          // Skip CREATE TABLE and CREATE TYPE statements as they were handled in first pass
          if (sql.includes('CREATE TABLE') || sql.includes('CREATE TYPE')) {
            continue;
          }
          
          try {
            await db.exec(sql);
          } catch (sqlErr) {
            // Log the error but continue with other statements
            syncLogger.warn(`⚠️ Error executing SQL in initial migration: ${sqlErr instanceof Error ? sqlErr.message : String(sqlErr)}`);
          }
        }
        
        syncLogger.info(`✅ Migration applied: ${migration.migration_name}`);
      }
      
      // Record all migrations as completed after successful transaction
      try {
        // The status table should now exist after running the migrations
        // Record all migrations as completed
        for (const migration of migrations) {
          try {
            await db.query(`
              INSERT INTO client_migration_status (
                "migration_name", 
                "schema_version", 
                "status", 
                "started_at",
                "completed_at", 
                "timestamp",
                "attempts"
              )
              VALUES ($1, $2, 'completed', NOW(), NOW(), $3, 1)
              ON CONFLICT ("migration_name") DO NOTHING
            `, [
              migration.migration_name, 
              migration.schema_version || '0.0.0', 
              migration.timestamp
            ]);
          } catch (err) {
            syncLogger.warn(`⚠️ Could not record initial migration completion for ${migration.migration_name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        syncLogger.info('✅ Recorded all initial migrations as completed');
      } catch (err) {
        syncLogger.warn(`⚠️ Error recording initial migrations: ${err instanceof Error ? err.message : String(err)}`);
      }
      
      // Commit the transaction
      await db.exec('COMMIT');
      syncLogger.info('✅ All initial migrations applied successfully');
      return true;
    } catch (err) {
      // Rollback the transaction on any error
      try {
        await db.exec('ROLLBACK');
      } catch (rollbackErr) {
        syncLogger.error('❌ Error rolling back transaction:', rollbackErr);
      }
      
      syncLogger.error('❌ Error applying initial migrations:', err);
      return false;
    }
  } else {
    // For subsequent migrations, use standard status checking
    try {
      await db.exec('BEGIN');
      
      for (const migration of migrations) {
        syncLogger.info(`🔄 Applying migration: ${migration.migration_name}`);
        
        if (!migration.up || migration.up.length === 0) {
          syncLogger.warn(`⚠️ Migration ${migration.migration_name} has no up queries, skipping`);
          continue;
        }
        
        // Mark migration as in progress
        try {
          await db.query(`
            INSERT INTO client_migration_status (
              "migration_name", 
              "schema_version", 
              "status", 
              "started_at", 
              "timestamp"
            )
            VALUES ($1, $2, 'in_progress', NOW(), $3)
            ON CONFLICT ("migration_name") DO UPDATE
            SET "status" = 'in_progress',
                "started_at" = NOW(),
                "attempts" = client_migration_status."attempts" + 1
          `, [
            migration.migration_name, 
            migration.schema_version || '0.0.0', 
            migration.timestamp
          ]);
        } catch (err) {
          // If this fails, just log and continue
          syncLogger.warn(`⚠️ Could not update migration status for ${migration.migration_name}: ${err instanceof Error ? err.message : String(err)}`);
        }
        
        // Apply each query in the migration
        try {
          // Apply SQL statements with safety checks
          for (const sql of migration.up) {
            // Skip any statements that try to create the client_migration_status table or enum
            if ((sql.includes('CREATE TABLE') && sql.includes('client_migration_status')) ||
                (sql.includes('CREATE TYPE') && sql.includes('client_migration_status_status_enum'))) {
              syncLogger.info(`✅ Skipping creation of client_migration_status table/enum (already exists)`);
              continue;
            }
          
            // Modify SQL to use IF NOT EXISTS where appropriate
            let modifiedSql = sql;
            if (sql.includes('CREATE TABLE')) {
              // Add IF NOT EXISTS to all table creations
              modifiedSql = sql.replace(/CREATE TABLE "([^"]+)"/g, 'CREATE TABLE IF NOT EXISTS "$1"');
            } else if (sql.includes('CREATE TYPE')) {
              // Add IF NOT EXISTS to all type creations
              modifiedSql = sql.replace(/CREATE TYPE "([^"]+)"\."([^"]+)"/g, 'CREATE TYPE IF NOT EXISTS "$1"."$2"');
            } else if (sql.includes('CREATE INDEX')) {
              // Add IF NOT EXISTS to all index creations
              modifiedSql = sql.replace(/CREATE INDEX "([^"]+)"/g, 'CREATE INDEX IF NOT EXISTS "$1"');
            }
            
            // Execute the (potentially modified) SQL
            await db.exec(modifiedSql);
          }
          
          // Update the status table
          try {
            await db.query(`
              UPDATE client_migration_status 
              SET "status" = 'completed',
                  "completed_at" = NOW()
              WHERE "migration_name" = $1
            `, [migration.migration_name]);
          } catch (err) {
            // If this fails, just log and continue
            syncLogger.warn(`⚠️ Could not mark migration as completed: ${migration.migration_name} - ${err instanceof Error ? err.message : String(err)}`);
          }
          
          syncLogger.info(`✅ Migration applied: ${migration.migration_name}`);
        } catch (err) {
          // Update the status table to mark as failed
          try {
            await db.query(`
              UPDATE client_migration_status 
              SET "status" = 'failed',
                  "completed_at" = NOW(),
                  "error_message" = $1
              WHERE "migration_name" = $2
            `, [err instanceof Error ? err.message : String(err), migration.migration_name]);
          } catch (updateErr) {
            // If this fails, just log and continue with the error
            syncLogger.warn(`⚠️ Could not record migration failure for ${migration.migration_name}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`);
          }
          
          syncLogger.error(`❌ Failed to apply migration ${migration.migration_name}:`, err);
          throw err;
        }
      }
      
      // Commit the transaction
      await db.exec('COMMIT');
      syncLogger.info('✅ All migrations applied successfully');
      return true;
    } catch (err) {
      // Rollback the transaction on any error
      try {
        await db.exec('ROLLBACK');
      } catch (rollbackErr) {
        syncLogger.error('❌ Error rolling back transaction:', rollbackErr);
      }
      
      syncLogger.error('❌ Error applying migrations:', err);
      return false;
    }
  }
};

/**
 * Check and apply migrations
 * This is the main function that should be called during application initialization
 * @param db Database instance
 * @returns Promise that resolves to true if migrations were checked and applied successfully
 */
export const checkAndApplyMigrations = async (db: PGlite | PGliteWorker, forceInitialMigration: boolean = false): Promise<boolean> => {
  try {
    syncLogger.info('🔄 Checking for database migrations...');
    
    // Check if migration table exists
    const tableExists = await checkMigrationTableExists(db);
    
    // Check if database is empty
    const isEmpty = await isDatabaseEmpty(db);
    
    // Try to fetch migrations from server
    const serverMigrations = await fetchMigrationsFromServer();
    
    // If we can't fetch migrations and we're in a fresh database, we can't proceed
    if (!serverMigrations && !tableExists) {
      syncLogger.warn('⚠️ Cannot fetch migrations from server and no local migration table exists');
      syncLogger.warn('⚠️ Continuing without migrations, but this may cause issues');
      return false;
    }
    
    // If we can't fetch migrations but have an existing database, we can continue in offline mode
    if (!serverMigrations && tableExists) {
      syncLogger.warn('⚠️ Cannot fetch migrations from server, but local migration table exists');
      syncLogger.warn('⚠️ Continuing in offline mode with existing schema');
      return true;
    }
    
    // If we have migrations from server
    if (serverMigrations) {
      // Sort migrations by timestamp
      const sortedMigrations = [...serverMigrations].sort((a, b) => {
        const aTime = parseInt(a.timestamp);
        const bTime = parseInt(b.timestamp);
        return aTime - bTime;
      });
      
      // If migration table doesn't exist or forceInitialMigration is true, apply all migrations as initial
      if (!tableExists || isEmpty || forceInitialMigration) {
        syncLogger.info(forceInitialMigration 
          ? '🔄 Forcing initial migration mode, applying all migrations without status checking' 
          : '🔄 No migration table found or empty database, applying all migrations as initial');
        return await applyMigrations(db, sortedMigrations, true); // true = force initial migration mode
      }
      
      // Get latest applied migration
      const latestMigration = await getLatestAppliedMigration(db);
      
      if (!latestMigration) {
        syncLogger.info('🔄 No migrations applied yet, applying all migrations');
        return await applyMigrations(db, sortedMigrations);
      }
      
      // Find migrations newer than the latest applied one
      const latestTimestamp = parseInt(latestMigration.timestamp);
      const newMigrations = sortedMigrations.filter(m => parseInt(m.timestamp) > latestTimestamp);
      
      if (newMigrations.length === 0) {
        syncLogger.info('✅ Database schema is up to date');
        return true;
      }
      
      syncLogger.info(`🔄 Found ${newMigrations.length} new migrations to apply`);
      return await applyMigrations(db, newMigrations);
    }
    
    return false;
  } catch (error) {
    syncLogger.error('❌ Error checking and applying migrations:', error);
    return false;
  }
};

/**
 * Force a full initial migration
 * This function will apply all migrations as if it were the first run,
 * ignoring any existing migration status
 * @param db Database instance
 * @returns Promise that resolves to true if migrations were applied successfully
 */
export const forceInitialMigration = async (db: PGlite | PGliteWorker): Promise<boolean> => {
  syncLogger.info('🔄 Forcing initial migration mode...');
  return await checkAndApplyMigrations(db, true);
};
