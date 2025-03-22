# Sync Module

This module handles real-time synchronization between clients and the server using WebSockets and Durable Objects.

## Architecture

The sync module is organized into the following components:

### Core Components

- **SyncDO**: The main Durable Object class that handles WebSocket connections and synchronization.
- **connection**: A module for managing WebSocket connections and message handling.
- **client-registry**: Manages client registration across hibernation using KV storage.
- **changes**: Handles processing and distributing changes to clients.
- **state**: Manages state persistence for the Durable Object.
- **types**: Shared type definitions for the sync module.

### Integration with Replication

The sync module works closely with the replication system:

1. **Initialization Sequence**:
   - When a client connects, the SyncDO initializes the replication system
   - SyncDO waits for the replication system's initial poll to complete
   - This ensures any pending WAL changes are processed before sync operations begin

2. **Change Source**:
   - Changes are read from the `change_history` table, which is populated by the replication system
   - Each client tracks its current position using an LSN (Log Sequence Number)
   - Catchup sync retrieves changes newer than the client's LSN

3. **Race Condition Prevention**:
   - The SyncDO calls `ReplicationDO.waitForInitialPoll()` before starting sync
   - This ensures the replication system has completed processing all WAL changes
   - Without this synchronization, clients might not see changes made right before their connection

### Connection Module

The connection module is organized into the following components:

- **websocket-handlers**: Implements WebSocket event handlers for the Hibernation API.
- **message-processor**: Processes WebSocket messages and handles sync requests.
- **types**: Connection-specific type definitions.
- **index**: Re-exports all connection components.

## WebSocket Routing

WebSocket connections are handled directly in the root index.ts file, not through the Hono router. This is because:

1. **Durable Object Creation**: WebSocket connections need to be routed to a specific Durable Object instance.
2. **WebSocket Upgrade**: The WebSocket upgrade process requires specific response handling (101 status code).
3. **Hibernation API**: We use Cloudflare's WebSocket Hibernation API which requires specific handling.

The flow for WebSocket connections is:

1. Client connects to `/api/sync` with the WebSocket protocol
2. The root index.ts file detects the WebSocket upgrade request
3. A SyncDO instance is created or retrieved based on the client ID
4. The request is forwarded to the SyncDO instance
5. The SyncDO handles the WebSocket connection using the Hibernation API

## Synchronization Process

The sync module implements a two-phase synchronization process:

1. **Initial Synchronization**:
   - For new clients or clients with LSN '0/0'
   - Performs a full data sync from the current database state
   - Sets the client's LSN to the current database LSN

2. **Catchup Synchronization**:
   - For existing clients with a valid LSN
   - Queries the `change_history` table for changes newer than the client's LSN
   - Updates the client's LSN after each batch of changes is processed
   - Uses pagination to handle large volumes of changes efficiently

### Change History Table

The sync system relies on the `change_history` table maintained by the replication system:

- **Purpose**: Provides a persistent record of all database changes in chronological order
- **Query Process**: 
  ```sql
  SELECT * FROM change_history 
  WHERE lsn > $1::pg_lsn 
  ORDER BY lsn ASC 
  LIMIT $2
  ```
- **Benefits**:
  - Reliable change history for clients that reconnect
  - Efficient catchup using LSN-based pagination
  - Complete ordering of all changes across tables

## WebSocket Hibernation API

The sync module leverages Cloudflare's WebSocket Hibernation API to efficiently manage resources. Key features include:

1. **Hibernatable WebSockets**: Using `state.acceptWebSocket(ws)` allows the Durable Object to be evicted from memory while the WebSocket connection remains open.

2. **Automatic Reactivation**: When a WebSocket receives a message, the runtime automatically recreates the Durable Object and delivers the message to the appropriate handler.

3. **Self-Waking Connections**: The WebSocket connection itself wakes up the Durable Object - no separate wake-up endpoint is needed.

4. **Duration Charge Reduction**: Using the WebSocket Hibernation API significantly decreases duration charges.

## Usage

