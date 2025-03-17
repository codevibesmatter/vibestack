# @repo/shared-types

This package contains application-specific TypeScript types and service interfaces. It works in conjunction with `@repo/schema` which provides the core domain models.

## Package Responsibilities

This package focuses on:
1. Service layer interfaces and types
2. Application infrastructure types
3. Platform-specific types (Cloudflare, etc.)
4. Error handling patterns
5. Store management types
6. UI component types

Core domain models and validation are handled by `@repo/schema`.

## Directory Structure

```
src/
├── services/           # Service interfaces and types
│   ├── base/          # Base service patterns
│   ├── task/          # Task service types
│   ├── project/       # Project service types
│   └── user/          # User service types
│
├── types/             # Common type definitions
│   ├── service.ts     # Service-related types
│   ├── query.ts       # Query and pagination
│   └── result.ts      # Operation results
│
├── error/             # Error handling
│   ├── service.ts     # Service errors
│   └── validation.ts  # Validation errors
│
├── store/             # Store management
│   ├── config.ts      # Store configuration
│   └── operations.ts  # Store operations
│
├── platform/          # Platform integration
│   ├── cloudflare/    # Cloudflare types
│   └── env/          # Environment types
│
└── ui/               # UI-specific types
    ├── components/    # Component props
    └── forms/        # Form types
```

## Key Features

### Service Layer
- Type-safe service interfaces
- Generic CRUD operations
- Query and pagination
- Error handling patterns
- Validation integration

### Infrastructure
- Platform-specific type definitions
- Environment configuration
- Error tracking and metrics
- Store management

### UI Types
- Component prop types
- Form handling
- State management

## Usage Examples

### Service Implementation
```typescript
import { Task, TaskSchema } from '@repo/schema';
import { ITaskService, ServiceResult } from './services';

class TaskService implements ITaskService {
  async createTask(data: unknown): Promise<ServiceResult<Task>> {
    const validation = TaskSchema.safeParse(data);
    if (!validation.success) {
      return {
        success: false,
        error: new ServiceError('VALIDATION_ERROR', validation.error)
      };
    }
    // ... implementation
  }
}
```

### Query Operations
```typescript
import { QueryOptions, QueryResult } from './types';

async function queryTasks(options: QueryOptions): Promise<QueryResult<Task>> {
  // ... implementation
}
```

### Error Handling
```typescript
import { ServiceError, ErrorType } from './error';

try {
  // ... operation
} catch (error) {
  throw new ServiceError(ErrorType.OPERATION_FAILED, error.message);
}
```

## Documentation

See the following guides for detailed documentation:
- [Service Patterns](./docs/SERVICE_PATTERNS.md) - Service layer implementation patterns
- [Type Guidelines](./docs/TYPES_GUIDELINES.md) - When to use schema vs shared types
- [Error Handling](./docs/ERROR_HANDLING.md) - Error handling patterns

## Contributing

When adding new types:
1. Determine if the type belongs in `@repo/schema` or here
2. Place service-specific types in appropriate service directory
3. Update relevant documentation
4. Follow established patterns
5. Add tests where appropriate

## Best Practices

1. **Type Imports**
   - Import domain types from `@repo/schema`
   - Use `import type` for type-only imports
   - Keep service types close to their service

2. **Service Organization**
   - One directory per service domain
   - Shared utilities in common locations
   - Clear separation of concerns

3. **Error Handling**
   - Use `ServiceResult` type for operations
   - Proper error categorization
   - Consistent error patterns

4. **Documentation**
   - Document service interfaces
   - Include usage examples
   - Keep docs up to date 