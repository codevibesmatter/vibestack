# Code Quality Checker

A TypeScript-based code quality checker that enforces best practices and maintainable code patterns.

## Overview

The code quality checker analyzes TypeScript files for various metrics and patterns to ensure code maintainability and readability. It provides warnings and errors based on configurable thresholds.

## Quality Metrics

### Nesting Depth
Controls the maximum allowed nesting levels in functions.

- **Warning Threshold**: > 4 levels
- **Error Threshold**: > 8 levels

Recommendations for reducing nesting:
1. Use early returns with guard clauses
2. Extract complex conditions into separate functions
3. Use async/await instead of nested callbacks
4. Break down large functions into smaller, focused ones

### Function Complexity
- **Max Functions per File**: 15
- **Max Cyclomatic Complexity**: 12
- **Max Parameters**: 4
- **Max Return Points**: 3
- **Max Line Count**: 50

### Async Code Quality
- **Max Callback Chain Depth**: 3
- **Max Async Complexity**: 4
- **Max Async State Modifications**: 2

### State Management
- **Max State Properties**: 8
- **Max State Access Points**: 5
- **Max State Dependencies**: 3

### File Organization
- **Max File Size**: 100KB
- **Max Dependencies**: 12

## Common Violations and Solutions

### Deep Nesting (Warning: >4 levels)
```typescript
// ❌ Bad
function processData(data: Data) {
  if (data.isValid) {
    if (data.hasPermission) {
      if (data.isComplete) {
        // Deep nesting
      }
    }
  }
}

// ✅ Good
function processData(data: Data) {
  if (!data.isValid) return;
  if (!data.hasPermission) return;
  if (!data.isComplete) return;
  
  // Logic at root level
}
```

### Excessive Nesting (Error: >8 levels)
Common causes:
1. Complex conditional logic
2. Nested callbacks
3. Deep error handling
4. Nested loops

Solutions:
```typescript
// ❌ Bad
async function processUserData(userId: string) {
  try {
    const user = await getUser(userId);
    if (user) {
      const orders = await getOrders(user.id);
      if (orders.length) {
        orders.forEach(order => {
          if (order.status === 'pending') {
            // Deep nesting
          }
        });
      }
    }
  } catch (error) {
    // Error handling
  }
}

// ✅ Good
async function processUserData(userId: string) {
  const user = await getUserOrThrow(userId);
  const orders = await getOrdersOrDefault(user.id, []);
  const pendingOrders = orders.filter(order => order.status === 'pending');
  
  await Promise.all(pendingOrders.map(processPendingOrder));
}
```

### Callback Chains
```typescript
// ❌ Bad
getData()
  .then(data => processData(data))
  .then(result => validateResult(result))
  .then(valid => saveValid(valid))
  .catch(error => handleError(error));

// ✅ Good
async function handleDataFlow() {
  try {
    const data = await getData();
    const result = await processData(data);
    const valid = await validateResult(result);
    return saveValid(valid);
  } catch (error) {
    return handleError(error);
  }
}
```

## Configuration

The checker can be configured by modifying the `CodeQualityConfig` interface:

```typescript
interface CodeQualityConfig {
  maxFileSize: number;
  maxFunctions: number;
  maxComplexity: number;
  maxDependencies: number;
  maxStateProperties: number;
  enforceNaming: boolean;
  maxNestingDepth: {
    warning: number;
    error: number;
  };
  // ... other metrics
}
```

## Usage

Run the checker using:

```bash
pnpm code-quality
```

## Best Practices

1. **Function Organization**
   - Keep functions small and focused
   - Use early returns to reduce nesting
   - Extract complex logic into helper functions

2. **Async Code**
   - Prefer async/await over promise chains
   - Handle errors at appropriate levels
   - Group related async operations

3. **State Management**
   - Centralize state access
   - Use immutable patterns
   - Minimize state dependencies

4. **Type Safety**
   - Avoid type assertions
   - Use type guards
   - Leverage union types for better control flow

## Common Refactoring Patterns

1. **Extract Method**
   ```typescript
   // Before
   if (condition) {
     // complex logic
   }

   // After
   function handleCondition() {
     // complex logic
   }
   if (condition) handleCondition();
   ```

2. **Guard Clauses**
   ```typescript
   // Before
   if (isValid) {
     // main logic
   }

   // After
   if (!isValid) return;
   // main logic
   ```

3. **Async/Await**
   ```typescript
   // Before
   promise
     .then(data => process(data))
     .catch(error => handle(error));

   // After
   try {
     const data = await promise;
     await process(data);
   } catch (error) {
     await handle(error);
   }
   ``` 