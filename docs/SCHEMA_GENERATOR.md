# Schema Generator and Validation System

## Overview

A centralized system for managing data schemas across the application, with built-in validation and code generation capabilities. This system ensures type safety, consistent data modeling, and proper schema usage throughout the codebase.

## Core Components

### 1. Central Schema Definition

Located at `schema.json` in the project root:

```json
{
  "metadata": {
    "version": "1.0.0",
    "namespace": "@repo/schema"
  },
  "tables": {
    "task": {
      "description": "Represents a task in the system",
      "fields": {
        "id": {
          "type": "uuid",
          "description": "Unique identifier",
          "required": true
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255,
          "description": "Task title",
          "required": true
        }
      },
      "validation": {
        "rules": [
          {
            "type": "dependency",
            "when": "status === 'blocked'",
            "require": ["blockedReason"]
          }
        ]
      },
      "usage": {
        "allowedIn": ["components", "hooks", "services"],
        "patterns": {
          "components": "must use TaskSchema.parse()",
          "services": "must use TaskSchema.safeParse()"
        }
      }
    }
  }
}
```

### 2. Generated Artifacts

The schema generator produces:

- Core Zod schemas (`packages/schema/src/core/`)
- TinyBase-specific schemas (`packages/schema/src/tinybase/`)
- Database schemas (`packages/schema/src/db/`)
- TypeScript types
- ESLint validation rules
- Test utilities
- Documentation

### 3. Validation System

#### Static Analysis (ESLint)
```typescript
// eslint-plugin-schema-validation
export const schemaValidationRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce correct schema usage',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        // Validate schema imports
      },
      CallExpression(node) {
        // Validate schema usage
      }
    };
  },
};
```

#### Runtime Validation
```typescript
export const validateTaskUsage = (context: string, task: Task) => {
  switch(context) {
    case 'component':
      return TaskSchema.parse(task);
    case 'service':
      return TaskSchema.safeParse(task);
  }
};
```

## Implementation

### 1. Schema Generator

```typescript
class SchemaGenerator {
  async generate() {
    // Read schema definition
    const schema = await this.readSchema();
    
    // Generate schemas
    await this.generateCore(schema);
    await this.generateTinyBase(schema);
    await this.generateDb(schema);
    
    // Generate validation
    await this.generateValidation(schema);
    
    // Generate documentation
    await this.generateDocs(schema);
  }
}
```

### 2. Build Integration

```json
{
  "scripts": {
    "generate:schemas": "ts-node scripts/generate-schemas.ts",
    "validate:schemas": "eslint . --ext .ts,.tsx -c .eslintrc.schema.js",
    "test:schemas": "jest --testPathPattern=.*\\.schema\\.test\\.ts$"
  }
}
```

### 3. CI/CD Integration

```yaml
# .github/workflows/schema-validation.yml
name: Schema Validation
on: [push, pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Generate schemas
        run: npm run generate:schemas
      - name: Validate schemas
        run: npm run validate:schemas
```

## Usage Guidelines

### 1. Adding New Schemas

1. Add schema definition to `schema.json`
2. Run schema generator
3. Update tests if needed
4. Commit generated files

### 2. Using Schemas in Code

```typescript
// In components
import { TaskSchema } from '@repo/schema';

const Task = () => {
  const task = TaskSchema.parse(data);
  return <div>{task.title}</div>;
};

// In services
const createTask = async (data: unknown) => {
  const result = TaskSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error);
  }
  return result.data;
};
```

### 3. Testing

```typescript
import { createTestTask, expectValidTask } from '@repo/schema/test-utils';

describe('Task', () => {
  it('validates correctly', () => {
    const task = createTestTask({ title: 'Test' });
    expectValidTask(task);
  });
});
```

## Benefits

1. **Type Safety**
   - Consistent types across layers
   - Runtime validation
   - Compile-time checks

2. **Developer Experience**
   - Automated code generation
   - Clear validation rules
   - IDE integration
   - Test utilities

3. **Maintainability**
   - Single source of truth
   - Automated documentation
   - Validation enforcement
   - Easy schema updates

## Future Improvements

1. **Schema Evolution**
   - Version management
   - Migration generation
   - Backward compatibility checks

2. **Enhanced Validation**
   - Custom validation rules
   - Cross-field validation
   - Async validation

3. **Developer Tools**
   - Schema visualization
   - Migration assistance
   - Schema diff tool
   - Performance analysis

## References

- [json-schema-to-zod](https://www.npmjs.com/package/json-schema-to-zod)
- [zod-to-ts](https://github.com/sachinraja/zod-to-ts)
- [ESLint Custom Rules](https://eslint.org/docs/developer-guide/working-with-rules) 