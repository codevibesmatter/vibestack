# Sync States

## Overview
The sync system uses a three-state model to manage client synchronization:
1. `INITIALIZING`: Initial connection and setup
2. `CATCHING_UP`: Sending initial changes to client
3. `READY`: Client is up to date and ready for live changes

## State Details

### INITIALIZING
- **Trigger**: Client connects with clientId and LSN in URL
- **Actions**:
  - Register client in state manager
  - Accept client's reported LSN as source of truth
  - Begin sending changes from WAL after client's LSN
- **Next State**: `CATCHING_UP` immediately

### CATCHING_UP
- **Trigger**: After INITIALIZING
- **Actions**:
  - Send changes from WAL after client's reported LSN
  - Track client's LSN updates from their messages
  - Wait for client to acknowledge all changes
- **Next State**: `READY` when client sends ready message

### READY
- **Trigger**: Client acknowledges all changes
- **Actions**:
  - Begin sending live changes from WAL
  - Continue tracking client's LSN updates
  - Monitor for client disconnection
- **Next State**: `INITIALIZING` if client disconnects

## State Management
- Client LSN is the source of truth
- SyncDO only tracks:
  - Client registration
  - Client's reported LSN
  - Current sync state
  - Error tracking
- No persistence of client state between sessions
- Client can reset/retry by providing new LSN in connection URL

## Message Flow
```
Client -> Server:
1. Connect with clientId and LSN in URL
2. Send messages with current LSN
3. Send ready message when caught up

Server -> Client:
1. Begin sending changes from WAL after client's LSN
2. Track client's LSN updates from messages
3. Continue with live changes after ready message
```

## Error Handling
- Track errors in state manager
- Log state transitions and errors
- Clean up client registration on disconnect

## Common Components

### WAL Types
```typescript
// Raw WAL data from PostgreSQL
interface WALData {
  lsn: string;
  data: string;
  xid?: string;
}

// Parsed WAL message structure
interface PostgresWALMessage {
  change?: Array<{
    schema: string;
    table: string;
    kind: 'insert' | 'update' | 'delete';
    columnnames: string[];
    columnvalues: unknown[];
  }>;
  lsn: string;
  xid?: number;
}

// Typed WAL change from replication slot
interface WALChange extends QueryResultRow {
  lsn: string;
  table_name: string;
  operation: 'insert' | 'update' | 'delete';
  new_data: Record<string, unknown>;
  timestamp?: Date;
  xid?: string;
}

// Chunking types
interface ChunkOptions {
  chunkSize?: number;
  cursor?: string | null;
}

interface ChunkResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
```

### Change Processing
- **Deduplication**: Uses last-write-wins based on updated_at timestamp
- **Domain Ordering**: Maintains referential integrity
- **Chunking**: Consistent chunk size across states
- **Error Handling**: Retries and error reporting
- **Logging**: Detailed operation logging

### LSN Management
- **Comparison**: LSN-based ordering and comparison
- **Tracking**: Maintains current LSN position
- **Validation**: Ensures proper LSN progression
- **Recovery**: Handles LSN gaps and errors

## Message Types

### Server to Client
```typescript
type ServerMessage = 
  | { type: 'srv_sync_init'; lastLSN: string }
  | { type: 'srv_send_changes'; changes: TableChange[]; lastLSN: string; sequence?: { chunk: number; total: number } }
  | { type: 'srv_sync_complete'; state: 'initial' | 'catchup' | 'live' }
  | { type: 'srv_error'; code: string; message: string }
```

### Client to Server
```typescript
type ClientMessage =
  | { type: 'clt_sync_request'; lastLSN: string }
  | { type: 'clt_send_changes'; changes: TableChange[] }
  | { type: 'clt_sync_complete'; state: 'initial' | 'catchup' | 'live' }
```

## State Transition Logic

### LSN-Based State Determination
- Server maintains current WAL LSN position
- Client reports its last known LSN in sync requests
- System determines appropriate state based on LSN gap
- Transitions between states based on sync progress

