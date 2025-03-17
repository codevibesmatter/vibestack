# Changes Table Implementation

This document outlines the implementation of the changes table approach for data processing in VibeStack.

## Overview

The changes table approach is a pattern for handling data modifications in a way that:

1. Decouples data modification from processing
2. Creates a single source of truth for synchronization
3. Provides an audit trail of all data changes
4. Improves performance by reducing the need for live queries on entire tables
5. Enhances offline support

## Database Schema

The `local_changes` table stores all data modifications with the following schema:

```sql
CREATE TABLE IF NOT EXISTS local_changes (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  data JSONB,
  timestamp BIGINT NOT NULL,
  processed_local BOOLEAN DEFAULT FALSE,
  processed_sync BOOLEAN DEFAULT FALSE,
  error TEXT,
  attempts INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_local_changes_processed_local ON local_changes(processed_local);
CREATE INDEX IF NOT EXISTS idx_local_changes_processed_sync ON local_changes(processed_sync);
CREATE INDEX IF NOT EXISTS idx_local_changes_entity ON local_changes(entity_type, entity_id);
```

### Fields

- `id`: Unique identifier for the change (UUID)
- `entity_type`: The type of entity being modified (e.g., "User", "Project", "Task")
- `entity_id`: The ID of the entity being modified
- `operation`: The operation being performed ("insert", "update", "delete")
- `data`: The entity data for insert/update operations (JSON)
- `timestamp`: When the change was recorded (milliseconds since epoch)
- `processed_local`: Whether the change has been processed locally
- `processed_sync`: Whether the change has been synchronized with the server
- `error`: Error message if processing failed
- `attempts`: Number of processing attempts

## Components

### 1. Changes Table API

The `changes-table.ts` file provides the core API for interacting with the changes table:

- `createChangesTable()`: Creates the table and indexes
- `doesChangesTableExist()`: Checks if the table exists
- `recordChange()`: Records a change in the table

### 2. Change Processor (To Be Implemented)

A background service that processes changes:

- Watches for new changes
- Updates local state (Zustand stores)
- Marks changes as processed locally
- Handles retries for failed changes

### 3. Sync Integration (To Be Implemented)

Integration with the sync service:

- Syncs changes to the server
- Marks changes as processed for sync
- Handles conflict resolution

### 4. Entity API (To Be Implemented)

Enhanced entity operations that use the changes table:

- `upsertEntity()`: Records change and updates entity
- `deleteEntity()`: Records change and deletes entity

### 5. Zustand Store (To Be Implemented)

Zustand stores that listen for changes:

- Subscribe to change events
- Update state based on processed changes
- Provide cached data to components

## Usage

### Recording Changes

```typescript
import { recordChange } from '../db/changes-table';

// Record an insert/update
await recordChange(
  'User',
  'user-123',
  'update',
  { name: 'John Doe', email: 'john@example.com' }
);

// Record a delete
await recordChange(
  'User',
  'user-123',
  'delete'
);
```

### Processing Changes (Future Implementation)

```typescript
import { startChangeProcessor, stopChangeProcessor } from '../db/change-processor';

// Start the processor
startChangeProcessor();

// Stop the processor
stopChangeProcessor();
```

## Benefits

1. **Performance**: Only need to watch the changes table instead of entire entity tables
2. **Offline Support**: Changes are recorded even when offline
3. **Audit Trail**: Complete history of all data modifications
4. **Decoupling**: Separation of data modification from processing
5. **Resilience**: Failed operations can be retried

## Next Steps

1. Implement the Change Processor service
2. Enhance entity operations to use the changes table
3. Create Zustand stores for entity data
4. Integrate with the sync service
5. Add live query hook for the changes table 