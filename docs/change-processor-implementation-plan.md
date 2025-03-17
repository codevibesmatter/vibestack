# Event-Driven Change Processor Implementation Plan

## Overview

This document outlines the plan for enhancing our existing change processing system with a dedicated worker-based, event-driven architecture. The goal is to improve reliability, performance, and maintainability while leveraging our existing infrastructure.

## Current System Analysis

Our current implementation includes:

1. **Changes Table**: A `local_changes` table in PGlite with fields for tracking entity changes:
   - `id`: Unique identifier
   - `entity_type`: Type of entity (e.g., 'User')
   - `entity_id`: ID of the affected entity
   - `operation`: Type of operation (insert, update, delete)
   - `data`: JSON data representing the change
   - `timestamp`: When the change was created
   - `processed_local`: Whether the change has been processed locally
   - `processed_sync`: Whether the change has been synced with the server
   - `error`: Error message if processing failed
   - `attempts`: Number of processing attempts

2. **Change Recording**: A `recordChange` function that:
   - Records changes in the `local_changes` table
   - Publishes a `change_recorded` event via the message bus

3. **Change Processor**: An interval-based processor that:
   - Polls the database for unprocessed changes
   - Processes changes in order
   - Updates change status
   - Publishes events via the message bus

4. **Message Bus**: A simple event system that:
   - Allows components to subscribe to events
   - Publishes events when changes occur
   - Handles command dispatching

## Limitations of Current System

1. **Component Lifecycle Dependency**: The processor is started/stopped by components
2. **Polling Overhead**: Periodic polling creates unnecessary database load
3. **Main Thread Processing**: Change processing happens on the main thread
4. **Limited Scalability**: Not optimized for high-volume changes
5. **Tight Coupling**: Change processing logic is coupled with UI components

## Enhanced Architecture

We will implement a dedicated worker-based, event-driven change processor that:

1. **Runs Independently**: Operates in a separate worker thread
2. **Reacts to Events**: Processes changes in response to events rather than polling
3. **Handles Synchronization**: Manages both local processing and server synchronization
4. **Provides Clear API**: Offers a simple interface for recording and subscribing to changes
5. **Supports Batching**: Efficiently processes related changes together

## Implementation Plan

### Phase 1: Reorganize and Enhance Changes Module

1. **Create Unified Changes Module Structure**
   - Create `apps/web/src/changes/` directory to house all change-related code
   - Move existing `changes-table.ts` and `change-processor.ts` into this directory
   - Create additional files for the new architecture

2. **Enhance Message Bus Integration**
   - Update message bus integration for worker communication
   - Extend event types to include worker-specific events
   - Implement reliable message delivery

3. **Implement ChangesLogger**
   - Create a dedicated logger for the changes system
   - Integrate with the application's centralized logging infrastructure
   - Add comprehensive logging for all change operations

### Phase 2: Worker Implementation

1. **Create Change Processor Worker**
   - Create `apps/web/src/changes/worker.ts` for the worker implementation
   - Implement message handling for processing changes
   - Add support for processing changes in response to events
   - Implement batch processing capabilities

2. **Create Service Layer**
   - Create `apps/web/src/changes/service.ts` for the main thread service
   - Implement API for recording changes
   - Add methods for subscribing to change events
   - Create functions for managing the worker lifecycle

### Phase 3: Application Integration

1. **Update Application Initialization**
   - Create `apps/web/src/changes/index.ts` as the main entry point
   - Initialize the change processor on application startup
   - Handle online/offline transitions
   - Manage worker lifecycle with application state

2. **Update Existing Components**
   - Modify components to use the new change processor service
   - Remove direct change processing code
   - Implement event subscriptions for UI updates

3. **Create Monitoring UI**
   - Develop a simple UI for monitoring change processing
   - Show statistics on pending, processed, and failed changes
   - Add controls for manual intervention

### Phase 4: Sync Integration

1. **Implement Sync Integration**
   - Create integration with the sync messaging worker
   - Handle server-originated changes
   - Send local changes to the server
   - Respond to sync status changes

