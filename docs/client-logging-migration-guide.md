# Client Logging Migration Guide

## Overview

We've implemented a new structured logging system for the client-side application to improve consistency, maintainability, and debugging capabilities. This guide explains how to migrate existing code to use the new logging system.

## Key Changes

1. Replaced direct `console.log/error/warn` calls with structured logger
2. Added support for different log levels and contexts
3. Improved error handling and formatting
4. Environment-based filtering for production vs development

## How to Migrate

### 1. Import the Logger

```typescript
import { clientLogger } from '../../utils/logger';
// Or use a specialized logger:
import { syncLogger, connectionLogger, uiLogger } from '../../utils/logger';
```

### 2. Replace Console Calls

| Old | New |
|-----|-----|
| `console.log('Message', data)` | `clientLogger.info('Message', data)` |
| `console.error('Error', err)` | `clientLogger.error('Error', err)` |
| `console.warn('Warning', data)` | `clientLogger.warn('Warning', data)` |
| `console.debug('Debug', data)` | `clientLogger.debug('Debug', data)` |

### 3. Use Context-Specific Loggers

For module-specific logging, use the pre-defined context loggers:

```typescript
// For sync module
syncLogger.info('Message', data);

// For connection-related operations
connectionLogger.info('Message', data);

// For UI components
uiLogger.info('Message', data);
```

### 4. Create Custom Context Loggers

For other modules, create a context-specific logger:

```typescript
const myFeatureLogger = clientLogger.withContext('my-feature');
myFeatureLogger.info('Message', data);
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
console.error('Failed to fetch data:', {
  error: err instanceof Error ? err.message : String(err),
  url: endpoint
});

// New way
syncLogger.error('Failed to fetch data', err, { url: endpoint });
```

This ensures proper error stack traces and formatting.

### 7. Structured Data

When including data with your log message, pass it as a separate parameter:

```typescript
// Old way
console.log(`User ${userId} performed action ${actionType}`);

// New way
uiLogger.info('User performed action', { userId, actionType });
```

This makes logs more searchable and easier to parse.

### 8. Component Logging

In React components, create a component-specific logger:

```typescript
const SomeComponent = () => {
  const componentLogger = uiLogger.withContext('SomeComponent');
  
  useEffect(() => {
    componentLogger.debug('Component mounted');
    return () => componentLogger.debug('Component unmounted');
  }, []);
  
  const handleClick = () => {
    componentLogger.info('Button clicked', { timestamp: Date.now() });
    // ...
  };
  
  // ...
};
```

## Examples

### Before:

```typescript
console.log('🔄 Reconnecting to WebSocket:', {
  attempt: reconnectAttempt,
  backoffMs: backoffTime,
  lastDisconnect: lastDisconnectTime
});

try {
  await performOperation();
} catch (err) {
  console.error('Failed to perform operation:', err);
}
```

### After:

```typescript
connectionLogger.info('Reconnecting to WebSocket', {
  attempt: reconnectAttempt,
  backoffMs: backoffTime,
  lastDisconnect: lastDisconnectTime
});

try {
  await performOperation();
} catch (err) {
  syncLogger.error('Failed to perform operation', err);
}
```

## Benefits

1. **Consistent Format**: All logs follow the same format with timestamps, levels, and context
2. **Filtering**: Logs can be filtered by level, making it easier to focus on important messages
3. **Context**: Each log includes its module context, making it easier to trace issues
4. **Structured Data**: Data is consistently formatted for better analysis
5. **Error Handling**: Proper error object handling preserves stack traces
6. **Production Ready**: Automatically adjusts verbosity based on environment

## Configuration

The logger is configured in `apps/web/src/utils/logger.ts`. You can adjust:

- Log levels for different environments
- Pretty printing for development
- Context formatting
- Browser console integration

## Debugging in Production

For production debugging, the logger supports enabling specific log levels via localStorage:

```javascript
// In browser console
localStorage.setItem('logLevel', 'debug');
// Refresh the page
```

This allows temporary debugging in production environments without deploying code changes. 