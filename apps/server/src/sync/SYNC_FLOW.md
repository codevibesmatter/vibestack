# Sync Flow Process

This document outlines the complete sync flow between client and server, including all message types and their sequence.

## 1. Initial Connection

Client connects to WebSocket endpoint:
```typescript
// Client -> Server
WebSocket('/api/sync/ws/*')
Parameters:
  - clientId: string
  - lsn: string  // Client's last known LSN
```

Server:
- Routes to SyncDO
- Establishes hibernatable WebSocket connection
- Registers client in state manager with LSN
- Determines sync flow based on LSN:
  1. If LSN is '0/0': triggers Initial Sync flow
  2. If LSN is valid:
     - Compares client LSN with current server LSN
     - If client LSN < server LSN: triggers Catchup Sync flow
     - If client LSN = server LSN: begins Live Sync flow

## 2. Initial Sync

Only triggered when client connects with LSN '0/0'.

Sequence:
1. Server -> Client: `srv_init_start`
   ```typescript
   {
     type: 'srv_init_start',
     serverLSN: string,  // Current server LSN at start
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

2. For each table in hierarchy:
   a. Server sends changes in chunks:
      Server -> Client: `srv_init_changes`
      ```typescript
      {
        type: 'srv_init_changes',
        changes: TableChange[],
        sequence: { 
          table: string,    // Current table name
          chunk: number,    // Current chunk number (1-based)
          total: number     // Total chunks for this table
        },
        messageId: string,
        timestamp: number,
        clientId: string
      }
      ```
   b. Client acknowledges each chunk:
      Client -> Server: `clt_init_received`
      ```typescript
      {
        type: 'clt_init_received',
        table: string,     // Table being acknowledged
        chunk: number,     // Chunk number being acknowledged
        messageId: string,
        timestamp: number,
        clientId: string
      }
      ```

3. After all tables are sent and acknowledged:
   Server -> Client: `srv_init_complete`
   ```typescript
   {
     type: 'srv_init_complete',
     serverLSN: string,  // Current server LSN at completion
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

4. Transition Logic:
   - Compare `serverLSN` from `srv_init_start` with `serverLSN` from `srv_init_complete`
   - If they match: 
     - No changes occurred during initial sync
     - Server -> Client: `srv_state_change` with state='live'
   - If they differ:
     - Changes occurred during initial sync
     - Begin Catchup Sync flow from `srv_init_complete.serverLSN`

Note: The sequence tracking enables sync recovery and progress monitoring. The server tracks chunk delivery per table and sends the completion message once all tables are synced. If a connection drops, the sync can be resumed from the last acknowledged chunk of the last acknowledged table.

## 3. Catchup Sync

Triggered when client has valid LSN but is behind server LSN.

1. Server begins WAL replay from client's LSN
2. Server -> Client: `srv_state_change`
   ```typescript
   {
     type: 'srv_state_change',
     state: 'catchup',
     lsn: string,  // Client's LSN where catchup starts
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

3. Server sends changes in chunks:
   Server -> Client: `srv_send_changes`
   ```typescript
   {
     type: 'srv_send_changes',
     changes: TableChange[],
     lastLSN: string,
     sequence?: { chunk: number, total: number },
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

4. After catching up:
   Server -> Client: `srv_state_change`
   ```typescript
   {
     type: 'srv_state_change',
     state: 'live',
     lsn: string,  // Current server LSN
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

## 4. Live Sync

### WAL Replication Changes (Server -> Client)

Server polls WAL for changes and processes them:

1. Orders changes by domain hierarchy:
   - Creates/Updates: Parents before children
   - Deletes: Children before parents

2. Server -> Client: `srv_send_changes`
   ```typescript
   {
     type: 'srv_send_changes',
     changes: TableChange[],
     lastLSN: string,
     sequence?: { chunk: number, total: number },
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

3. Client -> Server: `clt_changes_received`
   ```typescript
   {
     type: 'clt_changes_received',
     changeIds: string[],
     lastLSN: string,
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

### Client Changes (Client -> Server)

1. Client -> Server: `clt_send_changes`
   ```typescript
   {
     type: 'clt_send_changes',
     changes: TableChange[],
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

2. Server processes each change:
   - Executes against database (insert/update/delete)
   - Handles CRDT conflicts
   - Records failed changes in history table

3. Server -> Client (Success): `srv_send_changes` (empty changes array)
   ```typescript
   {
     type: 'srv_send_changes',
     changes: [],
     lastLSN: '0/0',
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

   Server -> Client (Error): `srv_error`
   ```typescript
   {
     type: 'srv_error',
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

## 5. Heartbeat

Periodic heartbeat messages to maintain connection:

Client -> Server: `clt_heartbeat`
```typescript
{
  type: 'clt_heartbeat',
  state?: string,
  lsn: string,
  active: boolean,
  messageId: string,
  timestamp: number,
  clientId: string
}
```

Server -> Client: `srv_heartbeat`
```typescript
{
  type: 'srv_heartbeat',
  messageId: string,
  timestamp: number,
  clientId: string
}
```

## 6. Error Handling

Server -> Client: `srv_error`
```typescript
{
  type: 'srv_error',
  messageId: string,
  timestamp: number,
  clientId: string
}
```

Client -> Server: `clt_error`
```typescript
{
  type: 'clt_error',
  messageId: string,
  timestamp: number,
  clientId: string
}
```

## 7. State Changes

Server -> Client: `srv_state_change`
```typescript
{
  type: 'srv_state_change',
  state: 'initial' | 'catchup' | 'live',
  lsn: string,
  messageId: string,
  timestamp: number,
  clientId: string
}
``` 