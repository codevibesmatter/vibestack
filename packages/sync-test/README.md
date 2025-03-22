# Sync Test

A test framework for the bi-directional sync infrastructure in VibeStack.

## Test Scenarios

This package provides test scenarios for various sync workflows:

- **Initial Sync**: Tests the complete database synchronization process for new clients
- **Catchup Sync**: Tests the synchronization process for clients reconnecting after being offline
- **Client Changes**: Tests changes made by clients being properly synchronized with the server

## LSN State

The last known Log Sequence Number (LSN) is stored in `.sync-test-lsn.json` at the root of this package.

This file is written during the initial sync test and read during the catchup sync test to track the PostgreSQL WAL position.

## Running Tests

```bash
# Run all tests
pnpm test

# Run a specific scenario
pnpm test:initial
pnpm test:catchup
pnpm test:client
``` 