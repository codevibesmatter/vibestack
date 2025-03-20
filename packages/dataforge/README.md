# @repo/dataforge

A powerful data layer factory that forges the foundation of VibeStack's data architecture. DataForge crafts schemas, types, migrations, and sync tools for both server and client databases.

## Features

🔨 **Schema Forging**
- Database schema definitions
- Type-safe interfaces
- Migration management
- Dual-database support (PostgreSQL/PGlite)

⚡ **Type Generation**
- Build-time type safety
- Generated TypeScript interfaces
- IDE support
- Zero runtime overhead

🔄 **Sync Architecture**
- CRDT support
- Last-write-wins semantics
- Change tracking
- Conflict resolution

🏗️ **Future Capabilities**
- API endpoint generation
- Client SDK forging
- Query builder crafting
- State management tools
- Development utilities

## Quick Start

1. Define your schema in `src/entities/`
2. Forge your types with `pnpm run build`
3. Generate migrations
4. Deploy with confidence

## Architecture

DataForge provides type safety through multiple layers:

1. **Build Time**
   - TypeScript interfaces
   - Schema validation
   - Relationship checking

2. **Runtime**
   - Database constraints
   - Foreign key integrity
   - Unique constraints
   - Check constraints

3. **Deployment**
   - Migration safety
   - Schema verification
   - Type consistency

## Development Guide

### Creating Schemas

1. Create file in `src/entities/`
2. Define your schema with decorators
3. Run `pnpm run build` to forge types
4. Generate and run migrations

### Table Categories

- **Domain**: `@TableCategory('domain')` - Business data, replicated
- **System**: `@TableCategory('system')` - Internal state
- **Utility**: `@TableCategory('utility')` - Logs, analytics

### Commands

```bash
# Forge your types
pnpm run build

# Generate migrations
pnpm run migration:generate:server src/migrations/server/MigrationName
pnpm run migration:generate:client src/migrations/client/MigrationName

# Deploy
pnpm run deploy        # Full deployment
pnpm run deploy:client # Client-only
```

## Project Structure

```
src/
  ├── entities/           # Schema definitions
  ├── migrations/         # Forged migrations
  │   ├── server/        # Server migrations
  │   └── client/        # Client migrations
  └── generated/         # Forged types and exports
```

## Best Practices

1. Define schemas clearly and completely
2. Let TypeScript and Postgres handle validation
3. Use appropriate deployment commands
4. Keep migrations atomic
5. Document dependencies
6. Trust the type system

## CRDT Support

DataForge provides built-in CRDT support through:
- Automatic client ID management
- Last-write-wins conflict resolution
- Change tracking and history
- Trigger-based integrity

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

## License

Private and proprietary.