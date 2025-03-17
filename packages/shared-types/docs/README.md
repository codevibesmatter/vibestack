# @repo/shared-types

This package contains all shared TypeScript type definitions and schemas for our application. It provides type safety and consistency across the entire codebase.

## Directory Structure

```
src/
├── tinybase/           # TinyBase-specific types and utilities
│   ├── core/          # Core TinyBase type definitions
│   ├── operations/    # CRUD and transaction types
│   ├── store/         # Type-safe store implementation
│   ├── sync/          # WebSocket sync types
│   └── metrics/       # Store metrics types
│
├── domain/            # Domain-specific types
│   ├── schemas/       # Zod schemas for domain entities
│   └── enums/         # Domain enums and constants
│
├── serialization/     # Serialization utilities
│   ├── core/          # Generic serialization types
│   ├── tinybase/      # TinyBase serialization
│   └── postgres/      # PostgreSQL serialization
│
├── cloudflare/        # Cloudflare Workers types
│   ├── common.ts      # Shared Cloudflare types
│   ├── env.ts         # Environment bindings
│   ├── worker.ts      # Worker-specific types
│   └── durable-object.ts  # DO-specific types
│
└── error/            # Error tracking and handling
```

## Key Features

### Domain Types
- Strong typing for all domain entities (Users, Projects, Tasks)
- Zod schemas for runtime validation
- Clear separation between sync and PostgreSQL-only fields

### TinyBase Integration
- Type-safe store operations with schema validation
- Automatic conversion from Zod schemas to TinyBase schemas
- WebSocket sync type definitions
- Metrics and monitoring types
- Transaction and operation types

### Serialization
- Type-safe JSON serialization
- TinyBase <-> PostgreSQL data mapping
- Validation and error handling

### Infrastructure
- Complete Cloudflare Workers type definitions
- Environment and binding types
- Error tracking and metrics

## Usage Examples

### Domain Schemas
```typescript
import { userSyncableSchema, type UserSyncable } from '@repo/shared-types/domain/schemas';

// Runtime validation
const result = userSyncableSchema.safeParse(data);
if (result.success) {
  const user: UserSyncable = result.data;
}
```

### TinyBase Store with Zod Schema
```typescript
import { zodToTinybaseCells } from '@repo/shared-types/tinybase/store';
import { userSyncableSchema } from '@repo/shared-types/domain/schemas';

// Convert Zod schema to TinyBase cell definitions
const cells = zodToTinybaseCells(userSyncableSchema);

// Use in store configuration
const storeConfig = {
  schema: {
    users: cells
  },
  strict: true
};
```

### Type-Safe Store Operations
```typescript
import { TypedStore } from '@repo/shared-types/tinybase/store';
import type { StoreMetrics } from '@repo/shared-types/tinybase/metrics';

// Type-safe store operations
const store = new TypedStore(schema);
const metrics: StoreMetrics = store.getMetrics();
```

### Serialization
```typescript
import { safeStringify, safeParse } from '@repo/shared-types/serialization/core';

// Type-safe serialization
const result = safeStringify(data);
if (result.success) {
  const json = result.data;
}
```

## Best Practices

1. **Type Imports**
   - Use `import type` for type-only imports
   - Export types through index files
   - Keep type definitions close to their usage

2. **Schema Organization**
   - Base schemas for common fields
   - Clear separation of sync vs PostgreSQL fields
   - Reuse schemas through composition
   - Use Zod schemas for runtime validation
   - Convert Zod schemas to TinyBase schemas when needed

3. **Error Handling**
   - Use Result types for operations that can fail
   - Proper error typing and categorization
   - Consistent error handling patterns

4. **Documentation**
   - Document complex type relationships
   - Include examples for non-obvious usage
   - Keep documentation close to code

## Type Conversion

### Zod to TinyBase Schema
The package provides automatic conversion from Zod schemas to TinyBase cell definitions:

```typescript
import { zodToTinybaseCells } from '@repo/shared-types/tinybase/store';

// Converts Zod types to TinyBase cell types:
// - ZodString -> { type: 'string' }
// - ZodNumber -> { type: 'number' }
// - ZodBoolean -> { type: 'boolean' }
// - ZodEnum -> { type: 'string' }
// - ZodArray -> { type: 'string' } (serialized)
// - ZodObject -> { type: 'string' } (serialized)
```

## Contributing

When adding new types:
1. Place them in the appropriate directory
2. Update relevant index files
3. Add necessary documentation
4. Include runtime validations where needed
5. Consider backwards compatibility 
6. Add conversion utilities if needed 