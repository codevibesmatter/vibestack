# UI-Driven Changes Architecture

This document outlines our refined architecture for VibeStack that combines UI-driven stores with the changes table approach and live queries.

## Core Principles

1. **UI-Driven Data Shapes**: Stores are structured based on UI visualization needs, not just entity types.
2. **Changes Table as Source of Truth**: All data modifications flow through the changes table.
3. **Live Query Reactivity**: Stores use live queries to react to changes in real-time.
4. **TypeORM Entity Integration**: All components use TypeORM entities for type safety and consistency.

## Architecture Components

### 1. UI-Driven Stores

Stores are created based on how data needs to be presented in the UI:

- Multiple stores might exist for the same entity type, each optimized for a different visualization
- Each store maintains its own optimized data structure
- Stores use live queries to watch for changes to their entities
- TypeORM entity types ensure type safety and consistency

Example store types:
- User List Store (optimized for tables/lists)
- User Profile Store (optimized for detailed views)
- Task Kanban Store (optimized for board visualization)
- Task Gantt Store (optimized for timeline visualization)

### 2. Entity API Modules

Each entity type has its own API module that:

- Provides functions for CRUD operations
- Records changes in the changes table
- Handles entity-specific validation and business logic
- Uses TypeORM entity types for parameters and return values

### 3. Change Processor

A single, generic change processor that:

- Watches for unprocessed changes in the changes table
- Processes each change based on its entity type and operation
- Updates the actual entity tables in the database
- Marks changes as processed when complete
- Handles retries and error tracking

### 4. Live Query Hooks

Custom hooks that:

- Provide real-time access to processed changes
- Allow stores to react to changes as they happen
- Filter changes by entity type and other criteria
- Leverage the database's built-in reactivity

## Data Flow

1. **UI Action**: User performs an action (e.g., update a user)
2. **API Call**: UI calls the appropriate API function (e.g., `updateUser`)
3. **Record Change**: API records the change in the changes table
4. **Process Change**: Change processor processes the change
5. **Live Query Update**: Live queries watching the changes table update
6. **Store Update**: Stores update their state based on the changes
7. **UI Update**: UI components re-render with the updated state

## Integration with Sync System

The architecture integrates with the sync system through the changes table and message bus:

### 1. Sync Status Tracking

- The `local_changes` table includes a `processed_sync` field to track sync status
- Changes are marked as processed locally before being synced to the server
- The sync service monitors the changes table for unsynced changes

### 2. Message Bus Integration

- The `dbMessageBus` publishes events when changes are recorded and processed
- Sync-related events (`change_recorded`, `change_processed`) are used to trigger sync operations
- The sync service subscribes to these events to know when to sync changes

### 3. Sync Service Interaction

```typescript
// Example of how the sync service interacts with the changes table
export async function syncChangesToServer(): Promise<void> {
  const db = await getDatabase();
  
  // Get unsynced changes
  const result = await db.query(`
    SELECT * FROM local_changes 
    WHERE processed_local = TRUE AND processed_sync = FALSE
    ORDER BY timestamp ASC
  `);
  
  const changes = result.rows || [];
  
  for (const change of changes) {
    try {
      // Send change to server
      await sendChangeToServer(change);
      
      // Mark as synced
      await db.query(`
        UPDATE local_changes 
        SET processed_sync = TRUE
        WHERE id = $1
      `, [change.id]);
      
      // Publish sync success event
      dbMessageBus.publish('change_synced', {
        changeId: change.id,
        entityType: change.entity_type,
        entityId: change.entity_id,
        operation: change.operation
      });
    } catch (error) {
      // Handle sync error
      console.error('Error syncing change:', error);
    }
  }
}
```

### 4. Handling Incoming Remote Changes

- Remote changes from the server are recorded in the local changes table
- A special flag or field can indicate the change originated from the server
- The same change processor handles both local and remote changes
- UI stores react to all processed changes regardless of origin

```typescript
// Example of recording a remote change
export async function recordRemoteChange(
  entityType: string,
  entityId: string,
  operation: 'insert' | 'update' | 'delete',
  data?: any
): Promise<void> {
  // Similar to recordChange but with a remote origin flag
  await recordChange(entityType, entityId, operation, data, true);
  
  // Publish specific event for remote changes
  dbMessageBus.publish('remote_change_recorded', {
    entityType,
    entityId,
    operation,
    timestamp: Date.now()
  });
}
```

