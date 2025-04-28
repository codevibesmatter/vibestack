/**
 * Database Storage Utilities
 * 
 * This file provides utility functions for database operations.
 */

import { getDatabase, clearDatabaseStorage, Results } from './db';

/**
 * Reset the database by clearing all data
 */
export async function resetDatabase(): Promise<boolean> {
  try {
    console.log('Resetting database...');
    const result = await clearDatabaseStorage();
    console.log('Database reset result:', result);
    return result;
  } catch (error) {
    console.error('Error resetting database:', error);
    return false;
  }
}

/**
 * Alternative name for resetDatabase
 */
export const resetDB = resetDatabase;

/**
 * Get database statistics
 */
export async function getDatabaseStats(): Promise<Record<string, number>> {
  try {
    const db = await getDatabase();
    
    // Get table counts
    const userCount = await getTableCount(db, 'users');
    const projectCount = await getTableCount(db, 'projects');
    const taskCount = await getTableCount(db, 'tasks');
    const commentCount = await getTableCount(db, 'comments');
    
    return {
      users: userCount,
      projects: projectCount,
      tasks: taskCount,
      comments: commentCount,
      total: userCount + projectCount + taskCount + commentCount
    };
  } catch (error) {
    console.error('Error getting database stats:', error);
    return {
      users: 0,
      projects: 0,
      tasks: 0,
      comments: 0,
      total: 0
    };
  }
}

/**
 * Helper to get count of records in a table
 */
async function getTableCount(db: any, tableName: string): Promise<number> {
  try {
    const result = await db.query(`SELECT COUNT(*) as count FROM ${tableName}`);
    // Handle PGlite results type properly
    const resultArray = result as unknown as Array<{count: number}>;
    return resultArray[0]?.count || 0;
  } catch (error) {
    console.error(`Error getting count for ${tableName}:`, error);
    return 0;
  }
}

/**
 * Load data from server
 */
export async function loadServerData(endpoint: string): Promise<any> {
  try {
    console.log(`Loading data from server: ${endpoint}`);
    const response = await fetch(`/api/${endpoint}`);
    
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error loading server data:', error);
    throw error;
  }
}

/**
 * Clear all data from the database
 */
export async function clearAllData(): Promise<boolean> {
  try {
    console.log('Clearing all data...');
    const db = await getDatabase();
    
    // Delete all data from tables in reverse order of relationships
    await db.query('DELETE FROM comments');
    await db.query('DELETE FROM tasks');
    await db.query('DELETE FROM projects');
    await db.query('DELETE FROM users');
    await db.query('DELETE FROM sync_metadata');
    
    console.log('All data cleared successfully');
    return true;
  } catch (error) {
    console.error('Error clearing data:', error);
    return false;
  }
}

/**
 * Drop all tables and types for a clean database state
 */
export async function dropAllTables(): Promise<boolean> {
  try {
    console.log('Dropping all tables and types with CASCADE...');
    const db = await getDatabase();

    // First, try to get all tables from the database
    try {
      console.log('Fetching all existing tables...');
      const tableResult = await db.query<{tablename: string}>(`
        SELECT tablename FROM pg_tables 
        WHERE schemaname = 'public'
      `);
      
      if (tableResult.rows.length > 0) {
        console.log(`Found ${tableResult.rows.length} tables to drop`);
        
        // Drop all tables found in the database
        for (const row of tableResult.rows) {
          try {
            await db.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
            console.log(`Dropped table: ${row.tablename}`);
          } catch (dropError) {
            console.warn(`Warning: Could not drop table ${row.tablename}:`, dropError);
          }
        }
      }
    } catch (tableError) {
      console.warn('Error fetching tables:', tableError);
    }

    // Then, try to get all custom types from the database
    try {
      console.log('Fetching all existing enum types...');
      const typeResult = await db.query<{typname: string}>(`
        SELECT typname FROM pg_type 
        JOIN pg_catalog.pg_namespace ON pg_namespace.oid = pg_type.typnamespace
        WHERE typtype = 'e' AND nspname = 'public'
      `);
      
      if (typeResult.rows.length > 0) {
        console.log(`Found ${typeResult.rows.length} enum types to drop`);
        
        // Drop all types found in the database
        for (const row of typeResult.rows) {
          try {
            await db.query(`DROP TYPE IF EXISTS "public"."${row.typname}" CASCADE`);
            console.log(`Dropped enum type: ${row.typname}`);
          } catch (dropError) {
            console.warn(`Warning: Could not drop type ${row.typname}:`, dropError);
          }
        }
      }
    } catch (typeError) {
      console.warn('Error fetching enum types:', typeError);
    }

    // As a fallback, manually drop known tables in reverse order of dependencies
    const knownTables = [
      'comments',
      'task_dependencies',
      'tasks',
      'project_members',  // Added project_members table that was missing before
      'projects',
      'users',
      'sync_metadata',
      'schema_version',
      'client_migration_status',
      'local_changes',
      'items'
    ];

    console.log('Dropping known tables as fallback...');
    for (const table of knownTables) {
      try {
        await db.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      } catch (error) {
        console.warn(`Warning: Could not drop table ${table}:`, error);
      }
    }

    // As a fallback, manually drop known types
    const knownTypes = [
      'client_migration_status_status_enum',
      'tasks_status_enum',
      'tasks_priority_enum',
      'users_role_enum',
      'projects_status_enum'
    ];

    console.log('Dropping known enum types as fallback...');
    for (const type of knownTypes) {
      try {
        await db.query(`DROP TYPE IF EXISTS "public"."${type}" CASCADE`);
      } catch (error) {
        console.warn(`Warning: Could not drop type ${type}:`, error);
      }
    }

    console.log('All tables and custom types dropped successfully');
    return true;
  } catch (error) {
    console.error('Error in dropAllTables():', error);
    return false;
  }
}

/**
 * Reset the entire database schema and data
 * This is a more complete reset than just dropping tables
 */
export async function resetEntireDatabase(): Promise<boolean> {
  try {
    console.log('Performing complete database reset...');
    const db = await getDatabase();
    
    // First drop all tables and types
    const dropResult = await dropAllTables();
    if (!dropResult) {
      console.error('Failed to drop tables, continuing with reset attempt...');
    }
    
    // For a truly clean slate, also truncate migration tracking tables
    try {
      // Ensure these tables don't exist or are empty
      await db.query('DROP TABLE IF EXISTS schema_version CASCADE');
      await db.query('DROP TABLE IF EXISTS client_migration_status CASCADE');
    } catch (truncateError) {
      console.warn('Error clearing migration tables:', truncateError);
    }
    
    console.log('Database schema completely reset, migrations will run from scratch');
    return true;
  } catch (error) {
    console.error('Error resetting entire database:', error);
    return false;
  }
} 