# Sync Worker Consolidation Plan

## Overview

This document outlines the plan to consolidate the Changes Worker and Sync Worker into a single Worker that handles change recording and server synchronization. The worker is specifically responsible for maintaining the change history and applying server changes, while the client API layer handles entity table operations and UI state.

## Architecture Separation

### Client API Layer (Outside Worker)
- Handles entity table operations (insert/update/delete)
- Manages UI store state
- Publishes change events to worker
- Receives change processed notifications

### Consolidated Sync Worker

#### Core Responsibilities
- Change Management
  - Records and tracks all changes in local_changes table
  - Handles both client and server change processing
  - Maintains change history and status tracking

- Connection Management
  - Manages WebSocket lifecycle and health
  - Ensures reliable server communication
  - Handles connection recovery and message buffering

- State and Protocol Management
  - Tracks LSN and sync state
  - Manages client identification and versioning
  - Coordinates concurrent operations

- Error Handling and Recovery
  - Implements comprehensive retry strategies
  - Provides error tracking and reporting
  - Ensures data consistency during failures

#### Change Recording
Implementation: `apps/web/src/changes/worker.ts`, `apps/web/src/changes/recorder.ts`
- Records local changes with metadata (timestamp, entity type, operation)
- Maintains change history in local_changes table
- Tracks change status (processed_local, processed_sync)
- Records errors and retry attempts
- Validates change format and required fields

#### WebSocket Management
Implementation: `apps/web/src/worker-sync/worker-thread/connection-manager.ts`
- Maintains persistent WebSocket connection
- Handles connection lifecycle (connect, disconnect, reconnect)
- Implements exponential backoff for reconnection
- Monitors connection state
- Buffers messages during disconnection

#### Server Change Processing
Implementation: 
Primary: `apps/web/src/worker-sync/worker-thread/message-processor.ts`
Supporting:
- `apps/web/src/changes/direct-sql-processor.ts` - Database operations
- `apps/web/src/worker-sync/worker-thread/sync-worker.ts` - Worker thread processing
- `apps/web/src/worker-sync/shared/lsn-manager.ts` - LSN tracking

Flow:
1. Server Message Reception (Worker Thread)
   - WebSocket receives server changes with LSN
   - MessageProcessor.handleServerMessage processes raw message
   - Validates message structure and LSN

2. Change Processing (Worker Thread)
   - Validates change array structure
   - Checks required fields (table, operation)
   - Validates operation types (insert, update, delete)
   - Processes changes in order of LSN

3. Database Application (Worker Thread)
   - Starts database transaction
   - Records changes to local_changes table
   - Applies changes to entity tables
   - Updates LSN atomically
   - Commits transaction

4. Response Handling (Worker Thread)
   - Updates local change status
   - Sends acknowledgment to server
   - Handles any errors during process
   - Notifies server of LSN update

Error Cases:
- Invalid message format: Logged and rejected
- Database errors: Transaction rolled back
- Timeout: Change marked as failed
- Partial batch failure: Maintains consistency

#### Client Change Handling
Implementation: `apps/web/src/worker-sync/worker-thread/client-changes.ts`, `apps/web/src/changes/worker-processor.ts`
- Validates client changes before sending
- Tracks pending changes with unique local IDs
- Sends changes to server immediately
- Handles server acknowledgments
- Updates local_changes status based on responses
- Implements retry logic for failed changes

#### LSN Management
Implementation: `apps/web/src/worker-sync/shared/lsn-manager.ts`
- Tracks Last Sequence Number (LSN) for sync state
- Ensures ordered processing of changes
- Handles out-of-order LSNs
- Resumes sync from last known LSN
- Updates LSN atomically with changes

#### Error Handling
Implementation: `apps/web/src/changes/retry-manager.ts`, `apps/web/src/worker-sync/worker-thread/connection-manager.ts`
- Records detailed error information
- Implements retry logic with backoff
- Tracks failed changes
- Handles partial batch failures
- Maintains change order during retries
- Provides error notifications to main thread

