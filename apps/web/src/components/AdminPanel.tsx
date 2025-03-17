import React, { useState, useEffect, useMemo } from 'react';
import { loadServerData, clearAllData, dropAllTables, fetchMigrationsFromServer, Migration } from '../db';
import { resetLSN, disconnectFromSyncServer, connectToSyncServer, isSyncConnected, onSyncEvent, offSyncEvent } from '../sync';
import { config } from '../config';
import type { PGlite } from '@electric-sql/pglite';
import type { ClientMigration } from '@repo/typeorm/server-entities';
import { createColumnHelper } from '@tanstack/react-table';
import type { Table, Row, CellContext } from '@tanstack/react-table';
import { MigrationsTable, type Migration } from './data-table/MigrationsTable';
import { ColumnDef } from '@tanstack/react-table';
import { mutate } from 'swr';

interface TableSchema {
  tableName: string;
  rowCount: number;
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    default?: string;
  }[];
  constraints: {
    name: string;
    type: string;
    definition: string;
  }[];
  enums?: {
    name: string;
    values: string[];
  }[];
}

interface AdminPanelProps {
  db: PGlite;
}

interface TableRow {
  tablename: string;
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
}

interface ConstraintRow {
  constraint_name: string;
  constraint_definition: string;
  constraint_type: string;
}

interface EnumRow {
  enum_name: string;
  enum_values: string[];
}