### Error Handling
- Retries for failed operations
- Error reporting and logging
- State recovery mechanisms
- Connection health monitoring

### Performance Considerations
- Chunk size optimization
- Polling interval tuning
- Connection management
- Resource utilization

## State Transitions
```
[INITIALIZING] (one-off)
     ↓
[CATCHING_UP] <-> [READY] (recurring)
```

## Module Structure

### Current Structure
```
apps/server/src/sync/
├── SyncDO.ts                 # Main Durable Object implementation
├── state-manager.ts          # State management and metrics
├── websocket-handler.ts      # WebSocket connection handling
├── message-handler.ts        # Message routing and processing
├── client-changes.ts         # Client change execution
├── server-changes.ts         # Server change handling
├── catchup.ts               # Catchup logic (separate module)
├── init.ts                  # Initial sync logic (separate module)
├── domain-ordering.ts       # Change ordering by domain
└── types.ts                 # Shared type definitions
```

### Proposed Structure
```
apps/server/src/sync/
├── SyncDO.ts                 # Main Durable Object implementation
├── state-manager.ts          # State management and metrics
├── websocket-handler.ts      # WebSocket connection handling
├── message-handler.ts        # Message routing and processing
├── client-changes.ts         # Client change execution
├── server-changes.ts         # Server change handling (initial, catchup, live)
├── chunking.ts              # Chunking and pagination utilities
├── domain-ordering.ts       # Change ordering by domain
└── types.ts                 # Shared type definitions
```

### Key Changes
1. **Consolidated Change Handling**:
   - Move all server-side change handling into `server-changes.ts`
   - Remove separate `init.ts` and `catchup.ts` modules
   - Keep all sync states in one file

2. **Shared Utilities**:
   - Move chunking logic to its own file
   - Keep domain ordering separate
   - Simple, flat structure

3. **Benefits**:
   - Simpler organization
   - Clear dependencies
   - Easier to maintain
   - No complex directory structure

## Implementation Details

### 1. INITIALIZING State
- **Trigger**: Client connects with clientId and LSN in URL
- **Purpose**: Establish baseline state for new clients
- **One-off Nature**:
  - Only happens once per client
  - Sets initial LSN for client
  - Never repeats unless explicitly reset
- **Implementation**:
  - Query current state of all tables directly
  - Use pagination to handle large tables
  - Maintain domain ordering (parents before children)
  - Send state in chunks to avoid memory issues
  - No need to handle deletes or transformations
  - Mark as complete when all tables are synced

### 2. CATCHING_UP State
- **Trigger**: After INITIALIZING
- **Purpose**: Replay missed changes from WAL
- **Implementation**:
  - Query WAL from client's last known LSN
  - Use pagination to handle large change sets
  - Maintain domain ordering
  - Send changes in chunks
  - Handle all operation types (insert/update/delete)
  - Mark as complete when caught up to current LSN
  - **Deduplication**:
    - Group changes by record ID (table + id)
    - Keep only the latest change for each record
    - Use updated_at timestamp for ordering
    - Handle deletes specially (keep if latest)
    - Apply deduplication before domain ordering
    - Maintain LSN sequence for consistency

### 3. READY State
- **Trigger**: Client acknowledges all changes
- **Purpose**: Real-time change propagation
- **Implementation**:
  - **Passive Event Consumption**:
    - Simply consumes events from replication system
    - No direct WAL querying
    - No need for deduplication (replication handles this)
    - No need for pagination (events come in real-time)
  - **Event Processing**:
    - Maintain domain ordering
    - Send changes in chunks
    - Handle all operation types
    - Monitor client connection health
  - **Key Differences from CATCHING_UP**:
    - No WAL querying
    - No deduplication needed
    - No pagination needed
    - Just consumes and forwards events

## Migration Strategy
1. Add new state handling alongside existing system
2. Test with subset of clients
3. Gradually migrate clients to new system
4. Remove old implementation once migration complete

## Monitoring & Metrics
- Track sync state transitions
- Monitor chunk sizes and processing times
- Track error rates and types
- Monitor client connection health
- Track sync progress and completion rates 