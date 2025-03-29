# VibeStack Sync Test Framework V2

This framework provides utilities for testing synchronization functionality in the VibeStack application.

## Architecture

The V2 version of the sync test framework uses a direct implementation approach for testing:

### Core Components

1. **WebSocketClientFactory**: Manages WebSocket clients directly without worker threads
   - Creates and manages multiple WebSocket connections
   - Handles message sending/receiving
   - Provides event handling capabilities

2. **DB Service**: Provides direct database operations
   - Connects to the database directly
   - Executes database changes (create, update, delete)
   - Manages LSN tracking and replication setup

3. **Live Sync Test**: Implements the test scenarios directly
   - Creates test clients
   - Orchestrates the test flow
   - Processes test results

4. **CLI**: Command-line interface for running tests
   - Interactive mode for manual testing
   - Command-line arguments for automated testing
   - Detailed reporting of test results

## Usage

### Running Tests

```bash
# Run an interactive test
pnpm run test

# Run a live sync test with 2 clients and 10 changes each
pnpm run test test -s live-sync -c 10 -n 2

# Run an initial sync test
pnpm run test test -s initial
```

### Creating Custom Tests

To create a custom test, you can:

1. Create a new scenario file in `src/v2/scenarios/`
2. Use the WebSocketClientFactory and DB Service directly
3. Implement the test logic
4. Register the test in the CLI

## Benefits of Direct Implementation

1. **Simpler Architecture**: No need for complex worker coordination
2. **Better Debugging**: Direct code flow is easier to trace and debug
3. **Improved Performance**: Fewer message passing overheads
4. **Easier Maintenance**: Code is more modular and focused

## Development Notes

- The WebSocket client factory is implemented as a singleton for easy access
- Database operations are executed directly via the Neon serverless database client
- Test scenarios can use both components to implement complex test cases 