export function AdminPanel({ db }: AdminPanelProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [schema, setSchema] = useState<TableSchema[]>([]);
  const [migrations, setMigrations] = useState<Migration[]>([]);
  const [selectedMigrations, setSelectedMigrations] = useState<Set<string>>(new Set());
  const [tableToDropName, setTableToDropName] = useState<string>('');
  const [showTableDropdown, setShowTableDropdown] = useState(false);
  const [isOfflineMode, setIsOfflineMode] = useState(false);

  const columnHelper = createColumnHelper<Migration>();
  
  const fetchSchema = async () => {
    try {
      // Get all user tables
      const tablesResult = await db.query<TableRow>(`
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public'
        ORDER BY tablename;
      `);

      // Get all enum types
      const enumsResult = await db.query<EnumRow>(`
        SELECT 
          t.typname as enum_name,
          array_agg(e.enumlabel ORDER BY e.enumsortorder) as enum_values
        FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
        GROUP BY t.typname
        ORDER BY t.typname;
      `);

      const enums = enumsResult.rows.map(row => ({
        name: row.enum_name,
        values: row.enum_values
      }));

      const tables: TableSchema[] = [];

      for (const { tablename } of tablesResult.rows) {
        // Get row count for this table
        const countResult = await db.query<{ count: number }>(`
          SELECT COUNT(*) as count FROM "${tablename}";
        `);
        const rowCount = countResult.rows[0]?.count || 0;
        
        // Get columns for this table
        const columnsResult = await db.query<ColumnRow>(`
          SELECT 
            column_name,
            data_type,
            udt_name,
            is_nullable,
            column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
          ORDER BY ordinal_position;
        `, [tablename]);

        // Get constraints for this table
        const constraintsResult = await db.query<ConstraintRow>(`
          SELECT
            conname as constraint_name,
            pg_get_constraintdef(c.oid) as constraint_definition,
            CASE contype
              WHEN 'p' THEN 'PRIMARY KEY'
              WHEN 'f' THEN 'FOREIGN KEY'
              WHEN 'u' THEN 'UNIQUE'
              WHEN 'c' THEN 'CHECK'
              ELSE contype::text
            END as constraint_type
          FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE conrelid = $1::regclass
          ORDER BY contype;
        `, [`public.${tablename}`]);

        tables.push({
          tableName: tablename,
          rowCount: rowCount,
          columns: columnsResult.rows.map(col => {
            // Check if the column type is an enum
            const enumType = enums.find(e => e.name === col.udt_name);
            return {
              name: col.column_name,
              type: enumType ? `ENUM(${enumType.values.join(', ')})` : col.data_type,
              nullable: col.is_nullable === 'YES',
              default: col.column_default ?? undefined
            };
          }),
          constraints: constraintsResult.rows.map(con => ({
            name: con.constraint_name,
            type: con.constraint_type,
            definition: con.constraint_definition
          })),
          enums: enums
        });
      }

      setSchema(tables);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch schema');
    }
  };

  const fetchMigrations = async () => {
    try {
      setIsLoading(true);
      setError(null);
      
      // Use the shared migration manager function to fetch migrations
      const serverMigrations = await fetchMigrationsFromServer();
      
      if (!serverMigrations) {
        throw new Error('Failed to fetch migrations from server');
      }
      
      // Check for applied migrations in the database
      try {
        // Check if client_migration_status table exists
        const tableExistsResult = await db.query<{ exists: boolean }>(`
          SELECT EXISTS (
            SELECT FROM pg_tables 
            WHERE schemaname = 'public' 
            AND tablename = 'client_migration_status'
          ) as exists;
        `);
        
        const tableExists = tableExistsResult.rows[0]?.exists || false;
        
        if (tableExists) {
          // Get applied migrations from the database
          const appliedMigrationsResult = await db.query<{ migrationName: string }>(`
            SELECT "migration_name" as "migration_name" FROM client_migration_status
            WHERE status = 'completed'
          `);
          
          const appliedMigrations = new Set(
            appliedMigrationsResult.rows.map(row => row.migrationName)
          );
          
          // Mark migrations as applied in the UI
          serverMigrations.forEach(migration => {
            migration.clientApplied = appliedMigrations.has(migration.migrationName);
          });
        }
      } catch (dbErr) {
        console.warn('Error checking applied migrations:', dbErr);
        // Continue without applied status
      }
      
      // Process migrations data
      const migrationsWithIds = serverMigrations.map((migration: Migration) => ({
        ...migration,
        id: migration.migrationName, // Use migrationName as the unique ID
      }));
      
      setMigrations(migrationsWithIds);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch migrations');
    } finally {
      setIsLoading(false);
    }
  };

  const handleStatusChange = async (migrationName: string, newStatus: boolean) => {
    try {
      setIsLoading(true);
      
      // Get the migration details
      const migration = migrations.find(m => m.migrationName === migrationName);
      
      if (!migration) {
        throw new Error(`Migration ${migrationName} not found`);
      }
      
      if (newStatus) {
        // Mark as completed in client_migration_status table
        try {
          await db.query(`
            INSERT INTO client_migration_status (
              "migration_name", 
              "schema_version", 
              "status", 
              "started_at",
              "completed_at", 
              "timestamp"
            )
            VALUES ($1, $2, 'completed', NOW(), NOW(), $3)
            ON CONFLICT ("migration_name") DO UPDATE
            SET "status" = 'completed',
                "completed_at" = NOW(),
                "error_message" = NULL
          `, [
            migration.migrationName, 
            migration.schemaVersion || '0.0.0', 
            migration.timestamp
          ]);
        } catch (err) {
          // If the table doesn't exist yet, create it
          if (err instanceof Error && err.message.includes('relation "client_migration_status" does not exist')) {
            await db.exec(`
              CREATE TABLE IF NOT EXISTS client_migration_status (
                "migration_name" TEXT PRIMARY KEY,
                "schema_version" TEXT NOT NULL,
                "status" TEXT NOT NULL,
                "started_at" TIMESTAMP WITH TIME ZONE,
                "completed_at" TIMESTAMP WITH TIME ZONE,
                "error_message" TEXT,
                "attempts" INTEGER DEFAULT 0,
                "timestamp" BIGINT NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
              );
            `);
            
            // Try again
            await db.query(`
              INSERT INTO client_migration_status (
                "migration_name", 
                "schema_version", 
                "status", 
                "started_at",
                "completed_at", 
                "timestamp"
              )
              VALUES ($1, $2, 'completed', NOW(), NOW(), $3)
            `, [
              migration.migrationName, 
              migration.schemaVersion || '0.0.0', 
              migration.timestamp
            ]);
          } else {
            throw err;
          }
        }
      } else {
        // Delete from client_migration_status table
        try {
          await db.query(`
            DELETE FROM client_migration_status
            WHERE "migration_name" = $1
          `, [migration.migrationName]);
        } catch (err) {
          // If the table doesn't exist, there's nothing to delete
          if (!(err instanceof Error && err.message.includes('relation "client_migration_status" does not exist'))) {
            throw err;
          }
        }
      }
      
      await fetchMigrations(); // Refresh the list
      setSuccess(`Migration status updated successfully`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update migration status');
    } finally {
      setIsLoading(false);
    }
  };

  const migrationColumns = useMemo(() => [
    {
      id: 'select',
      header: ({ table }: { table: Table<Migration> }) => (
        <div className="px-1">
          <input
            type="checkbox"
            checked={table.getIsAllRowsSelected()}
            onChange={table.getToggleAllRowsSelectedHandler()}
            className="w-4 h-4 bg-[#1a1a1a] border-[#404040] text-blue-500 focus:ring-blue-500 focus:ring-offset-0 rounded"
          />
        </div>
      ),
      cell: ({ row }: { row: Row<Migration> }) => (
        <div className="px-1">
          <input
            type="checkbox"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            className="w-4 h-4 bg-[#1a1a1a] border-[#404040] text-blue-500 focus:ring-blue-500 focus:ring-offset-0 rounded"
          />
        </div>
      ),
      size: 40
    } as ColumnDef<Migration, any>,
    {
      accessorKey: 'migration_name',
      header: 'Migration Name',
      size: 300,
    } as ColumnDef<Migration, any>,
    {
      accessorKey: 'timestamp',
      header: 'Timestamp',
      size: 150,
      cell: (info) => {
        const value = info.getValue();
        if (!value) return 'N/A';
        try {
          return new Date(parseInt(value as string)).toLocaleString();
        } catch (e) {
          return String(value);
        }
      },
    } as ColumnDef<Migration, any>,
    {
      accessorKey: 'createdAt',
      header: 'Created At',
      size: 200,
      cell: (info) => {
        const value = info.getValue();
        if (!value) return 'N/A';
        try {
          return new Date(value as string).toLocaleString();
        } catch (e) {
          return String(value);
        }
      },
    } as ColumnDef<Migration, any>,
    {
      accessorKey: 'clientApplied',
      header: 'Applied',
      size: 100,
      cell: (info) => {
        const value = info.getValue();
        return (
          <span className={value ? 'text-green-500' : 'text-yellow-500'}>
            {value ? 'Yes' : 'No'}
          </span>
        );
      },
    } as ColumnDef<Migration, any>,
  ], []);

  // Fetch schema and migrations on mount
  useEffect(() => {
    if (db) {
      fetchSchema();
      fetchMigrations();
    }
  }, [db]);

  useEffect(() => {
    // Subscribe to sync connection state changes
    const handleStatusChange = (state: { isConnected: boolean }) => {
      setIsOfflineMode(!state.isConnected);
    };
    
    onSyncEvent('status_changed', handleStatusChange);
    
    // Set initial state
    setIsOfflineMode(!isSyncConnected());
    
    return () => {
      offSyncEvent('status_changed', handleStatusChange);
    };
  }, []);

  const toggleOfflineMode = async () => {
    try {
      if (isOfflineMode) {
        // Reconnect to sync server
        const success = await connectToSyncServer(config.wsUrl);
        if (!success) {
          throw new Error('Failed to reconnect to sync server');
        }
        setSuccess('Reconnected to sync server');
      } else {
        // Disconnect from sync server
        disconnectFromSyncServer('Manual offline mode');
        setSuccess('Disconnected from sync server - offline mode enabled');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle offline mode');
    }
  };

  const handleRunSelected = async () => {
    if (selectedMigrations.size === 0) return;
    
    setIsLoading(true);
    setError(null);
    
    const migrationsToRun = migrations.filter(m => 
      selectedMigrations.has(m.migrationName)
    );
    
    // Start a transaction
    try {
      await db.exec('BEGIN');
      
      for (const migration of migrationsToRun) {
        if (!migration.upQueries || migration.upQueries.length === 0) {
          continue;
        }
        
        for (const sql of migration.upQueries) {
          try {
            await db.exec(sql);
          } catch (err) {
            throw new Error(`Failed to execute SQL for ${migration.migrationName}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        
        // Mark migration as applied in the client_migration_status table
        try {
          await db.query(`
            INSERT INTO client_migration_status (
              "migration_name", 
              "schema_version", 
              "status", 
              "started_at",
              "completed_at", 
              "timestamp"
            )
            VALUES ($1, $2, 'completed', NOW(), NOW(), $3)
            ON CONFLICT ("migration_name") DO UPDATE
            SET "status" = 'completed',
                "completed_at" = NOW(),
                "error_message" = NULL
          `, [
            migration.migrationName, 
            migration.schemaVersion || '0.0.0', 
            migration.timestamp
          ]);
        } catch (err) {
          // If the table doesn't exist yet, create it
          if (err instanceof Error && err.message.includes('relation "client_migration_status" does not exist')) {
            await db.exec(`
              CREATE TABLE IF NOT EXISTS client_migration_status (
                "migration_name" TEXT PRIMARY KEY,
                "schema_version" TEXT NOT NULL,
                "status" TEXT NOT NULL,
                "started_at" TIMESTAMP WITH TIME ZONE,
                "completed_at" TIMESTAMP WITH TIME ZONE,
                "error_message" TEXT,
                "attempts" INTEGER DEFAULT 0,
                "timestamp" BIGINT NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
              );
            `);
            
            // Try again
            await db.query(`
              INSERT INTO client_migration_status (
                "migration_name", 
                "schema_version", 
                "status", 
                "started_at",
                "completed_at", 
                "timestamp"
              )
              VALUES ($1, $2, 'completed', NOW(), NOW(), $3)
            `, [
              migration.migrationName, 
              migration.schemaVersion || '0.0.0', 
              migration.timestamp
            ]);
          } else {
            throw err;
          }
        }
      }
      
      // Commit the transaction
      await db.exec('COMMIT');
      
      // Refresh migrations list
      await fetchMigrations();
      setSuccess('Migrations executed successfully');
    } catch (err) {
      // Rollback on error
      try {
        await db.exec('ROLLBACK');
      } catch (rollbackErr) {
        // If rollback fails, there's not much we can do
      }
      
      setError(err instanceof Error ? err.message : 'Failed to run migrations');
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplyMigrations = async () => {
    if (selectedMigrations.size === 0) return;
    
    setIsLoading(true);
    setError(null);
    
    const migrationsToApply = migrations.filter(m => 
      selectedMigrations.has(m.migrationName)
    );
    
    // Start a transaction
    try {
      await db.exec('BEGIN');
      
      for (const migration of migrationsToApply) {
        if (!migration.upQueries || migration.upQueries.length === 0) {
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
            migration.migrationName, 
            migration.schemaVersion || '0.0.0', 
            migration.timestamp
          ]);
        } catch (err) {
          // If the table doesn't exist yet, create it
          if (err instanceof Error && err.message.includes('relation "client_migration_status" does not exist')) {
            await db.exec(`
              CREATE TABLE IF NOT EXISTS client_migration_status (
                "migration_name" TEXT PRIMARY KEY,
                "schema_version" TEXT NOT NULL,
                "status" TEXT NOT NULL,
                "started_at" TIMESTAMP WITH TIME ZONE,
                "completed_at" TIMESTAMP WITH TIME ZONE,
                "error_message" TEXT,
                "attempts" INTEGER DEFAULT 0,
                "timestamp" BIGINT NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
              );
            `);
            
            // Try again
            await db.query(`
              INSERT INTO client_migration_status (
                "migration_name", 
                "schema_version", 
                "status", 
                "started_at", 
                "timestamp"
              )
              VALUES ($1, $2, 'in_progress', NOW(), $3)
            `, [
              migration.migrationName, 
              migration.schemaVersion || '0.0.0', 
              migration.timestamp
            ]);
          } else {
            throw err;
          }
        }
        
        // Apply each query in the migration
        try {
          for (const sql of migration.upQueries) {
            await db.exec(sql);
          }
          
          // Mark migration as completed
          await db.query(`
            UPDATE client_migration_status 
            SET "status" = 'completed',
                "completed_at" = NOW()
            WHERE "migration_name" = $1
          `, [migration.migrationName]);
        } catch (err) {
          // Mark migration as failed
          await db.query(`
            UPDATE client_migration_status 
            SET "status" = 'failed',
                "completed_at" = NOW(),
                "error_message" = $1
            WHERE "migration_name" = $2
          `, [err instanceof Error ? err.message : String(err), migration.migrationName]);
          
          throw err;
        }
        
        // Migration status is already handled in the try/catch block above
      }
      
      // Commit the transaction
      await db.exec('COMMIT');
      
      // Refresh migrations list
      await fetchMigrations();
      setSuccess('Migrations applied successfully');
    } catch (err) {
      // Rollback on error
      try {
        await db.exec('ROLLBACK');
      } catch (rollbackErr) {
        // If rollback fails, there's not much we can do
      }
      
      setError(err instanceof Error ? err.message : 'Failed to apply migrations');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevertMigrations = async () => {
    if (selectedMigrations.size === 0) return;
    
    setIsLoading(true);
    setError(null);
    
    const migrationsToRevert = migrations.filter(m => 
      selectedMigrations.has(m.migrationName)
    );
    
    // Start a transaction
    try {
      await db.exec('BEGIN');
      
      for (const migration of migrationsToRevert) {
        if (!migration.downQueries || migration.downQueries.length === 0) {
          continue;
        }
        
        for (const sql of migration.downQueries) {
          try {
            await db.exec(sql);
          } catch (err) {
            throw new Error(`Failed to execute SQL for ${migration.migrationName}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        
        // Mark migration as not applied in the client
        try {
          await db.query(`
            DELETE FROM "_migrations"
            WHERE name = $1
          `, [migration.migrationName]);
        } catch (err) {
          throw new Error(`Failed to mark migration ${migration.migrationName} as reverted: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      
      // Commit the transaction
      await db.exec('COMMIT');
      
      // Refresh migrations list
      await fetchMigrations();
      setSuccess('Migrations reverted successfully');
    } catch (err) {
      // Rollback on error
      try {
        await db.exec('ROLLBACK');
      } catch (rollbackErr) {
        // If rollback fails, there's not much we can do
      }
      
      setError(err instanceof Error ? err.message : 'Failed to revert migrations');
    } finally {
      setIsLoading(false);
    }
  };

  // Function to handle clearing all data
  const handleClearAllData = async () => {
    if (window.confirm('Are you sure you want to clear all data? This will delete all data but keep the table structure.')) {
      setIsLoading(true);
      setError(null);
      try {
        await clearAllData(db);
        setSuccess('All data cleared successfully');
        await fetchSchema(); // Refresh schema display
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to clear data');
      } finally {
        setIsLoading(false);
      }
    }
  };
  
  // Function to handle dropping all tables
  const handleDropAllTables = async () => {
    if (window.confirm('Are you sure you want to drop all tables? This will completely delete all tables and data. This action cannot be undone.')) {
      setIsLoading(true);
      setError(null);
      try {
        await dropAllTables(db);
        setSuccess('All tables dropped successfully');
        await fetchSchema(); // Refresh schema display
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to drop tables');
      } finally {
        setIsLoading(false);
      }
    }
  };

  // Function to handle dropping a table
  const handleDropTable = async () => {
    if (!tableToDropName.trim()) {
      setError('Please enter a table name');
      return;
    }

    if (window.confirm(`Are you sure you want to drop the table "${tableToDropName}"? This action cannot be undone.`)) {
      setIsLoading(true);
      setError(null);
      try {
        // Execute the DROP TABLE command
        await db.exec(`DROP TABLE IF EXISTS "${tableToDropName}" CASCADE;`);
        setSuccess(`Table "${tableToDropName}" dropped successfully`);
        setTableToDropName(''); // Clear the input
        await fetchSchema(); // Refresh schema display
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to drop table "${tableToDropName}"`);
      } finally {
        setIsLoading(false);
      }
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Admin Panel</h1>
      <div className="p-4 space-y-4">
        <div className="flex gap-4 mb-4 flex-wrap">
          <button
            onClick={toggleOfflineMode}
            className={`px-4 py-2 text-white rounded ${
              isOfflineMode 
                ? 'bg-yellow-600 hover:bg-yellow-700' 
                : 'bg-green-600 hover:bg-green-700'
            }`}
          >
            {isOfflineMode ? 'Reconnect Sync' : 'Enable Offline Mode'}
          </button>

          <button
            onClick={async () => {
              if (window.confirm('Load all data from server? This will replace existing data.')) {
                setIsLoading(true);
                setError(null);
                try {
                  const result = await loadServerData(db);
                  if (!result.success) {
                    throw new Error(result.error);
                  }
                  setSuccess('Server data loaded successfully');
                  await fetchSchema(); // Refresh schema display
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Failed to load server data');
                } finally {
                  setIsLoading(false);
                }
              }
            }}
            disabled={isLoading}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
          >
            Load Server Data
          </button>

          <button
            onClick={() => {
              if (window.confirm('Reset sync LSN to 0/0? This will re-fetch all changes from the server.')) {
                resetLSN().catch((err: Error) => {
                  setError(err.message || 'Failed to reset sync');
                });
              }
            }}
            disabled={isLoading}
            className="px-4 py-2 bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50"
          >
            Reset Sync LSN
          </button>

          <button
            onClick={handleClearAllData}
            disabled={isLoading}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
          >
            Clear All Data
          </button>
          
          <button
            onClick={handleDropAllTables}
            disabled={isLoading}
            className="px-4 py-2 bg-red-800 text-white rounded hover:bg-red-900 disabled:opacity-50"
          >
            Drop All Tables
          </button>

          <button
            onClick={handleRunSelected}
            disabled={isLoading || selectedMigrations.size === 0}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? 'Running Migrations...' : `Run Selected Migrations (${selectedMigrations.size})`}
          </button>

          <button
            onClick={fetchSchema}
            disabled={isLoading}
            className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 disabled:opacity-50"
          >
            Refresh Schema
          </button>
        </div>

        {/* Drop Table Section */}
        <div className="border border-[#404040] rounded-lg p-4 bg-[#242424] mb-4">
          <h2 className="text-lg font-semibold mb-4 text-white">Drop Table</h2>
          <div className="flex items-center gap-2 relative">
            <div className="relative flex-1">
              <input
                type="text"
                value={tableToDropName}
                onChange={(e) => {
                  setTableToDropName(e.target.value);
                  setShowTableDropdown(true);
                }}
                onFocus={() => setShowTableDropdown(true)}
                onBlur={() => {
                  // Delay hiding dropdown to allow for clicks
                  setTimeout(() => setShowTableDropdown(false), 200);
                }}
                placeholder="Enter table name"
                className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#404040] rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {showTableDropdown && schema.length > 0 && (
                <div className="absolute z-10 mt-1 w-full bg-[#1a1a1a] border border-[#404040] rounded shadow-lg max-h-60 overflow-auto">
                  {schema
                    .filter(table => 
                      table.tableName.toLowerCase().includes(tableToDropName.toLowerCase())
                    )
                    .map(table => (
                      <div
                        key={table.tableName}
                        className="px-3 py-2 cursor-pointer hover:bg-[#2a2a2a] text-white"
                        onClick={() => {
                          setTableToDropName(table.tableName);
                          setShowTableDropdown(false);
                        }}
                      >
                        {table.tableName} ({table.rowCount} {table.rowCount === 1 ? 'record' : 'records'})
                      </div>
                    ))}
                </div>
              )}
            </div>
            <button
              onClick={handleDropTable}
              disabled={isLoading || !tableToDropName.trim()}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
            >
              Drop Table
            </button>
          </div>
          <p className="text-gray-400 text-sm mt-2">
            Warning: Dropping a table will permanently delete it and all its data. This action cannot be undone.
          </p>
        </div>

        {/* Migration Status */}
        <div className="border border-[#404040] rounded-lg p-4 bg-[#242424] mb-4">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-white">Database Migrations</h2>
            <div className="space-x-2">
              <button
                onClick={() => {
                  const pendingMigrations = migrations
                    .filter(m => !m.clientApplied)
                    .map(m => m.migrationName);
                  setSelectedMigrations(new Set(pendingMigrations));
                }}
                disabled={isLoading}
                className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700 disabled:opacity-50 text-sm"
              >
                Select All Pending
              </button>
              <button
                onClick={() => {
                  setSelectedMigrations(new Set());
                }}
                disabled={isLoading}
                className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700 disabled:opacity-50 text-sm"
              >
                Deselect All
              </button>
            </div>
          </div>
          
          {error && error.includes('migrations') ? (
            <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 mb-4">
              <p className="text-red-400">{error}</p>
              <p className="text-gray-400 mt-2">
                Make sure the API server is running at {config.apiUrl} and the migrations endpoint is accessible.
              </p>
              <button 
                onClick={fetchMigrations}
                className="mt-2 px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Retry
              </button>
            </div>
          ) : (
            <MigrationsTable
              columns={migrationColumns}
              data={migrations}
              isLoading={isLoading}
              enableRowSelection={true}
              enableMultiRowSelection={true}
              state={{
                rowSelection: Object.fromEntries(
                  Array.from(selectedMigrations).map(id => [id, true])
                )
              }}
              onRowSelectionChange={(newSelection) => {
                // Convert from Record<string, boolean> to Set<string>
                const selectedIds = new Set(
                  Object.entries(newSelection)
                    .filter(([_, selected]) => selected)
                    .map(([id]) => id)
                );
                setSelectedMigrations(selectedIds);
              }}
            />
          )}
          
          <div className="mt-4 flex space-x-4">
            <button
              onClick={handleApplyMigrations}
              disabled={isLoading || selectedMigrations.size === 0}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {isLoading ? 'Applying...' : `Apply Selected (${selectedMigrations.size})`}
            </button>
            
            <button
              onClick={handleRevertMigrations}
              disabled={isLoading || selectedMigrations.size === 0}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
            >
              {isLoading ? 'Reverting...' : 'Revert Selected'}
            </button>
          </div>
        </div>

        {/* Schema Display */}
        <div className="border border-[#404040] rounded-lg p-4 bg-[#242424]">
          <h2 className="text-lg font-semibold mb-4 text-white">Database Schema</h2>
          
          {/* Enum Types */}
          <div className="mb-6">
            <h3 className="text-md font-semibold mb-2 text-purple-400">Enum Types</h3>
            <div className="grid grid-cols-2 gap-4">
              {schema[0]?.enums?.map((enumType) => (
                <div key={enumType.name} className="p-3 bg-[#1a1a1a] rounded border border-[#404040]">
                  <div className="font-medium text-gray-300">{enumType.name}</div>
                  <div className="mt-1 text-sm text-gray-400">
                    Values: {enumType.values.join(', ')}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Tables */}
          <div className="space-y-6">
            {schema.map((table) => (
              <div key={table.tableName} className="border border-[#404040] rounded p-4 bg-[#1a1a1a]">
                <h3 className="text-md font-semibold mb-2 text-blue-400 flex justify-between items-center">
                  <span>{table.tableName}</span>
                  <span className="text-sm text-gray-400 font-normal">{table.rowCount} {table.rowCount === 1 ? 'record' : 'records'}</span>
                </h3>
                
                {/* Columns */}
                <div className="mb-4">
                  <h4 className="text-sm font-medium mb-2 text-gray-300">Columns</h4>
                  <div className="grid grid-cols-4 gap-2 text-sm">
                    {table.columns.map((col) => (
                      <div key={col.name} className="p-2 bg-[#2a2a2a] rounded border border-[#404040]">
                        <span className="font-medium text-gray-200">{col.name}</span>
                        <span className="text-gray-400 ml-2">{col.type}</span>
                        {!col.nullable && <span className="text-red-400 ml-1">*</span>}
                        {col.default && (
                          <span className="text-gray-500 block">
                            Default: {col.default}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Constraints */}
                {table.constraints.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-2 text-gray-300">Constraints</h4>
                    <div className="space-y-1 text-sm">
                      {table.constraints.map((constraint) => (
                        <div key={constraint.name} className="p-2 bg-[#2a2a2a] rounded border border-[#404040]">
                          <span className="font-medium text-purple-400">
                            {constraint.type}
                          </span>
                          <span className="text-gray-400 ml-2">
                            {constraint.definition}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {error && !error.includes('migrations') && (
          <div className="p-4 bg-red-900/30 border border-red-700 text-red-400 rounded mt-4">
            <h3 className="font-bold mb-2">Error</h3>
            <p className="text-sm">{error}</p>
          </div>
        )}

        {success && (
          <div className="p-4 bg-green-900/30 border border-green-700 text-green-400 rounded mt-4">
            <h3 className="font-bold mb-2">Success</h3>
            <p className="text-sm">{success}</p>
          </div>
        )}

        {!db && (
          <div className="p-4 bg-yellow-900/30 border border-yellow-700 text-yellow-400 rounded mt-4">
            Database connection not available
          </div>
        )}
      </div>
    </div>
  );
} 