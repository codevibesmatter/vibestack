# Migration Sync Implementation

This document outlines how to implement migration synchronization through the sync service, leveraging the existing client migration infrastructure and integrating it with our changes table approach.

## Overview

The migration sync system will allow schema changes to be propagated from the server to clients through the sync service. This is essential for maintaining schema compatibility as the application evolves.

## Existing Infrastructure

Our codebase already has a solid foundation for client migrations:

1. **Migration Entities**:
   - `ClientMigration`: Server-side entity that stores migration information, including SQL queries to run on the client.
   - `ClientMigrationStatus`: Client-side entity that tracks which migrations have been applied.

2. **Migration Files**:
   - TypeORM migration files in `packages/typeorm/src/migrations/client/` that define schema changes.

3. **Migration Application**:
   - The AdminPanel component has functionality to apply migrations to the client database.

## Integration with Changes Table

We'll enhance this system to work with our changes table approach and make it more automated through the sync service.

### 1. Migration Changes Table

We'll create a dedicated changes table for migrations to track migration operations:

```sql
CREATE TABLE IF NOT EXISTS migration_changes (
  id TEXT PRIMARY KEY,
  migration_name TEXT NOT NULL,
  operation TEXT NOT NULL, -- 'apply' or 'revert'
  timestamp BIGINT NOT NULL,
  processed BOOLEAN DEFAULT FALSE,
  error TEXT,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3
);

CREATE INDEX IF NOT EXISTS idx_migration_changes_processed ON migration_changes(processed);
CREATE INDEX IF NOT EXISTS idx_migration_changes_migration_name ON migration_changes(migration_name);
```

### 2. Migration Processor Service

