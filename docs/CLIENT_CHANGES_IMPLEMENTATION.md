# Client Changes Implementation

## Overview
Implementation plan for handling client-originated changes through the existing sync module, removing direct API calls.

## Current Flow
1. Client makes local change
2. Change recorded in local_changes table
3. Worker processes change_recorded event
4. Worker makes REST API call
5. Server processes REST request
6. Server writes to database
7. WAL captures change
8. Change distributed to other clients

## New Flow
1. Client makes local change
2. Change recorded in local_changes table
3. Changes worker processes change_recorded event
4. Changes worker publishes to sync worker via message bus
5. Sync worker sends change via existing WebSocket connection
6. Server receives change message
7. Server checks for conflicts:
   - Check if entity still exists (for updates/deletes)
   - Validate that client has permission to modify entity
   - Ensure change doesn't conflict with business rules
   - Note: updatedAt conflicts are allowed (CRDT behavior)
8. If no conflicts:
   - Server applies SQL directly
   - WAL captures change naturally
   - Change distributed to other clients through existing replication
9. If conflicts detected:
   - Write to changes_history for audit
   - Send conflict error back to client via sync connection
   - Client handles based on conflict type:
     * Entity missing: Mark as error
     * Permission denied: Mark as error
     * Business rule violation: Mark as error
     * updatedAt conflict: Accept as normal CRDT behavior

## Queue Management

### Client-Side Queue
- Changes stored in local_changes table serve as persistent queue
- Queue processed in order by timestamp
- Failed changes (non-CRDT conflicts) remain in queue for retry
- Queue survives page reloads and browser restarts
- Automatic retry with exponential backoff
- Manual retry capability for failed changes
- CRDT conflicts (updatedAt) are not queued for retry

### Message Bus Integration
- Changes worker publishes changes to message bus
- Sync worker subscribes to change events
- Sync worker handles WebSocket communication
- Error responses routed back through sync worker
- Message bus ensures reliable delivery between workers

### Queue Processing
1. Client startup:
   - Load pending changes from local_changes
   - Resume processing from last successful change
   - Sync worker establishes WebSocket connection
   - Begin processing queue

2. During operation:
   - New changes added to end of queue
   - Process oldest changes first
   - Track processing state in local_changes
   - Update change status after processing
   - CRDT conflicts marked as success

3. Error handling:
   - Non-CRDT failed changes marked for retry
   - Maintain retry count and last error
   - Exponential backoff between retries
   - Maximum retry limit before manual intervention
   - CRDT conflicts logged but not retried

4. Connection loss:
   - Queue continues to accept new changes
   - Processing paused until reconnection
   - Sync worker handles reconnection
   - Resume from last successful change
   - Maintain change order during resume

## Implementation Modules

### Client Side
- Remove api-sync.ts
- Modify changes worker to publish to message bus
- Use existing sync worker for WebSocket communication
- Keep local change recording for history/retry
- Add queue management and retry logic
- Add CRDT conflict handling

### Server Side
New module: sync/client-changes/
- types.ts: Define client change message types
- handler.ts: Process incoming client changes
- executor.ts: Apply changes directly to database
- errors.ts: Error handling and reporting
- validator.ts: Conflict detection and validation logic (respecting CRDT)

### Changes to Existing Code
- Remove API endpoints for changes
- Add client change message handling to SyncDO
- Keep changes_history writes only for failed changes
- Preserve client_id column usage
- Add change handling to sync worker
- Add message bus integration

## Benefits
1. Simplified flow - removes REST API layer
2. Consistent change handling in both directions
3. Natural WAL capture of changes
4. Reduced latency and overhead
5. Better error handling through WebSocket connection
6. Maintains existing retry/recovery mechanisms
7. Proper CRDT conflict handling
8. Persistent queue ensures no changes lost
9. Ordered processing maintains data consistency
10. Leverages existing sync infrastructure
11. Clear separation of concerns between workers

## Migration Path
1. Implement new client changes module
2. Add message bus integration
3. Enhance sync worker for changes
4. Test direct SQL application
6. Clean up deprecated code 