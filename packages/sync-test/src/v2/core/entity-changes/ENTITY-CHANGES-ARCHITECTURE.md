# Entity Changes Module Architecture

## Core Modules and Their Responsibilities

### 1. **entity-adapter.ts** - Foundation Layer
- **Purpose**: Provides core mapping between database entities and their representations
- **Responsibilities**:
  - Define EntityType enum (`user`, `project`, `task`, `comment`)
  - Map entities to tables and back (`TABLE_TO_ENTITY`, `ENTITY_TO_TABLE`)
  - Define dependency order for operations (`DEPENDENCY_ORDER`)
  - Provide type information and access to entity classes

### 2. **entity-factories.ts** - Entity Creation Layer
- **Purpose**: Create entity instances with proper relationships
- **Responsibilities**:
  - Create individual entities (`createUser`, `createProject`, etc.)
  - Handle relationship creation (projects with owners, tasks with assignees)
  - Generate batch entities with proper relationships
  - Ensure all entities have valid references

### 3. **change-builder.ts** - Change Construction Layer
- **Purpose**: Convert entities to change objects
- **Responsibilities**:
  - Transform entities to changes (`entityToChange`)
  - Ensure proper date handling in changes
  - Construct changes for different operations (insert, update, delete)
  - Support batch change construction (`buildChangesFromEntities`)

### 4. **change-applier.ts** - Database Operations Layer
- **Purpose**: Apply changes to the database
- **Responsibilities**:
  - Initialize database connections
  - Execute changes with proper error handling
  - Process operations in the correct order (deletes, inserts, updates)
  - Provide detailed results of database operations

### 5. **change-tracker.ts** - Change Tracking Layer
- **Purpose**: Track changes for record-keeping and validation
- **Responsibilities**:
  - Record applied changes by batch
  - Track LSN (Log Sequence Number) values
  - Manage entity ID tracking and deduplication
  - Release previously updated entity IDs after a cooling period

### 6. **change-state.ts** - Test State Management Layer
- **Purpose**: Manage state during tests
- **Responsibilities**:
  - Track changes received by clients
  - Record database changes
  - Calculate progress metrics
  - Detect duplicate changes

### 7. **validation.ts** - Validation Layer
- **Purpose**: Validate synced changes (not pre-validation)
- **Responsibilities**:
  - Compare database changes with client changes
  - Detect missing or extra changes
  - Validate change matching
  - Generate validation reports

### 8. **batch-changes.ts** - Orchestration Layer
- **Purpose**: Coordinate the change generation process
- **Responsibilities**:
  - Coordinate entity creation, change building, and application
  - Manage distribution of entity types
  - Handle intentional duplicate generation
  - Return comprehensive results

## Data Flow Architecture

```
┌────────────────────┐
│ Test Scenarios     │◄────────────────────────────────────┐
└─────────┬──────────┘                                     │
          │                                                │
          ▼                                                │
┌────────────────────┐                                     │
│ batch-changes.ts   │                                     │
│ (Orchestrator)     │                                     │
└─────────┬──────────┘                                     │
          │                                                │
          ▼                                                │
┌────────────────────┐    ┌────────────────────┐          │
│ entity-factories.ts│◄───┤ entity-adapter.ts  │          │
│ (Entity Creation)  │    │ (Foundation)       │          │
└─────────┬──────────┘    └────────────────────┘          │
          │                                                │
          ▼                                                │
┌────────────────────┐                                     │
│ change-builder.ts  │                                     │
│ (Change Creation)  │                                     │
└─────────┬──────────┘                                     │
          │                                                │
          ▼                                                │
┌────────────────────┐                                     │
│ change-applier.ts  │                                     │
│ (Database Ops)     │                                     │
└─────────┬──────────┘                                     │
          │                                                │
          │                                                │
     ┌────┴───────┐                                        │
     │            │                                        │
     ▼            ▼                                        │
┌─────────────┐  ┌─────────────┐       ┌─────────────┐    │
│change-tracker│  │change-state │       │validation.ts│    │
│(Tracking)    │  │(Test State) │       │(Validation) ├────┘
└─────────────┘  └─────────────┘       └─────────────┘
```

## Function Call Flow

1. **Test calls**: `generateAndApplyMixedChanges(count, options, changeTracker)`
2. **batch-changes.ts**: 
   - Calculates entity counts and distribution
   - Coordinates the entire process
3. **entity-factories.ts**:
   - Creates `user` entities
   - Creates `project` entities with user references
   - Creates `task` entities with project and user references
   - Creates `comment` entities with proper entity and author references
4. **change-builder.ts**:
   - Converts all created entities to change objects
   - Ensures dates are properly handled
5. **change-applier.ts**:
   - Applies changes to database with error handling
   - Returns results of database operations
6. **change-tracker.ts**:
   - Records applied changes and IDs
   - Helps with duplicate detection in future runs
7. **change-state.ts**:
   - Records changes for test state management
8. **validation.ts**:
   - Used by tests to validate sync results

## Key Design Principles

1. **Separation of Concerns**: Each module has a single, well-defined responsibility
2. **Dependency Direction**: Dependencies flow downward, with higher-level modules using lower-level ones
3. **Error Isolation**: Errors in one component don't crash the entire system
4. **Atomic Operations**: Each change is self-contained and can succeed or fail independently
5. **Configurability**: Behavior can be customized through options without changing code

## Common Issues and Solutions

1. **Date Handling**: Ensure all date fields are properly converted to Date objects before database operations
2. **Foreign Key Violations**: Use proper relationship validation and entity fetching before creating dependent entities
3. **Duplicate Updates**: Implement a cooling period for entity IDs to prevent unintentional duplicates
4. **Validation**: Test validation compares applied changes with received changes, not pre-database validation 