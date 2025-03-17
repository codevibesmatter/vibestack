# Server Logging Migration Guide

## Overview

We've implemented a new structured logging system to improve consistency and maintainability. This guide explains how to migrate existing code to use the new logging system.

## Key Changes

1. Replaced direct `console.log/error/warn` calls with structured logger
2. Consolidated multiple logging middleware into a single approach
3. Added support for different log levels and contexts
4. Improved formatting and filtering options

## How to Migrate

### 1. Import the Logger

```typescript
import { serverLogger } from '../middleware/logger';
// Or use a specialized logger:
import { syncLogger, replicationLogger, apiLogger, dbLogger, connectionLogger } from '../middleware/logger';
```

### 2. Replace Console Calls

| Old | New |
|-----|-----|
| `console.log('Message', data)` | `serverLogger.info('Message', data)` |
| `console.error('Error', err)` | `serverLogger.error('Error', err)` |
| `console.warn('Warning', data)` | `serverLogger.warn('Warning', data)` |
| `console.debug('Debug', data)` | `serverLogger.debug('Debug', data)` |

### 3. Use Context-Specific Loggers

For module-specific logging, use the pre-defined context loggers:

```typescript
// For sync module
syncLogger.info('Message', data);

// For replication module
replicationLogger.info('Message', data);

// For API module
apiLogger.info('Message', data);

// For database operations
dbLogger.info('Message', data);

// For connection-related operations
connectionLogger.info('Message', data);
```

### 4. Create Custom Context Loggers

For other modules, create a context-specific logger:

```typescript
const myModuleLogger = serverLogger.withContext('my-module');
myModuleLogger.info('Message', data);
```

### 5. Log Levels

Use the appropriate log level for your message:

- `debug`: Detailed information for debugging
- `info`: General information about system operation
- `warn`: Warning conditions that don't affect normal operation
- `error`: Error conditions that affect operation but don't cause system failure

### 6. Error Logging

When logging errors, pass the error object as the second parameter:

```typescript
// Old way
console.error('Failed to process data:', {
  error: err instanceof Error ? err.message : String(err),
  data: someData
});

// New way
serverLogger.error('Failed to process data', err, someData);
```

This ensures proper error stack traces and formatting.

### 7. Structured Data

When including data with your log message, pass it as a separate parameter:

```typescript
// Old way
console.log(`User ${userId} logged in from ${ip}`);

// New way
serverLogger.info('User logged in', { userId, ip });
```

This makes logs more searchable and easier to parse.

### 8. Request Context

In request handlers, you can access the request ID from the context:

```typescript
app.get('/api/resource', (c) => {
  const requestId = c.get('requestId');
  apiLogger.info('Processing request', { requestId, resource: 'example' });
  // ...
});
```

## Examples

### Before:

```typescript
console.log('🔄 Processing changes:', {
  count: changes.length,
  tables: Array.from(changeStats.tables),
  operations: Array.from(changeStats.operations),
  lsn: {
    start: changes[0].lsn,
    end: changes[changes.length - 1].lsn
  },
  duration_ms: Date.now() - new Date(changeStats.timestamp).getTime()
});
```

### After:

```typescript
replicationLogger.info('Processing changes', {
  count: changes.length,
  tables: Array.from(changeStats.tables),
  operations: Array.from(changeStats.operations),
  lsn: {
    start: changes[0].lsn,
    end: changes[changes.length - 1].lsn
  },
  duration_ms: Date.now() - new Date(changeStats.timestamp).getTime()
});
```

## Benefits

1. **Consistent Format**: All logs follow the same format with timestamps, levels, and context
2. **Filtering**: Logs can be filtered by level, making it easier to focus on important messages
3. **Context**: Each log includes its module context, making it easier to trace issues
4. **Structured Data**: Data is consistently formatted for better analysis
5. **Error Handling**: Proper error object handling preserves stack traces
6. **Production Ready**: Automatically adjusts verbosity based on environment

## Configuration

The logger is configured in `apps/server/src/middleware/logger.ts`. You can adjust:

- Log levels for different environments
- Pretty printing for development
- Request body and header inclusion
- Path exclusions for health checks and other noisy endpoints
- Header exclusions for sensitive information 