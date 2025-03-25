# Sync Test

A test framework for the bi-directional sync infrastructure in VibeStack.

## Test Scenarios

This package provides test scenarios for various sync workflows:

- **Initial Sync**: Tests the complete database synchronization process for new clients
- **Catchup Sync**: Tests the synchronization process for clients reconnecting after being offline
- **Client Changes**: Tests changes made by clients being properly synchronized with the server
- **Live Sync**: Tests real-time update propagation between server and clients

## LSN State

The last known Log Sequence Number (LSN) is stored in `.sync-test-lsn.json` at the root of this package.

This file is written during the initial sync test and read during the catchup sync test to track the PostgreSQL WAL position.

## Seed Data

The package includes a seed data generator to create realistic test data with interconnected relationships:

```bash
# Interactive seed data generator
pnpm seed

# Generate data with preset sizes
pnpm seed:small   # 25 users  - clears existing data
pnpm seed:medium  # 200 users - clears existing data  
pnpm seed:large   # 1000 users - clears existing data
```

**Note:** The seed functionality assumes your database schema is already set up through migrations. It only handles populating data, not creating or modifying schema.

For more information, see the [Seed Data Generator documentation](./src/seed/README.md).

## Running Tests

```bash
# Run all tests
pnpm test:all

# Run a specific scenario
pnpm test:initial
pnpm test:catchup
pnpm test:changes
pnpm test:live
``` 