```typescript
// apps/web/src/db/migration-processor.ts
import { db } from './core';
import { dbMessageBus } from './message-bus';
import { syncLogger } from '../utils/logger';

// Track processing state
let isProcessing = false;
let processingInterval: number | null = null;

/**
 * Start the migration processor
 * @param intervalMs How often to check for migrations (default: 5000ms)
 */
export function startMigrationProcessor(intervalMs = 5000): void {
  if (processingInterval) {
    return;
  }
  
  syncLogger.info('Starting migration processor...');
  
  // Process immediately on start
  processMigrations();
  
  // Set up interval for continuous processing
  processingInterval = window.setInterval(processMigrations, intervalMs);
}

/**
 * Stop the migration processor
 */
export function stopMigrationProcessor(): void {
  if (processingInterval) {
    window.clearInterval(processingInterval);
    processingInterval = null;
    syncLogger.info('Migration processor stopped');
  }
}

/**
 * Process pending migrations
 */
async function processMigrations(): Promise<void> {
  // Prevent concurrent processing
  if (isProcessing || !db) {
    return;
  }
  
  isProcessing = true;
  
  try {
    // Get unprocessed migration changes
    const migrationChangesResult = await db.query(`
      SELECT * FROM migration_changes 
      WHERE processed = FALSE AND attempts < max_attempts
      ORDER BY timestamp ASC
      LIMIT 5
    `);
    
    const migrationChanges = migrationChangesResult.rows || [];
    
    if (migrationChanges.length > 0) {
      syncLogger.info(`Processing ${migrationChanges.length} migration changes...`);
      
      // Process each migration change
      for (const change of migrationChanges) {
        await processMigrationChange(change);
      }
    }
    
    // Check for new migrations from server if online
    if (navigator.onLine) {
      await checkForNewMigrations();
    }
  } catch (error) {
    syncLogger.error('Error processing migrations:', error);
  } finally {
    isProcessing = false;
  }
}

/**
 * Process a migration change
 * @param change The migration change to process
 */
async function processMigrationChange(change: any): Promise<void> {
  try {
    // Increment attempt counter
    await db.query(
      `UPDATE migration_changes 
       SET attempts = attempts + 1
       WHERE id = $1`,
      [change.id]
    );
    
    // Get the migration details
    const migrationResult = await db.query(
      `SELECT * FROM client_migration WHERE "migrationName" = $1`,
      [change.migration_name]
    );
    
    const migration = migrationResult.rows?.[0];
    
    if (!migration) {
      throw new Error(`Migration not found: ${change.migration_name}`);
    }
    
    // Start transaction
    await db.query('BEGIN');
    
    try {
      if (change.operation === 'apply') {
        // Apply migration
        for (const sql of migration.upQueries) {
          await db.query(sql);
        }
        
        // Record migration status
        await db.query(
          `INSERT INTO client_migration_status (
            "migrationName", applied, "appliedAt", "clientId"
          ) VALUES ($1, true, $2, $3)
          ON CONFLICT ("migrationName") DO UPDATE
          SET applied = true, "appliedAt" = $2, "errorMessage" = NULL`,
          [change.migration_name, new Date(), 'local-client']
        );
        
        // Update migration record
        await db.query(
          `UPDATE client_migration 
           SET "clientApplied" = true
           WHERE "migrationName" = $1`,
          [change.migration_name]
        );
      } else if (change.operation === 'revert') {
        // Revert migration
        for (const sql of migration.downQueries) {
          await db.query(sql);
        }
        
        // Update migration status
        await db.query(
          `UPDATE client_migration_status 
           SET applied = false, "appliedAt" = $1
           WHERE "migrationName" = $2`,
          [new Date(), change.migration_name]
        );
        
        // Update migration record
        await db.query(
          `UPDATE client_migration 
           SET "clientApplied" = false
           WHERE "migrationName" = $1`,
          [change.migration_name]
        );
      }
      
      // Mark as processed
      await db.query(
        `UPDATE migration_changes 
         SET processed = TRUE, error = NULL
         WHERE id = $1`,
        [change.id]
      );
      
      // Commit transaction
      await db.query('COMMIT');
      
      // Publish event
      dbMessageBus.publish('migration_processed', {
        migrationName: change.migration_name,
        operation: change.operation,
        timestamp: Date.now()
      });
    } catch (error) {
      // Rollback on error
      await db.query('ROLLBACK');
      
      // Record error
      await db.query(
        `UPDATE migration_changes 
         SET error = $1
         WHERE id = $2`,
        [error instanceof Error ? error.message : String(error), change.id]
      );
      
      // Record migration status error if applying
      if (change.operation === 'apply') {
        await db.query(
          `INSERT INTO client_migration_status (
            "migrationName", applied, "appliedAt", "errorMessage", attempts
          ) VALUES ($1, false, $2, $3, 1)
          ON CONFLICT ("migrationName") DO UPDATE
          SET "errorMessage" = $3, attempts = client_migration_status.attempts + 1`,
          [change.migration_name, new Date(), error instanceof Error ? error.message : String(error)]
        );
      }
      
      throw error;
    }
  } catch (error) {
    syncLogger.error('Error processing migration change:', error, { change });
  }
}

/**
 * Check for new migrations from the server
 */
async function checkForNewMigrations(): Promise<void> {
  try {
    // Get all migrations
    const migrationsResult = await db.query(
      `SELECT * FROM client_migration ORDER BY timestamp ASC`
    );
    
    const migrations = migrationsResult.rows || [];
    
    // Get applied migrations
    const appliedResult = await db.query(
      `SELECT "migrationName" FROM client_migration_status WHERE applied = true`
    );
    
    const appliedMigrations = new Set(
      appliedResult.rows?.map(row => row.migrationName) || []
    );
    
    // Find pending migrations
    const pendingMigrations = migrations.filter(
      migration => !appliedMigrations.has(migration.migrationName)
    );
    
    if (pendingMigrations.length > 0) {
      syncLogger.info(`Found ${pendingMigrations.length} pending migrations`);
      
      // Queue migrations for processing
      for (const migration of pendingMigrations) {
        // Check if already queued
        const existingResult = await db.query(
          `SELECT * FROM migration_changes 
           WHERE migration_name = $1 AND processed = FALSE`,
          [migration.migrationName]
        );
        
        if (existingResult.rows?.length === 0) {
          // Queue migration
          await db.query(
            `INSERT INTO migration_changes (
              id, migration_name, operation, timestamp
            ) VALUES ($1, $2, 'apply', $3)`,
            [crypto.randomUUID(), migration.migrationName, Date.now()]
          );
          
          syncLogger.info(`Queued migration: ${migration.migrationName}`);
        }
      }
    }
  } catch (error) {
    syncLogger.error('Error checking for new migrations:', error);
  }
}

/**
 * Queue a migration for application
 * @param migrationName The name of the migration to apply
 */
export async function queueMigration(migrationName: string): Promise<void> {
  try {
    // Check if migration exists
    const migrationResult = await db.query(
      `SELECT * FROM client_migration WHERE "migrationName" = $1`,
      [migrationName]
    );
    
    if (!migrationResult.rows?.length) {
      throw new Error(`Migration not found: ${migrationName}`);
    }
    
    // Queue migration
    await db.query(
      `INSERT INTO migration_changes (
        id, migration_name, operation, timestamp
      ) VALUES ($1, $2, 'apply', $3)
      ON CONFLICT (id) DO NOTHING`,
      [crypto.randomUUID(), migrationName, Date.now()]
    );
    
    syncLogger.info(`Manually queued migration: ${migrationName}`);
  } catch (error) {
    syncLogger.error('Error queueing migration:', error);
    throw error;
  }
}

/**
 * Queue a migration for reversion
 * @param migrationName The name of the migration to revert
 */
export async function queueMigrationReversion(migrationName: string): Promise<void> {
  try {
    // Check if migration exists and is applied
    const statusResult = await db.query(
      `SELECT * FROM client_migration_status 
       WHERE "migrationName" = $1 AND applied = true`,
      [migrationName]
    );
    
    if (!statusResult.rows?.length) {
      throw new Error(`Migration not found or not applied: ${migrationName}`);
    }
    
    // Queue migration reversion
    await db.query(
      `INSERT INTO migration_changes (
        id, migration_name, operation, timestamp
      ) VALUES ($1, $2, 'revert', $3)
      ON CONFLICT (id) DO NOTHING`,
      [crypto.randomUUID(), migrationName, Date.now()]
    );
    
    syncLogger.info(`Manually queued migration reversion: ${migrationName}`);
  } catch (error) {
    syncLogger.error('Error queueing migration reversion:', error);
    throw error;
  }
}
```

