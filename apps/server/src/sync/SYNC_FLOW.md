# Sync Flow Process

This document outlines the complete sync flow between client and server, including all message types and their sequence.

## 1. Initial Connection

Client connects to WebSocket endpoint:
```typescript
// Client -> Server
WebSocket('/api/sync')
Parameters:
  - clientId: string
  - lsn: string  // Client's last known LSN
```

Server:
- Routes to SyncDO
- Establishes hibernatable WebSocket connection through protocol upgrade
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

4. Client acknowledges init completion:
   Client -> Server: `clt_init_processed`
   ```typescript
   {
     type: 'clt_init_processed',
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

## 3. Catchup Sync

Triggered when client has valid LSN but is behind server LSN.

1. Server sends changes in chunks:
   Server -> Client: `srv_catchup_changes`
   ```typescript
   {
     type: 'srv_catchup_changes',
     changes: TableChange[],
     lastLSN: string,
     sequence: { chunk: number, total: number }, // Indicates chunk position
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

2. Client acknowledges each chunk:
   Client -> Server: `clt_catchup_received`
   ```typescript
   {
     type: 'clt_catchup_received',
     chunk: number,     // The chunk number being acknowledged
     lsn: string,       // Last LSN processed in this chunk
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

   Notes on chunking and flow control:
   - Changes are retrieved from the database in pages (typically 500 records)
   - Before sending to client, changes are:
     1. Deduplicated to avoid redundant updates
     2. Ordered based on domain hierarchy
     3. Split into chunks (DEFAULT_CHUNK_SIZE = 500)
   - Each chunk includes a sequence object that indicates progress
   - The server waits for client acknowledgment before sending the next chunk
   - This provides flow control, preventing slower clients from being overwhelmed

3. After catching up, server sends completion message:
   Server -> Client: `srv_sync_completed`
   ```typescript
   {
     type: 'srv_sync_completed',
     startLSN: string,    // LSN where sync started
     finalLSN: string,    // LSN at sync completion
     changeCount: number, // Total changes sent
     success: boolean,    // Success status
     error?: string,      // Error message if failed
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

2. Server -> Client: `srv_live_changes`
   ```typescript
   {
     type: 'srv_live_changes',
     changes: TableChange[],
     lastLSN: string,
     sequence?: { chunk: number, total: number },
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

3. Client -> Server: `clt_changes_received` (acknowledgment)
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

2. Server acknowledgment of receipt (immediate):
   Server -> Client: `srv_changes_received`
   ```typescript
   {
     type: 'srv_changes_received',
     changeIds: string[],
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

3. Server processes changes and sends application status:
   Server -> Client: `srv_changes_applied`
   ```typescript
   {
     type: 'srv_changes_applied',
     appliedChanges: string[],
     success: boolean,
     error?: string,
     messageId: string,
     timestamp: number,
     clientId: string
   }
   ```

   On error (may be sent in addition):
   Server -> Client: `srv_error`
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
  clientId: string,
  error?: string       // Optional error message
}
```

## 7. Complete Message Type Summary

### Server Messages
- `srv_init_start` - Initial sync process starting
- `srv_init_changes` - Initial sync table data chunks
- `srv_init_complete` - Initial sync process complete
- `srv_catchup_changes` - Changes being sent to client during catchup sync
- `srv_live_changes` - Changes being sent to client during live sync
- `srv_changes_received` - Acknowledgment of client changes received
- `srv_changes_applied` - Notification that client changes were applied
- `srv_sync_completed` - Notification that catchup sync process is complete
- `srv_error` - Error message
- `srv_heartbeat` - Server heartbeat response

### Client Messages
- `clt_init_received` - Acknowledgment of table chunk receipt
- `clt_init_processed` - Notification that initial sync is processed
- `clt_catchup_received` - Acknowledgment of catchup sync chunk receipt
- `clt_send_changes` - Client sending changes to server
- `clt_changes_received` - Acknowledgment of server changes
- `clt_heartbeat` - Client heartbeat 