2. **Enhance Worker for Server Changes**
   - Add support for processing server-originated changes
   - Implement special handling for server changes
   - Ensure proper conflict resolution

3. **Update Service for Sync Status**
   - Add methods for tracking sync status
   - Implement retry mechanisms for failed syncs
   - Provide feedback on sync progress

## Changes Module Structure

```
apps/web/src/changes/
├── index.ts                # Main entry point and public API
├── types.ts                # Type definitions for changes
├── table.ts                # Changes table operations (renamed from changes-table.ts)
├── service.ts              # Main thread service for change processing
├── worker.ts               # Worker implementation for processing changes
├── logger.ts               # ChangesLogger for centralized logging
├── sync-integration.ts     # Integration with sync messaging worker (Phase 4)
├── handlers/               # Entity-specific change handlers
│   ├── index.ts            # Handler registry
│   ├── user-handler.ts     # User entity change handler
│   └── ...                 # Other entity handlers
└── ui/                     # Optional UI components for monitoring
    ├── changes-monitor.tsx # Change processing monitor
    └── ...                 # Other UI components
```

## Key Components

### 1. ChangesLogger

The ChangesLogger will provide centralized logging for all change-related operations:

- Log change recording, processing, and completion
- Track errors and retries
- Provide debugging information for worker operations
- Integrate with the application's existing logging infrastructure

### 2. Change Processor Worker

The worker will run in a separate thread and handle all change processing:

- Process changes in response to events
- Handle batches of changes efficiently
- Update change status in the database
- Notify the main thread of processing results

### 3. Change Processor Service

The service will provide the main API for the changes system:

- Record changes in the database
- Manage the worker lifecycle
- Handle communication between components and the worker
- Provide methods for subscribing to change events

### 4. Sync Integration (Phase 4)

In the final phase, we'll implement sync integration:

- Connect with the sync messaging worker
- Process server-originated changes
- Send local changes to the server
- Handle sync status changes and errors

## Migration Strategy

1. **Reorganize Existing Code**:
   - Move `changes-table.ts` to `changes/table.ts`
   - Move `change-processor.ts` to `changes/legacy-processor.ts` (for reference)
   - Create new files in the `changes/` directory

2. **Parallel Implementation**:
   - Implement the new system alongside the existing one
   - Gradually migrate components to the new system
   - Run both systems during transition period

3. **Testing Strategy**:
   - Unit tests for worker and service
   - Integration tests for component interaction
   - Performance tests to validate improvements

4. **Rollout Plan**:
   - Phase 1: Implement worker and service
   - Phase 2: Migrate one component as a test case
   - Phase 3: Migrate remaining components
   - Phase 4: Implement sync integration
   - Phase 5: Remove old implementation

## Benefits of New Architecture

1. **Improved Performance**:
   - Change processing happens off the main thread
   - Event-driven approach eliminates polling overhead
   - Batch processing for related changes

2. **Better Reliability**:
   - Worker continues processing regardless of UI state
   - Clearer error handling and recovery
   - Consistent processing of changes

3. **Enhanced Maintainability**:
   - Separation of concerns between UI and data processing
   - Centralized change processing logic
   - Clearer API for components

4. **Scalability**:
   - Better handles high volumes of changes
   - More efficient processing of related changes
   - Reduced database load

5. **Improved Observability**:
   - Comprehensive logging through ChangesLogger
   - Centralized monitoring of all change operations
   - Better debugging capabilities

6. **Seamless Synchronization** (Phase 4):
   - Integrated with sync messaging worker
   - Unified handling of local and server changes
   - Consistent change processing regardless of origin

## Conclusion

This implementation plan leverages our existing infrastructure while addressing the limitations of our current approach. By moving to a dedicated worker with an event-driven architecture, we'll improve performance, reliability, and maintainability of our change processing system.

The plan builds on our existing message bus and changes table, ensuring a smooth transition while providing significant benefits for our local-first architecture. The unified `changes/` directory structure will keep all change-related code organized and make the system easier to understand and maintain.

By implementing the sync integration in a later phase, we can focus first on getting the local change processing system working correctly before adding the complexity of server synchronization. This phased approach reduces risk and allows for better testing and validation at each step. 