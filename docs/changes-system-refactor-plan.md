# Changes System Refactor Plan

## Overview

This document outlines the plan for refactoring the changes system to improve its architecture, performance, and maintainability. The current system has several components that need to be better organized to follow a clear flow and separation of concerns.

## Current Architecture

The current changes system consists of the following components:

1. **Recorder (`recorder.ts`)**:
   - Records changes to entities in the database
   - Emits events when changes are recorded
   - Provides `recordChange()` and `recordServerChange()` functions

2. **Processor (`processor.ts`)**:
   - Listens for change events from the recorder
   - Manages entity handlers for different entity types
   - Processes changes in the main thread
   - May delegate to the worker-client for background processing

3. **Worker-Client (`worker-client.ts`)**:
   - Acts as a bridge between the processor and the worker
   - Manages communication with the background worker
   - Handles worker lifecycle (initialization, termination)

4. **Worker (`worker.ts`)**:
   - Runs in a separate thread
   - Contains some processing logic
   - Processes changes without blocking the UI

## Issues with Current Architecture

1. **Processing in Main Thread**: The processor runs in the main thread, which can block the UI during intensive operations.
2. **Unclear Flow**: The flow from recording a change to processing it is not clearly defined.
3. **Duplicate Logic**: Some processing logic is duplicated between the processor and the worker.
4. **Complex Communication**: The communication between components is more complex than necessary.

## Proposed Architecture

We propose to refactor the system to follow this flow:

```
recorder --> worker-client --> worker (with processor logic)
```

In this revised flow:

1. **Recorder (`recorder.ts`)**:
   - Records changes to entities in the database
   - Emits events when changes are recorded
   - No changes needed to this component

2. **Worker-Client (`worker-client.ts`)**:
   - Listens directly for change events from the recorder
   - Automatically sends changes to the worker for processing
   - Manages worker lifecycle

3. **Worker (`worker.ts`)**:
   - Imports and uses processor logic
   - Handles all processing in a background thread
   - Sends results back to the main thread

4. **Processor (`processor.ts`)**:
   - Refactored to be a library of processing functions
   - No direct processing in the main thread
   - Functions are imported and used by the worker

5. **Handlers (`handlers/index.ts`)**:
   - Maintain the existing handler implementations
   - Update registration to work with the new processor library
   - Preserve entity-specific business logic

6. **UI Components (`ui/index.ts`)**:
   - Preserve the `ChangeMonitor` component
   - Update to work with the worker-client instead of the processor
   - Maintain the same public API

## Implementation Plan

### Phase 1: Refactor Processor

1. Refactor `processor.ts` to be a library of processing functions:
   - Remove direct event listening
   - Export core processing functions
   - Maintain handler registry functionality
   - Remove main thread processing logic

2. Update types and interfaces to support the new architecture:
   - Ensure clear typing for all functions
   - Define interfaces for handlers and processing results
   - Preserve the existing `ChangeHandler` interface

3. Ensure handler registration mechanism is preserved:
   - Create a new registration system that works with the library approach
   - Maintain compatibility with existing handler implementations

### Phase 2: Update Worker

1. Modify `worker.ts` to import and use processor functions:
   - Import processing logic from processor
   - Use the imported functions to process changes
   - Maintain worker-specific messaging logic

2. Enhance error handling and reporting:
   - Improve error messages
   - Add more detailed logging
   - Ensure errors are properly communicated back to the main thread

3. Update handler integration:
   - Ensure the worker can access and use the entity handlers
   - Maintain the same handler registration pattern
   - Preserve entity-specific business logic

### Phase 3: Update Worker-Client

1. Modify `worker-client.ts` to listen for change events:
   - Subscribe to change events from the recorder
   - Automatically send changes to the worker
   - Handle processing results

2. Simplify the API:
   - Remove unnecessary methods
   - Make the interface more intuitive
   - Ensure proper error handling

3. Update UI component integration:
   - Ensure the `ChangeMonitor` component works with the worker-client
   - Update any UI components that directly used the processor
   - Maintain the same public API for UI components

### Phase 4: Integration and Testing

1. Update any code that uses the processor directly:
   - Redirect to worker-client if processing is needed
   - Update imports and function calls

2. Comprehensive testing:
   - Test each component individually
   - Test the entire flow
   - Verify performance improvements
   - Test UI components with the new architecture

3. Test entity handlers:
   - Verify all entity handlers work correctly with the new system
   - Test insert, update, and delete operations for each entity type
   - Ensure business logic is preserved

## UI Components and Handlers Considerations

### UI Components

The changes system includes UI components, particularly the `ChangeMonitor` component, which should be preserved in the refactoring. These components provide:

1. **Monitoring Interface**: Visual representation of change processing status
2. **Debugging Tools**: Interfaces for inspecting and troubleshooting changes
3. **User Feedback**: Information about ongoing operations

The refactoring should:
- Preserve all existing UI components
- Update them to work with the worker-client instead of directly with the processor
- Maintain the same public API to avoid breaking existing code

### Entity Handlers

The handlers system is a critical part of the changes architecture:

1. **Business Logic**: Handlers contain entity-specific business logic
2. **Data Validation**: They validate and transform data during processing
3. **Entity Operations**: They implement insert, update, and delete operations

The current implementation includes:
- A `registerChangeHandlers()` function that sets up all entity handlers
- Entity-specific handlers like `registerUserHandler()`
- Integration with data access classes like `UserDataAccess`

The refactoring should:
- Preserve all existing handler implementations
- Update the registration mechanism to work with the new processor library
- Ensure handlers can be accessed and used by the worker
- Maintain the same handler interface for consistency

## Benefits of the Refactor

1. **Improved Performance**: All processing happens in a background thread, keeping the UI responsive.
2. **Clearer Architecture**: The flow from recording to processing is clear and direct.
3. **Better Separation of Concerns**: Each component has a well-defined responsibility.
4. **Reduced Duplication**: Processing logic is defined once and used by the worker.
5. **Simplified Communication**: The communication flow is streamlined.

## Risks and Mitigations

1. **Risk**: Breaking existing functionality
   **Mitigation**: Comprehensive testing and gradual rollout

2. **Risk**: Performance issues with worker communication
   **Mitigation**: Optimize message passing, batch processing where appropriate

3. **Risk**: Increased complexity in debugging
   **Mitigation**: Improved logging, clear error messages

## Timeline

- Phase 1 (Refactor Processor): 1 day
- Phase 2 (Update Worker): 1 day
- Phase 3 (Update Worker-Client): 1 day
- Phase 4 (Integration and Testing): 2 days

Total estimated time: 5 days

## Conclusion

This refactor will significantly improve the changes system by moving processing to a background thread, clarifying the architecture, and reducing code duplication. The end result will be a more maintainable, performant, and user-friendly system. 