### 3. Enhanced Sync Service

We'll enhance the sync service to handle migration synchronization:

```typescript
// Add to apps/web/src/worker-sync/index.ts

/**
 * Sync migrations from server to client
 */
export async function syncMigrations(): Promise<boolean> {
  try {
    // Fetch migrations from server
    const response = await fetch('/api/migrations/pending', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch migrations: ${response.statusText}`);
    }
    
    const migrations = await response.json();
    
    if (!migrations.length) {
      return true; // No migrations to sync
    }
    
    // Store migrations in client database
    const db = await getDatabase();
    
    for (const migration of migrations) {
      // Insert or update migration
      await db.query(
        `INSERT INTO client_migration (
          timestamp, "migrationName", "upQueries", "downQueries", "clientApplied"
        ) VALUES ($1, $2, $3, $4, false)
        ON CONFLICT ("migrationName") DO UPDATE
        SET "upQueries" = $3, "downQueries" = $4`,
        [
          migration.timestamp,
          migration.migrationName,
          JSON.stringify(migration.upQueries),
          JSON.stringify(migration.downQueries)
        ]
      );
    }
    
    return true;
  } catch (error) {
    syncLogger.error('Error syncing migrations:', error);
    return false;
  }
}
```

### 4. Server API Endpoint

We'll create a server API endpoint to provide pending migrations:

```typescript
// apps/server/src/routes/migrations.ts
import { Router } from 'express';
import { pool } from '../db';
import { ClientMigration } from '@repo/typeorm/server-entities';

