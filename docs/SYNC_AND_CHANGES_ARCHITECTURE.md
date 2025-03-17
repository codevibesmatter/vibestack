# Sync and Changes Architecture

## Overview

The sync and changes system consists of two main components:

1. Changes Module (`apps/web/src/changes/`)
   - Records and processes database changes
   - Maintains change history
   - Handles direct SQL operations

2. Sync Module (`apps/web/src/worker-sync/`)
   - Manages WebSocket connection
   - Coordinates sync state
   - Handles message processing

## Changes Module Architecture

The Changes Module operates through a dedicated web worker to handle database operations without blocking the main thread.

### Core Components

1. Changes Worker (`worker.ts`)
   - Processes incoming changes
   - Records changes to local_changes table
   - Publishes changes to sync worker
   - Handles server change application

2. Direct SQL Processor (`direct-sql-processor.ts`)
   - Applies changes directly to database tables
   - Handles INSERT, UPDATE, DELETE operations
   - Maintains transaction safety

3. Worker Processor (`worker-processor.ts`)
   - Manages worker lifecycle
   - Routes changes between threads
   - Handles worker communication

4. Retry Manager (`retry-manager.ts`)
   - Manages failed change retries
   - Implements backoff strategy
   - Tracks retry attempts

### Database Schema

The local_changes table tracks all change history:
- Successful changes (processed_local = true)
- Failed changes (with error message)
- Skipped changes (with skip reason)
- Server vs local changes (from_server flag)

## Sync Module Architecture

The Sync Module manages server communication and change coordination through its own web worker.

### Core Components

1. Sync Worker (`worker-thread/sync-worker.ts`)
   - Initializes sync state
   - Manages client identification
   - Routes messages to processors
   - Maintains LSN tracking

2. Connection Manager (`worker-thread/connection-manager.ts`)
   - Handles WebSocket lifecycle
   - Manages connection state
   - Implements heartbeat mechanism
   - Handles reconnection logic

3. Message Processor (`worker-thread/message-processor.ts`)
   - Processes incoming messages
   - Routes to appropriate handlers
   - Manages message responses
   - Handles server messages

4. Client Changes Handler (`worker-thread/client-changes.ts`)
   - Processes client-originated changes
   - Tracks pending changes
   - Handles server responses
   - Manages change acknowledgments

## Message Flow

### Client to Server Changes
1. Client API performs database operation
2. Changes Worker records change in local_changes
3. Change is published to Sync Worker
4. Sync Worker sends change to server via WebSocket
5. Server processes and acknowledges change
6. Sync Worker updates local_changes status

### Server to Client Changes
1. Server sends changes via WebSocket
2. Sync Worker receives and validates changes
3. Changes are sent to Changes Worker
4. Changes Worker applies changes to database
5. Changes Worker records to local_changes
6. Sync Worker acknowledges to server

## State Management

### LSN (Log Sequence Number)
- Tracks sync progress
- Managed by LSN Manager
- Updated atomically with changes
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