### 5. Conflict Resolution

- When conflicts occur between local and remote changes, they are resolved based on configurable strategies
- Conflict resolution happens in the change processor before updating the entity tables
- Resolution strategies can be entity-specific and configured in the entity API modules
- Resolved conflicts are logged for audit purposes

## Implementation Structure

```
src/
  stores/
    userListStore.ts       # Store optimized for user lists/tables
    userProfileStore.ts    # Store optimized for user profile views
    taskKanbanStore.ts     # Store optimized for task board views
    taskGanttStore.ts      # Store optimized for task timeline views
  api/
    userApi.ts             # User-specific API functions
    taskApi.ts             # Task-specific API functions
    projectApi.ts          # Project-specific API functions
  db/
    changes-table.ts       # Changes table functionality
    change-processor.ts    # Generic change processor
    hooks/
      useChanges.ts        # Hooks for accessing changes
  sync/
    sync-service.ts        # Sync service for sending/receiving changes
    conflict-resolver.ts   # Conflict resolution strategies
```

## Live Query Hooks

The key to this architecture is the live query hooks that connect the changes table to the stores:

```typescript
// Example hook for accessing processed changes
export const useProcessedChangesForEntity = (
  entityType: string,
  limit: number = 100
) => {
  return useLiveIncrementalQuery(
    `SELECT * FROM local_changes 
     WHERE entity_type = $1 AND processed_local = TRUE
     ORDER BY timestamp DESC LIMIT $2`,
    [entityType, limit],
    'id'
  );
};

// Example hook for accessing an entity with live updates
export const useEntityById = <T>(
  entityType: string,
  entityTable: string,
  id: string
): T | null => {
  // Get the entity from its table
  const entityResult = useLiveIncrementalQuery(
    `SELECT * FROM "${entityTable}" WHERE id = $1`,
    [id],
    'id'
  );
  
  // Watch for changes to this entity
  const changesResult = useLiveIncrementalQuery(
    `SELECT * FROM local_changes 
     WHERE entity_type = $1 AND entity_id = $2 AND processed_local = TRUE
     ORDER BY timestamp DESC LIMIT 1`,
    [entityType, id],
    'id'
  );
  
  // Return the entity or null if not found
  return entityResult.rows?.[0] as T || null;
};
```

## Store Implementation Pattern

Stores follow this general pattern:

1. **Define state structure** optimized for the UI visualization
2. **Create actions** for updating the state
3. **Use live queries** to watch for changes
4. **Provide selectors** for accessing the data in different ways

```typescript
// Conceptual example (not implementation code)
const useUserListStore = create<UserListState>((set, get) => ({
  // State optimized for list view
  users: {},
  userIds: [],
  // ...
  
  // Initialize with live query
  initialize: () => {
    const unsubscribe = subscribeToLiveQuery(
      useProcessedChangesForEntity('User'),
      (changes) => {
        // Update store based on changes
        // ...
      }
    );
    
    return unsubscribe;
  },
  
  // Actions for updating state
  // ...
}));
```

## Benefits of This Approach

1. **UI-Optimized Data**: Each store is structured for its specific UI needs
2. **Real-Time Updates**: Live queries provide immediate updates
3. **Type Safety**: TypeORM entities ensure type consistency
4. **Decoupled Components**: Each part of the system has a clear responsibility
5. **Offline Support**: Changes are recorded even when offline
6. **Audit Trail**: Complete history of all data modifications
7. **Performance**: Each store only updates when relevant data changes
8. **Sync Integration**: Seamless integration with the sync system
9. **Conflict Handling**: Built-in mechanisms for resolving conflicts

## Implementation Steps

1. **Create Live Query Hooks**: Build hooks for accessing changes and entities
2. **Implement Entity API Modules**: Create API modules for each entity type
3. **Create UI-Driven Stores**: Build stores optimized for different visualizations
4. **Connect Stores to Live Queries**: Make stores react to changes
5. **Update UI Components**: Connect UI components to the appropriate stores
6. **Integrate with Sync System**: Connect the changes table to the sync service

This architecture provides a clean, reactive system that optimizes data for UI needs while maintaining a single source of truth through the changes table. 