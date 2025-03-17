# Sync Module

## Overview

The sync module provides a worker-based implementation of database synchronization between client and server. It handles:
- WebSocket connection management
- Server change processing
- Client change tracking
- LSN (Log Sequence Number) management
- Connection state management

## Architecture

### Core Components

1. **Sync Worker** (`worker-core.ts`)
   - Manages WebSocket connection
   - Coordinates sync state
   - Routes messages to appropriate handlers
   - Maintains client identification

2. **Connection Manager** (`connection-manager.ts`)
   - Handles WebSocket lifecycle
   - Manages connection state
   - Implements heartbeat mechanism
   - Handles reconnection logic

3. **Message Processor** (`message-processor.ts`)
   - Processes incoming messages
   - Routes to appropriate handlers
   - Manages message responses
   - Handles server messages

4. **LSN Manager** (`lsn-manager.ts`)
   - Manages Log Sequence Numbers
   - Tracks sync progress
   - Handles client identification
   - Uses IndexedDB for persistence

### Changes System

Located in `sync/changes/`:

1. **Server Changes Handler** (`server-changes.ts`)
   - Processes server-originated changes
   - Records changes to local_changes table
   - Applies changes to database
   - Manages retries for failed changes

2. **Client Changes Handler** (`client-changes.ts`)
   - Processes client-originated changes
   - Tracks pending changes
   - Handles server responses
   - Manages change acknowledgments

3. **Changes Interface** (`changes-interface.ts`)
   - Bridges sync worker and changes system
   - Validates incoming changes
   - Manages change processing lifecycle
   - Handles timeouts and errors

## Message Flow

### Client to Server Changes
1. Client API performs database operation
2. Change is sent to sync worker
3. Sync worker sends change to server via WebSocket
4. Server processes and acknowledges change
5. Sync worker updates local state

### Server to Client Changes
1. Server sends changes via WebSocket
2. Sync worker receives and validates changes
3. Changes are processed by server changes handler
4. Changes are applied to database
5. Changes are recorded in local_changes table
6. Sync worker acknowledges to server

## State Management

### LSN (Log Sequence Number)
- Tracks sync progress
- Updated atomically with changes
- Persisted in IndexedDB
- Used for resuming sync

### Connection State
- Managed by Connection Manager
- Handles disconnects and reconnects
- Maintains client identification
- Buffers during disconnection

### Change Status
- Tracked in local_changes table
- Records processing status
- Maintains error history
- Tracks retry attempts

## Error Handling

1. Connection Errors
   - Automatic reconnection
   - Exponential backoff
   - State preservation
   - Message buffering

2. Change Processing Errors
   - Transaction rollback
   - Error recording
   - Retry management
   - Status updates

3. Sync State Errors
   - LSN verification
   - State recovery
   - Client reidentification
   - History reconciliation

## Public API

```typescript
// Initialize the sync system
initializeSync(): boolean

// Connect to sync server
connectToSyncServer(wsUrl: string): Promise<boolean>

// Disconnect from sync server
disconnectFromSyncServer(reason?: string): void

// Clean up sync resources
cleanupSync(): void

// Reset LSN and trigger fresh sync
resetLSN(): Promise<void>

// Subscribe to sync events
onSyncEvent(event: SyncEvent, callback: (data: any) => void): void

// Unsubscribe from sync events
offSyncEvent(event: SyncEvent, callback: (data: any) => void): void
```

## Service Events

The sync module emits the following service events:
- Connection state changes
- Change processing status
- Error conditions
- LSN updates

## Usage

```typescript
// Initialize sync
const syncInitialized = initSync();

// Connect to server
await connectToSyncServer('ws://localhost:8787/api/sync');

// Subscribe to events
onSyncEvent('status_changed', (state) => {
  console.log('Connection state:', state.isConnected);
});

// Clean up
cleanupSync();
```

## Configuration

The sync module can be configured through:
- WebSocket URL
- Heartbeat intervals
- Retry settings
- Change processing options

## Dependencies

- IndexedDB for state persistence
- WebSocket for server communication
- Web Workers for background processing
- SQLite for local database operations 