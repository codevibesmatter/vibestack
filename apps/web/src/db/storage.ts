import { PGlite } from '@electric-sql/pglite';
import { PGliteWorker } from '@electric-sql/pglite/worker';
import { db, getDatabase } from './core';
import { ensureDB } from './types';
import { config } from '../config';

/**
 * Clear all data from tables
 * @param database The database instance to clear
 * @private Internal function used by loadServerData
 */
export const clearAllData = async (database?: PGlite | PGliteWorker): Promise<void> => {
  // Use ensureDB to handle null case and provide proper typing
  const dbInstance = database || ensureDB(db);
  
  try {
    console.log('🔄 Clearing all data from tables...');
    
    // Get all table names
    const result = await dbInstance.query<{ tablename: string }>(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);

    if (result.rows.length === 0) {
      console.log('ℹ️ No tables found to clear');
      return;
    }

    // Start a transaction
    await dbInstance.exec('BEGIN');

    try {
      // Disable foreign key checks temporarily
      await dbInstance.exec('SET CONSTRAINTS ALL DEFERRED;');

      // First attempt: Try to truncate all tables with CASCADE
      for (const { tablename } of result.rows) {
        try {
          await dbInstance.exec(`TRUNCATE TABLE "${tablename}" CASCADE;`);
          console.log(`✅ Truncated table: ${tablename}`);
        } catch (err) {
          console.warn(`⚠️ Could not truncate ${tablename}, will try DELETE: ${err}`);
        }
      }

      // Second attempt: For any tables that couldn't be truncated, use DELETE
      for (const { tablename } of result.rows) {
        try {
          // Check if table still has data
          const countResult = await dbInstance.query<{ count: number }>(`
            SELECT COUNT(*) as count FROM "${tablename}";
          `);
          
          if (countResult.rows[0]?.count > 0) {
            console.log(`🔄 Table ${tablename} still has ${countResult.rows[0].count} rows, using DELETE`);
            await dbInstance.exec(`DELETE FROM "${tablename}";`);
            console.log(`✅ Deleted all rows from table: ${tablename}`);
          }
        } catch (err) {
          console.error(`❌ Failed to clear table ${tablename}: ${err}`);
        }
      }

      // Re-enable foreign key checks
      await dbInstance.exec('SET CONSTRAINTS ALL IMMEDIATE;');

      // Commit the transaction
      await dbInstance.exec('COMMIT');
      console.log('✅ All data cleared successfully');
    } catch (error) {
      // Rollback on error
      console.error('❌ Error during data clearing, rolling back:', error);
      await dbInstance.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('❌ Error clearing data:', error);
    throw error;
  }
};

/**
 * Reset the database by loading data from the server
 * @returns The database instance
 */
export const resetDatabase = async (): Promise<PGliteWorker> => {
  // Get the database instance, initializing it if necessary
  const database = await getDatabase(true);
  
  // Load data from server (which includes clearing existing data)
  await loadServerData(database);
  
  return database;
};

/**
 * Get database statistics
 * @returns Database statistics
 */
export const getDatabaseStats = async (): Promise<{
  tableCount: number;
  totalRows: number;
  tableStats: Array<{ table: string; rowCount: number }>;
}> => {
  const database = await getDatabase();
  
  try {
    // Get table names
    const tablesResult = await database.query<{ tablename: string }>(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);
    
    const tableStats = [];
    let totalRows = 0;
    
    // Get row count for each table
    for (const { tablename } of tablesResult.rows) {
      const countResult = await database.query<{ count: number }>(`
        SELECT COUNT(*) as count FROM "${tablename}";
      `);
      
      const rowCount = countResult.rows[0]?.count || 0;
      totalRows += rowCount;
      
      tableStats.push({
        table: tablename,
        rowCount
      });
    }
    
    return {
      tableCount: tablesResult.rows.length,
      totalRows,
      tableStats
    };
  } catch (error) {
    console.error('❌ Error getting database stats:', error);
    throw error;
  }
};

/**
 * Load data from the server API and insert it into the local database
 * @param database The database instance to load data into
 * @returns Result of the operation
 */
export const loadServerData = async (database?: PGlite | PGliteWorker): Promise<{ 
  success: boolean; 
  error?: string;
}> => {
  // Use ensureDB to handle null case and provide proper typing
  const dbInstance = database || ensureDB(db);
  
  try {
    console.log('🔄 Loading data from server...');
    
    // Fetch data from server API
    const response = await fetch(`${config.apiUrl}/api/db/data`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      mode: 'cors',
      credentials: 'same-origin',
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Server returned ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.error?.message || 'Failed to fetch data from server');
    }
    
    // Begin transaction
    await dbInstance.exec('BEGIN');
    
    try {
      // Clear existing data first
      await clearAllData(dbInstance);
      
      // Insert data for each table
      for (const tableData of data.data) {
        const { tableName, rows } = tableData;
        
        if (!rows || rows.length === 0) {
          console.log(`ℹ️ No data to insert for table ${tableName}`);
          continue;
        }
        
        console.log(`🔄 Inserting ${rows.length} rows into ${tableName}...`);
        
        // Get column names from the first row
        const columns = Object.keys(rows[0]);
        
        // Insert each row
        for (const row of rows) {
          const columnList = columns.join('", "');
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
          const values = columns.map(col => row[col]);
          
          await dbInstance.query(
            `INSERT INTO "${tableName}" ("${columnList}") VALUES (${placeholders})`,
            values
          );
        }
      }
      
      // Commit transaction
      await dbInstance.exec('COMMIT');
      console.log('✅ Server data loaded successfully');
      
      return { success: true };
    } catch (error) {
      // Rollback transaction on error
      await dbInstance.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('❌ Error loading server data:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error loading server data'
    };
  }
};

/**
 * Drop all tables and enum types in the database
 * @param database The database instance
 * @returns Promise that resolves when all tables and enums are dropped
 */
export const dropAllTables = async (database?: PGlite | PGliteWorker): Promise<void> => {
  // Use ensureDB to handle null case and provide proper typing
  const dbInstance = database || ensureDB(db);
  
  try {
    console.log('🔄 Dropping all tables and enum types from database...');
    
    // Get all table names
    const tableResult = await dbInstance.query<{ tablename: string }>(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);

    // Get all enum types
    const enumResult = await dbInstance.query<{ typname: string }>(`
      SELECT t.typname
      FROM pg_type t 
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'e' AND n.nspname = 'public';
    `);

    if (tableResult.rows.length === 0 && enumResult.rows.length === 0) {
      console.log('ℹ️ No tables or enum types found to drop');
      return;
    }

    // Start a transaction
    await dbInstance.exec('BEGIN');

    try {
      // Disable foreign key checks temporarily
      await dbInstance.exec('SET CONSTRAINTS ALL DEFERRED;');

      // Drop all tables with CASCADE
      for (const { tablename } of tableResult.rows) {
        try {
          await dbInstance.exec(`DROP TABLE IF EXISTS "${tablename}" CASCADE;`);
          console.log(`✅ Dropped table: ${tablename}`);
        } catch (err) {
          console.error(`❌ Failed to drop table ${tablename}: ${err}`);
          // Continue with other tables instead of throwing
          console.log(`⚠️ Continuing with other tables...`);
        }
      }

      // Drop all enum types
      // We need to do this after tables because tables might use these enum types
      if (enumResult.rows.length > 0) {
        console.log('🔄 Dropping enum types...');
        for (const { typname } of enumResult.rows) {
          try {
            // Drop the enum type
            await dbInstance.exec(`DROP TYPE IF EXISTS "${typname}" CASCADE;`);
            console.log(`✅ Dropped enum type: ${typname}`);
          } catch (err) {
            console.error(`❌ Failed to drop enum type ${typname}: ${err}`);
            // Continue with other enums instead of throwing
            console.log(`⚠️ Continuing with other enum types...`);
          }
        }
      } else {
        console.log('ℹ️ No enum types found to drop');
      }

      // Commit the transaction
      await dbInstance.exec('COMMIT');
      console.log('✅ All tables and enum types dropped successfully');
    } catch (error) {
      // Rollback on error
      console.error('❌ Error during database cleanup, rolling back:', error);
      await dbInstance.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('❌ Error dropping database objects:', error);
    throw error;
  }
};

/**
 * Alias for resetDatabase to maintain backward compatibility
 * @returns The database instance
 */
export const resetDB = resetDatabase; 