The sync module is used by the client-side sync system to maintain real-time synchronization with the server. The client establishes a WebSocket connection to the server, and the server uses the Durable Object to manage the connection and distribute changes.

### WebSocket Event Handlers

The Durable Object implements the following WebSocket event handlers:

- **webSocketMessage**: Handles incoming messages from clients.
- **webSocketClose**: Handles WebSocket close events.
- **webSocketError**: Handles WebSocket error events.

These handlers are implemented in the `websocket-handlers.ts` file and used by the `SyncDO` class.

## Race Condition Prevention

The sync system implements several safeguards against race conditions:

1. **Replication Initialization Wait**:
   - The SyncDO waits for the replication system to complete its initial polling
   - This prevents sync operations from starting before the change_history table is populated
   - Uses the ReplicationDO's `/wait-for-initial-poll` endpoint

2. **Transactional LSN Updates**:
   - Client LSN updates are atomic and stored in durable storage
   - This ensures clients never lose their position, even during DO eviction

3. **Ordered Change Processing**:
   - Changes are always processed in strict LSN order
   - This maintains causal consistency across all clients

## Testing

The sync system includes comprehensive testing:

- **Sync Test Scenarios**: Various scenarios like initial sync, catchup sync, and error handling
- **Race Condition Testing**: Verifies that sync operations correctly wait for replication initialization
- **Synchronization Testing**: Ensures changes are delivered in the correct order

## File Structure

```
apps/server/src/sync/
├── connection/
│   ├── index.ts              // Re-exports from connection modules
│   ├── message-processor.ts  // Message processing logic
│   ├── types.ts              // Connection-specific types
│   └── websocket-handlers.ts // WebSocket event handlers
├── client-registry.ts        // Client registration in KV store
├── changes.ts                // Change processing logic
├── initial-sync.ts           // Initial sync implementation
├── server-changes.ts         // Server changes implementation using change_history
├── index.ts                  // Main exports
├── README.md                 // This file
├── replication.ts            // Replication logic
├── SyncDO.ts                 // Durable Object implementation
├── state.ts                  // State management
└── types.ts                  // Shared types
```

## Client Registry

The `client-registry.ts` module provides functions for registering and unregistering clients in a KV store, allowing them to be tracked across hibernation cycles. It includes:

- `registerClient`: Registers a client in the KV store with a 24-hour TTL
- `unregisterClient`: Removes a client from the KV store
- `getAllClients`: Gets all registered clients
- `getClient`: Gets a specific client registration

This approach provides several advantages:
- **Persistence**: Client registrations survive DO hibernation
- **Scalability**: KV stores are designed for high-throughput access patterns
- **Simplicity**: No need to manage complex state in the DO

## WebSocket Client Data

Instead of using a separate ClientManager, we store client information directly on the WebSocket object:

```typescript
// When accepting a WebSocket
const { 0: client, 1: server } = new WebSocketPair();

// Store client info directly on the WebSocket
server.clientData = {
  clientId,
  lastLSN: '0/0',
  connected: true,
  lastActivity: Date.now()
};
```

This approach simplifies the code and better aligns with Durable Objects principles.

## Modular Implementation

The sync module has been refactored to use a more modular approach:

1. **WebSocket Handlers**: All WebSocket event handlers are implemented in the `websocket-handlers.ts` file and imported by `SyncDO`.
2. **Client Registry**: Client registration is handled by the `client-registry.ts` module.
3. **Message Processing**: Message processing logic is implemented in the `message-processor.ts` file.

This modular approach makes the code easier to maintain and test, while also making it more reusable.

## Benefits of This Approach

1. **Simplicity**: Eliminates an entire layer of abstraction
2. **Direct Mapping**: Each WebSocket directly contains its client information
3. **Better Alignment with DO Principles**: Uses Durable Objects' built-in state management
4. **Reduced Code Complexity**: Fewer components and interfaces to maintain
5. **Clearer Responsibility**: Clients are responsible for their state, DO is responsible for serving changes 
6. **Resilient To Race Conditions**: Proper synchronization with the replication system 