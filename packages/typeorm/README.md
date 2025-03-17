# @repo/typeorm

TypeORM integration for VibeStack with dual-database support. This package manages both server-side PostgreSQL and client-side PGlite databases.

## Quick Start

1. Create entity in `src/entities/`
2. Add appropriate decorators
3. Run `pnpm run build`
4. Generate and run migrations

## Architecture Overview

- **Server**: PostgreSQL database for server-side operations
- **Client**: PGlite database for client-side operations
- Automatic context separation between server and client code
- Built-in replication support for domain entities
- CRDT support with last-write-wins semantics:
  - Domain tables use `client_id` for change tracking
  - Automatic trigger-based `client_id` management
  - Changes recorded in `change_history` table

## Development Guide

### Creating Entities

1. Create file in `src/entities/`
2. Add required decorators:
   - `@Entity()` for TypeORM
   - `@TableCategory()` for replication behavior
   - `@ServerOnly()` or `@ClientOnly()` for context-specific code

### Table Categories

- **Domain**: `@TableCategory('domain')` - Business data, replicated
- **System**: `@TableCategory('system')` - Internal state, not replicated
- **Utility**: `@TableCategory('utility')` - Logs, analytics, not replicated

### Build Process

Always rebuild after ANY entity changes:

```bash
cd packages/typeorm
pnpm run build
```

Required after:
- Adding/modifying entities or fields
- Changing decorators or relationships
- Updating validation rules
- Adding new entities

### Migration Commands

Server migrations:
   ```bash
# Generate
   pnpm run migration:generate:server src/migrations/server/MigrationName
# Run
   pnpm run migration:run:server
   ```

Client migrations:
   ```bash
# Generate
   pnpm run migration:generate:client src/migrations/client/MigrationName
# Run locally
   pnpm run migration:run:client
# Upload to server
   pnpm run migration:upload-client
   ```

### Deployment

Full deployment (server + client):
  ```bash
  pnpm run deploy
  ```

Client-only deployment:
  ```bash
  pnpm run deploy:client
  ```

## Project Structure

```
src/
  ├── entities/           # Entity definitions
  ├── migrations/         # Migration files
  │   ├── server/        # Server migrations
  │   └── client/        # Client migrations
  └── generated/         # Auto-generated files (do not edit)
```

## Configuration

### Server Database

Environment variables:
  - `DATABASE_URL`: Full connection URL
  - `DB_HOST`: Database host
  - `DB_PORT`: Database port
  - `DB_USER`: Database user
  - `DB_PASSWORD`: Database password
  - `DB_NAME`: Database name
  - `DB_SSL`: Enable SSL

### Client Database

- Uses PGlite for local storage
- Data stored in `./pgdata/client`

## Best Practices

1. Always specify context in decorators
2. Generate entities before creating migrations
3. Use appropriate deployment command:
   - `deploy` for full changes
   - `deploy:client` for client-only changes
4. Keep client migrations atomic
5. Document migration dependencies

## License

Private and proprietary.

## CRDT Support

### Client ID Trigger

Domain tables that participate in CRDT operations require a special trigger to handle `client_id` behavior. This trigger ensures proper last-write-wins semantics by:
- Preserving `client_id` only when explicitly set in an update
- Resetting `client_id` to NULL when not changed in an update

After creating new domain tables, you must create a migration to add this trigger. A template is provided in `src/triggers/client-id-trigger.template.ts`. To use it:

1. Copy the template to `src/migrations/server/` with a new timestamp
2. Update the timestamp in the class name and `name` property
3. Run `pnpm run migration:run:server`

Example usage:
```bash
# Copy template (replace timestamp with current)
cp src/triggers/client-id-trigger.template.ts src/migrations/server/1742067963372-AddDomainTableClientIdTriggers.ts

# Update timestamp in the file
# Run migration
pnpm run migration:run:server
```

### Testing Trigger Behavior

You can test the trigger behavior using the TypeORM datasource:

```typescript
// Update with new client_id (will be preserved)
const result = await serverDataSource.query(
  "UPDATE users SET name = $1, client_id = uuid_generate_v4() WHERE id = $2 RETURNING *",
  ["Test User", userId]
);

// Update without client_id (will be reset to NULL)
const followup = await serverDataSource.query(
  "UPDATE users SET name = $1 WHERE id = $2 RETURNING *",
  ["Another Update", userId]
);
``` 