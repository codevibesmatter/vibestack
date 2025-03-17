# Type Usage Guidelines

This document provides guidelines for when to use types from `@repo/schema` versus `@repo/shared-types`.

## Core Principle

The main principle is separation of concerns:
- `@repo/schema`: Data models and validation
- `@repo/shared-types`: Application behavior and infrastructure

## When to Use @repo/schema

Use types from `@repo/schema` when dealing with:

1. **Core Domain Entities**
   ```typescript
   import { Task, Project, User } from '@repo/schema';
   ```
   - Database entities
   - API request/response bodies
   - Core business objects

2. **Validation Rules**
   ```typescript
   import { TaskSchema, ProjectSchema } from '@repo/schema';
   ```
   - Data validation
   - Input sanitization
   - Schema enforcement

3. **Common Types**
   ```typescript
   import { UUID, Email, NonEmptyString } from '@repo/schema';
   ```
   - Shared primitive types
   - Common constraints
   - Reusable validations

4. **Enums and Constants**
   ```typescript
   import { TaskStatus, UserRole } from '@repo/schema';
   ```
   - Domain-specific enums
   - Status values
   - Fixed constants

## When to Use @repo/shared-types

Use types from this package when dealing with:

1. **Service Layer**
   ```typescript
   import { ITaskService, ServiceResult } from '@repo/shared-types';
   ```
   - Service interfaces
   - Operation results
   - Service configuration

2. **Infrastructure**
   ```typescript
   import { CloudflareEnv, WorkerContext } from '@repo/shared-types';
   ```
   - Platform types
   - Environment config
   - Infrastructure setup

3. **Error Handling**
   ```typescript
   import { ServiceError, ErrorType } from '@repo/shared-types';
   ```
   - Error types
   - Error handling patterns
   - Result types

4. **UI Components**
   ```typescript
   import { TaskFormProps, ProjectViewProps } from '@repo/shared-types';
   ```
   - Component props
   - Form types
   - UI state

5. **Query and Pagination**
   ```typescript
   import { QueryOptions, PaginationResult } from '@repo/shared-types';
   ```
   - Search parameters
   - Filter options
   - Sort options

6. **Store Management**
   ```typescript
   import { StoreConfig, StoreMetrics } from '@repo/shared-types';
   ```
   - Store configuration
   - Store operations
   - Metrics and monitoring

## Examples

### Good Pattern
```typescript
// Service using both schema and shared types appropriately
import { Task, TaskSchema } from '@repo/schema';
import { ITaskService, ServiceResult } from '@repo/shared-types';

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

### Anti-Pattern
```typescript
// DON'T: Mixing domain logic with service types
import { Task } from '@repo/schema';

// ❌ Don't define domain types in shared-types
interface ExtendedTask extends Task {
  computedField: string;
}

// ✅ Instead, use composition
interface TaskWithMetrics {
  task: Task;
  metrics: TaskMetrics;
}
```

## Type Extension Patterns

When you need to extend schema types:

1. **Composition Over Extension**
   ```typescript
   // ✅ Good: Compose with new types
   interface TaskView {
     task: Task;
     ui: {
       isExpanded: boolean;
       isSelected: boolean;
     };
   }

   // ❌ Bad: Extending schema types
   interface UITask extends Task {
     isExpanded: boolean;
     isSelected: boolean;
   }
   ```

2. **Service-Specific Types**
   ```typescript
   // ✅ Good: Service-specific wrapper
   interface TaskOperationOptions {
     task: Task;
     userId: UUID;
     timestamp: Date;
   }

   // ❌ Bad: Modifying schema types
   interface TaskWithMetadata extends Task {
     userId: UUID;
     timestamp: Date;
   }
   ```

## Decision Flowchart

When adding new types, ask:

1. Is it a core domain entity or value?
   - Yes → `@repo/schema`
   - No → Continue

2. Is it related to application behavior?
   - Yes → `@repo/shared-types`
   - No → Continue

3. Is it platform or infrastructure specific?
   - Yes → `@repo/shared-types`
   - No → Continue

4. Is it UI or presentation related?
   - Yes → `@repo/shared-types`
   - No → Reconsider if the type is needed

## Maintenance

1. **Regular Review**
   - Audit type usage periodically
   - Move types to correct package
   - Update documentation

2. **Type Migration**
   - Plan type movements carefully
   - Update all imports
   - Maintain backwards compatibility

3. **Documentation**
   - Document type purpose and usage
   - Include examples
   - Keep guidelines updated 