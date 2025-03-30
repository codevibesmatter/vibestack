# Sync Test

A testing framework for validating synchronization functionality between clients and servers.

## Architecture

The sync-test package has been refactored to follow a modular approach with clear separation of concerns:

### Core Components

1. **MessageProcessor** (`packages/sync-test/src/v2/core/message-processor.ts`)
   - Handles parsing and transformation of WebSocket messages
   - Converts between `ServerChangesMessage` and `EntityChange` formats
   - Supports ID mapping for tracking synthetic IDs
   - Imports message types from `@repo/sync-types`

2. **ValidationService** (`packages/sync-test/src/v2/core/validation-service.ts`)
   - Tracks expected and received changes
   - Validates that all changes were received properly
   - Generates validation reports
   - Verifies changes in the database

3. **ScenarioRunner** (`packages/sync-test/src/v2/core/scenario-runner.ts`)
   - Orchestrates test scenarios 
   - Manages test steps and actions
   - Handles test flow and reporting

### Scenarios

Scenarios like `live-sync.ts` orchestrate tests by:
- Setting up database connections
- Creating WebSocket clients
- Generating test changes
- Tracking and validating change synchronization

## Types

The system uses types from two sources:

1. **Internal Types** (`packages/sync-test/src/v2/types.ts`)
   - `EntityChange`: Standardized format for tracking changes
   - `ValidationResult`: Results from validation checks
   - `MissingChangeReport`: Information on missing changes

2. **Sync Types** (`@repo/sync-types`)
   - `ServerChangesMessage`: Format of messages from server
   - `TableChange`: Format of table changes in the database
   - `ClientReceivedMessage`: Client message acknowledging receipt

## Running Tests

```bash
# Run a live sync test with 3 clients and 10 changes per client
npm run test:live-sync -- 3 10
```

## Contributing

When making changes to this codebase:

1. Follow the modular architecture - keep concerns separated
2. Use types from `@repo/sync-types` for messaging
3. Use the local `types.ts` for internal data structures
4. Add tests for any new functionality 