#### State Management
Implementation: `apps/web/src/worker-sync/service.ts`, `apps/web/src/worker-sync/worker-thread/sync-worker.ts`
- Maintains connection state
- Tracks pending changes
- Manages LSN state
- Handles worker lifecycle
- Provides status updates to main thread

#### Logging and Monitoring
Implementation: `apps/web/src/utils/logger.ts`, Used throughout all worker files
- Detailed logging of all operations
- Change processing metrics
- Connection state monitoring
- Error tracking and reporting
- Performance monitoring

#### Message Types Handled
Implementation: `apps/web/src/worker-sync/shared/message-types.ts`
- change_recorded: From API layer
- client_change: To/from server
- server_changes: From server
- changes_processed: To API layer
- connect/disconnect: Connection management
- sync_request/response: Sync protocol
- error: Error reporting
- status: State updates

## Message Flow

### Client Change Recording Flow
1. Client API performs entity table operation (insert/update/delete)
2. On success, publishes change event to worker
3. Worker records change to local_changes table
4. Worker immediately sends change to server
5. Worker waits for server acknowledgment
6. Worker updates local_changes record with sync status

### Server Change Application Flow
1. Server sends changes with LSN via WebSocket
2. Worker starts transaction
3. For each change:
   - Records to local_changes table
   - Applies change to entity table
   - Marks change as processed
4. Updates LSN
5. Commits transaction
6. Sends acknowledgment to server

### Error Handling Flow
1. Failed server acknowledgments:
   - Mark change as failed in local_changes
   - Record error message
   - Increment attempt counter
2. Connection drops:
   - Keep WebSocket connection alive
   - Reconnect with exponential backoff
   - Resume from last known LSN
3. Failed changes:
   - Retry up to 3 times
   - Only retry changes with errors
   - Maintain entity operation order

## Implementation Plan

### Phase 1: Code Consolidation
1. Move Change Recording:
   - Move local_changes operations to sync worker
   - Consolidate change tracking logic
   - Keep API layer focused on entity operations

2. Update Message Types:
   - change_recorded: From API to worker
   - client_change: From worker to server
   - server_changes: From server to worker
   - change_processed: From worker to API

3. Merge State Management:
   - LSN tracking in worker only
   - Change history in worker only
   - Connection state in worker only

### Phase 2: Database Operations
1. Change Recording Schema:
   - Add necessary columns for tracking
   - Add indexes for performance
   - Support LSN tracking
   - Support change metadata

2. Transaction Handling:
   - Server changes in single transaction
   - Local change recording atomic
   - LSN updates atomic

### Phase 3: Error Handling
1. Change Application Errors:
   - Record error in local_changes
   - Notify API layer of failure
   - Handle partial batch failures
   - Track sync attempt counts
   - Implement exponential backoff

2. Recovery Flows:
   - Retry failed server changes
   - Resend unacknowledged changes
   - Handle out-of-order LSNs
   - Maintain change order per entity
   - Handle connection drops gracefully

### Phase 4: Testing
1. Test Scenarios:
   - Server change application
   - Change history recording
   - LSN tracking accuracy
   - Error recovery flows

2. Performance Tests:
   - Change recording speed
   - Server change application speed
   - Concurrent change handling

## Migration Strategy

1. Preparation:
   - Add consolidated change handling
   - Keep old workers as fallback
   - Add feature flag for new flow

2. Rollout:
   - Migrate change recording first
   - Then server change application
   - Monitor error rates
   - Validate change history

3. Cleanup:
   - Remove old workers
   - Clean up unused code
   - Update documentation

## Success Metrics

1. Performance:
   - Faster change recording
   - Faster server change application
   - Lower memory usage
   - Better connection stability

2. Reliability:
   - Accurate change history
   - Consistent LSN tracking
   - Better error recovery
   - No lost changes

3. Maintainability:
   - Simpler code structure
   - Clear responsibility separation
   - Better debugging
   - Easier testing 