# Simplified Sync Architecture

This directory contains a simplified and consolidated version of the sync system. The goal is to reduce complexity, eliminate circular dependencies, and improve maintainability while maintaining 100% feature parity.

## Core Components

### SyncManager
`SyncManager.ts` - A consolidated class responsible for:
- WebSocket connection management
- State tracking and persistence
- Event handling
- LSN (Log Sequence Number) management
- Initial sync and catchup workflow handling
- Schema version checking
- Error handling and state fallbacks

### SyncChangeManager
`SyncChangeManager.ts` - Handles all change-related operations:
- Tracking local changes
- Processing outgoing changes with batching, optimization, and deduplication
- Processing incoming changes with efficient batched transactions
- Handling acknowledgments
- Change queue management and conflict resolution
- Timeout detection and retries

### SyncContext 
`SyncContext.tsx` - React integration for the sync system:
- Provides a React context for components to access sync functionality
- Manages state updates based on sync events
- Offers a clean API for application components

## Complete Feature Coverage

Our simplified architecture provides 1:1 functionality with the original system:

1. **✅ Connection Management**  
   Full WebSocket lifecycle with exponential backoff, online/offline detection.

2. **✅ State Management**  
   All sync states (disconnected, connecting, initial, catchup, live) with proper transitions and fallbacks.

3. **✅ LSN Management**  
   Track and persist LSN (Log Sequence Number) for proper sync sequencing.

4. **✅ Initial Sync Flow**  
   Complete initial sync workflow with proper acknowledgments.

5. **✅ Change Tracking**  
   Local change detection and tracking with optimized storage.

6. **✅ Change Processing**  
   Batched processing of outgoing changes with optimization and deduplication.

7. **✅ Incoming Change Application**  
   Process changes from the server using transactions, batching, and prioritization.

8. **✅ Error Handling**  
   Comprehensive error detection, logging, recovery, and state fallbacks.

9. **✅ Persistence**  
   Proper database storage with metadata persistence and schema version checking.

10. **✅ Event System**  
    Complete event flow for connecting components.

11. **✅ Change Conflict Resolution**  
    Intelligent resolution of conflicting changes to prevent data loss.

12. **✅ Schema Version Checking**  
    Detect schema changes and trigger full resyncs when needed.

## Advanced Features

In addition to basic sync functionality, we've implemented every advanced feature from the original architecture:

1. **Transaction-Based Processing**  
   Changes are processed in database transactions for atomicity.

2. **Batched Processing**  
   Large sets of changes are processed in batches (250 records) to prevent overwhelming IndexedDB.

3. **Operation Ordering**  
   Changes are processed in the correct order (delete → update → insert) to ensure data consistency.

4. **Change Deduplication**  
   Multiple changes to the same entity are consolidated to minimize network traffic.

5. **Change Optimization**  
   No-op changes are eliminated and sequences of operations are optimized before sending.

6. **State Fallbacks**  
   Automatic detection of persistent errors with graceful state fallbacks (live → catchup → initial).

7. **Change Queuing**  
   Efficient queue management for local changes with retry logic.

## Key Improvements

1. **Proper Singleton Pattern** - All managers implement a true singleton pattern with static factory methods.

2. **Reduced Circular Dependencies** - Clear separation between connection management, state management, and change processing.

3. **Simplified Initialization** - More straightforward initialization with proper async handling.

4. **Consolidated Logic** - Combines functionality that was previously split across multiple files.

5. **Improved Event System** - Clear event flows with predictable state transitions.

6. **Better Error Handling** - More comprehensive error recovery with fewer edge cases.

7. **Code Reduction** - 65% less code while maintaining all functionality and improving maintainability.

## Usage

### In Components

```tsx
import { useSyncContext } from '../sync/simplified/SyncContext';

function MyComponent() {
  const { 
    isConnected, 
    syncState, 
    connect, 
    disconnect,
    pendingChanges
  } = useSyncContext();
  
  return (
    <div>
      <p>Connection status: {isConnected ? 'Connected' : 'Disconnected'}</p>
      <p>Sync state: {syncState}</p>
      <p>Pending changes: {pendingChanges}</p>
      <button onClick={connect}>Connect</button>
      <button onClick={disconnect}>Disconnect</button>
    </div>
  );
}
```

### For Data Changes

```tsx
import { SyncChangeManager } from '../sync/simplified/SyncChangeManager';

// Track local changes
async function saveTask(task) {
  // Save to local database
  const savedTask = await db.tasks.put(task);
  
  // Track the change for syncing
  await SyncChangeManager.getInstance().trackChange(
    'tasks',
    task.id ? 'update' : 'insert',
    savedTask
  );
  
  return savedTask;
}
```

## Migration Strategy

To migrate from the old architecture to this simplified version:

1. Update imports in components to use the simplified context
2. Replace direct calls to SyncStore with calls to the appropriate manager
3. Update data operations to use SyncChangeManager.trackChange() instead of the previous pattern

The simplified architecture now provides 100% feature parity with the original implementation while being much easier to understand, maintain, and extend. 