const router = Router();

// Get pending migrations
router.get('/pending', async (req, res) => {
  try {
    const client = await pool.connect();
    
    try {
      // Get migrations that haven't been applied on the client
      const result = await client.query<ClientMigration>(
        `SELECT * FROM server.client_migration 
         WHERE "clientApplied" = false
         ORDER BY timestamp ASC`
      );
      
      res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching pending migrations:', error);
    res.status(500).json({ error: 'Failed to fetch pending migrations' });
  }
});

// Report migration status
router.post('/status', async (req, res) => {
  try {
    const { migrationName, applied, error } = req.body;
    
    if (!migrationName) {
      return res.status(400).json({ error: 'Migration name is required' });
    }
    
    const client = await pool.connect();
    
    try {
      // Update migration status
      await client.query(
        `UPDATE server.client_migration 
         SET "clientApplied" = $1
         WHERE "migrationName" = $2`,
        [applied, migrationName]
      );
      
      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error updating migration status:', error);
    res.status(500).json({ error: 'Failed to update migration status' });
  }
});

export default router;
```

### 5. Database Initialization with Migration Table

```typescript
// Add to apps/web/src/db/core.ts in the initializeDatabase function

// Create the migration changes table if it doesn't exist
await newDb.query(`
  CREATE TABLE IF NOT EXISTS migration_changes (
    id TEXT PRIMARY KEY,
    migration_name TEXT NOT NULL,
    operation TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    error TEXT,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3
  );

  CREATE INDEX IF NOT EXISTS idx_migration_changes_processed ON migration_changes(processed);
  CREATE INDEX IF NOT EXISTS idx_migration_changes_migration_name ON migration_changes(migration_name);
`);
```

### 6. App Component with Migration Processor

```typescript
// Add to apps/web/src/main.tsx
import { startMigrationProcessor, stopMigrationProcessor } from './db/migration-processor';
import { syncMigrations } from './worker-sync';

// Add to the App component
function App() {
  // ... existing code
  
  // Start migration processor when database is initialized
  useEffect(() => {
    if (isDbInitialized) {
      // Start the migration processor
      startMigrationProcessor();
      
      // Sync migrations from server
      syncMigrations().catch(err => {
        console.error('Failed to sync migrations:', err);
      });
      
      return () => {
        stopMigrationProcessor();
      };
    }
  }, [isDbInitialized]);
  
  // ... rest of component
}
```

### 7. Integration with Changes Table Approach

The migration system works alongside our changes table approach:

1. **Schema Changes First**: Migrations are processed before entity changes to ensure the schema is up-to-date.
2. **Consistent Processing**: Both systems use a similar processor pattern.
3. **Event Publishing**: Both systems publish events that components can listen to.

## Migration Flow

1. **Server-Side**:
   - Developers create TypeORM migrations in `packages/typeorm/src/migrations/client/`
   - Migrations are compiled and stored in the server database as `ClientMigration` entities
   - The server API exposes pending migrations

2. **Sync Process**:
   - The client sync service fetches pending migrations from the server
   - Migrations are stored in the client database
   - The migration processor queues migrations for application

3. **Client-Side Processing**:
   - The migration processor applies migrations in order
   - Migration status is tracked in `ClientMigrationStatus`
   - The server is notified of successful application

## Benefits

1. **Automated Migration**: Migrations are automatically synced and applied
2. **Resilience**: Failed migrations are retried with backoff
3. **Visibility**: Migration status is tracked and visible
4. **Integration**: Works alongside the changes table approach

## Considerations

1. **Migration Order**: Migrations must be applied in the correct order
2. **Backward Compatibility**: Migrations should be backward compatible
3. **Testing**: Migrations should be thoroughly tested
4. **Rollback**: Support for rolling back migrations if needed 