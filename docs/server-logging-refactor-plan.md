# Server Logging Refactor Plan

## Current Issues

After reviewing the server-side codebase, we've identified several issues with the current logging approach:

1. **Inconsistent Logging Methods**:
   - Direct `console.log/error/warn` calls throughout the codebase
   - Hono's built-in logger middleware for HTTP requests
   - Custom logging middleware in `index.ts`
   - No standardized format or structure

2. **Lack of Structured Format**:
   - Some logs use objects with context, others use plain strings
   - No consistent log level indication
   - No consistent timestamp format
   - No correlation IDs between related logs

3. **Excessive Logging**:
   - Verbose logging of request/response details
   - Duplicate logging from multiple middleware
   - No filtering based on environment or log level
   - No way to exclude sensitive information

4. **Poor Maintainability**:
   - Difficult to change logging behavior globally
   - No centralized configuration
   - Hard to integrate with external logging services

## Goals

Our refactor aims to:

1. Create a consistent, structured logging approach across the server
2. Reduce noise and duplication in logs
3. Provide appropriate logging levels for different environments
4. Make logs more useful for debugging and monitoring
5. Ensure sensitive information is not logged
6. Prepare for potential integration with external logging services

## Implementation Plan

### Phase 1: Create Structured Logger Middleware

1. Create a custom logger middleware that:
   - Provides consistent log formatting
   - Supports different log levels
   - Includes contextual information
   - Avoids duplicate logging
   - Allows for environment-specific configuration

2. File: `apps/server/src/middleware/logger.ts`

```typescript
import { MiddlewareHandler } from 'hono';
import type { Env } from '@repo/shared-types';

// Log levels
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4
}

// Logger configuration
export interface LoggerConfig {
  level: LogLevel;
  prettyPrint?: boolean;
  includeRequestBody?: boolean;
  includeResponseBody?: boolean;
  includeHeaders?: boolean;
  excludePaths?: string[];
  excludeHeaders?: string[];
}

// Default configuration based on environment
const getDefaultConfig = (): LoggerConfig => ({
  level: process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG,
  prettyPrint: process.env.NODE_ENV !== 'production',
  includeRequestBody: process.env.NODE_ENV !== 'production',
  includeResponseBody: false,
  includeHeaders: process.env.NODE_ENV !== 'production',
  excludePaths: ['/health', '/api/health'],
  excludeHeaders: ['authorization', 'cookie']
});

// Create a structured logger middleware
export const createStructuredLogger = (config: Partial<LoggerConfig> = {}): MiddlewareHandler<{ Bindings: Env }> => {
  const finalConfig = { ...getDefaultConfig(), ...config };
  
  return async (c, next) => {
    const { req } = c;
    const method = req.method;
    const url = req.url;
    const path = new URL(url).pathname;
    
    // Skip logging for excluded paths
    if (finalConfig.excludePaths?.includes(path)) {
      await next();
      return;
    }
    
    const startTime = Date.now();
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId); // Store for other middleware/handlers
    
    // Log request
    if (finalConfig.level <= LogLevel.INFO) {
      const logData: Record<string, any> = {
        type: 'request',
        requestId,
        method,
        path,
        timestamp: new Date().toISOString()
      };
      
      if (finalConfig.includeHeaders) {
        const headers = Object.fromEntries(
          Array.from(req.raw.headers.entries())
            .filter(([key]) => !finalConfig.excludeHeaders?.includes(key.toLowerCase()))
        );
        logData.headers = headers;
      }
      
      if (finalConfig.includeRequestBody && method !== 'GET' && method !== 'HEAD') {
        try {
          const contentType = req.header('content-type');
          if (contentType?.includes('application/json')) {
            const clonedReq = req.raw.clone();
            const body = await clonedReq.json().catch(() => null);
            logData.body = body;
          }
        } catch (error) {
          // Ignore body parsing errors
        }
      }
      
      if (finalConfig.prettyPrint) {
        console.log(`[${logData.timestamp}] 📥 ${method} ${path} (${requestId})`);
        if (logData.body) console.log('Request Body:', logData.body);
      } else {
        console.log(JSON.stringify(logData));
      }
    }
    
    // Execute the request handler
    try {
      await next();
    } catch (error) {
      // Log error
      if (finalConfig.level <= LogLevel.ERROR) {
        const logData = {
          type: 'error',
          requestId,
          method,
          path,
          error: error instanceof Error ? {
            name: error.name,
            message: error.message,
            stack: error.stack
          } : String(error),
          timestamp: new Date().toISOString()
        };
        
        if (finalConfig.prettyPrint) {
          console.error(`[${logData.timestamp}] ❌ ${method} ${path} (${requestId}) - ${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof Error && error.stack) console.error(error.stack);
        } else {
          console.error(JSON.stringify(logData));
        }
      }
      
      throw error;
    }
    
    // Log response
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    if (finalConfig.level <= LogLevel.INFO) {
      const status = c.res?.status || 200;
      const logData: Record<string, any> = {
        type: 'response',
        requestId,
        method,
        path,
        status,
        responseTime,
        timestamp: new Date().toISOString()
      };
      
      if (finalConfig.prettyPrint) {
        const statusEmoji = status < 400 ? '✅' : status < 500 ? '⚠️' : '❌';
        console.log(`[${logData.timestamp}] ${statusEmoji} ${method} ${path} ${status} (${responseTime}ms) (${requestId})`);
      } else {
        console.log(JSON.stringify(logData));
      }
    }
  };
};
```

### Phase 2: Create Utility Logger for Non-Request Contexts

1. Create a utility logger for non-request contexts:

```typescript
// Utility logger for non-request contexts
export const serverLogger = {
  debug(message: string, data?: any, context?: string): void {
    if (getDefaultConfig().level <= LogLevel.DEBUG) {
      const timestamp = new Date().toISOString();
      const contextStr = context ? `[${context}]` : '';
      const logData = {
        level: 'debug',
        message,
        context,
        data,
        timestamp
      };
      
      if (getDefaultConfig().prettyPrint) {
        console.debug(`[${timestamp}] 🔍 ${contextStr} ${message}`, data || '');
      } else {
        console.debug(JSON.stringify(logData));
      }
    }
  },
  
  info(message: string, data?: any, context?: string): void {
    if (getDefaultConfig().level <= LogLevel.INFO) {
      const timestamp = new Date().toISOString();
      const contextStr = context ? `[${context}]` : '';
      const logData = {
        level: 'info',
        message,
        context,
        data,
        timestamp
      };
      
      if (getDefaultConfig().prettyPrint) {
        console.log(`[${timestamp}] ℹ️ ${contextStr} ${message}`, data || '');
      } else {
        console.log(JSON.stringify(logData));
      }
    }
  },
  
  warn(message: string, data?: any, context?: string): void {
    if (getDefaultConfig().level <= LogLevel.WARN) {
      const timestamp = new Date().toISOString();
      const contextStr = context ? `[${context}]` : '';
      const logData = {
        level: 'warn',
        message,
        context,
        data,
        timestamp
      };
      
      if (getDefaultConfig().prettyPrint) {
        console.warn(`[${timestamp}] ⚠️ ${contextStr} ${message}`, data || '');
      } else {
        console.warn(JSON.stringify(logData));
      }
    }
  },
  
  error(message: string, error?: any, data?: any, context?: string): void {
    if (getDefaultConfig().level <= LogLevel.ERROR) {
      const timestamp = new Date().toISOString();
      const contextStr = context ? `[${context}]` : '';
      const logData = {
        level: 'error',
        message,
        context,
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack
        } : error,
        data,
        timestamp
      };
      
      if (getDefaultConfig().prettyPrint) {
        console.error(`[${timestamp}] ❌ ${contextStr} ${message}`, error || '', data || '');
        if (error instanceof Error && error.stack) console.error(error.stack);
      } else {
        console.error(JSON.stringify(logData));
      }
    }
  },
  
  // Create a context-specific logger
  withContext(context: string) {
    return {
      debug: (message: string, data?: any) => this.debug(message, data, context),
      info: (message: string, data?: any) => this.info(message, data, context),
      warn: (message: string, data?: any) => this.warn(message, data, context),
      error: (message: string, error?: any, data?: any) => this.error(message, error, data, context)
    };
  }
};

// Specialized loggers for different modules
export const syncLogger = serverLogger.withContext('sync');
export const replicationLogger = serverLogger.withContext('replication');
export const apiLogger = serverLogger.withContext('api');
export const dbLogger = serverLogger.withContext('db');
```

### Phase 3: Update Main Application to Use the New Logger

1. Update `apps/server/src/index.ts` to use the new logger:

```typescript
import { Hono } from 'hono';
import type { Env } from '@repo/shared-types';
import { cors } from 'hono/cors';
import api from './api';
import { sql } from './lib/db';
import type { Context } from 'hono';
import { SyncDO } from './sync/SyncDO';
import { ReplicationDO } from './replication';
import { createStructuredLogger, serverLogger } from './middleware/logger';

// Create the main API router
const app = new Hono<{
  Bindings: Env;
}>().basePath('/api');

// Use our structured logger middleware
app.use('*', createStructuredLogger());

// Global middleware
app.use('*', cors());

// Mount API routes
app.route('/', api);

// Health check endpoint
app.get('/health', async (c: Context<{ Bindings: Env }>) => {
  try {
    await sql(c.env.DATABASE_URL, 'SELECT 1');
    return c.json({ status: 'healthy', database: 'connected' });
  } catch (error) {
    serverLogger.error('Health check failed', error);
    return c.json({ status: 'unhealthy', database: 'disconnected', error: String(error) }, 503);
  }
});

// Export the worker and Durable Objects
const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    serverLogger.debug('Incoming request', {
      method: request.method,
      url: url.toString(),
      pathname: url.pathname,
      search: url.search
    });

    // Handle API routes
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
      try {
        return await app.fetch(request, env, ctx);
      } catch (error) {
        serverLogger.error('Error handling request', error);
        return new Response(JSON.stringify({
          ok: false,
          error: {
            type: 'InternalServerError',
            message: 'An unexpected error occurred'
          }
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
    }

    serverLogger.debug('No route matched, returning 404');
    return new Response('Not Found', { status: 404 });
  }
};

export { SyncDO, ReplicationDO };
export default worker;
```

### Phase 4: Replace Direct Console Calls in Key Modules

1. Update `apps/server/src/sync/SyncDO.ts` to use the new logger
2. Update `apps/server/src/replication/ReplicationDO.ts` to use the new logger
3. Update `apps/server/src/api/index.ts` to use the new logger

Example for SyncDO.ts:

```typescript
import { syncLogger } from '../middleware/logger';

// Replace:
console.log('🏗️ SyncDO: Initializing instance', { syncId: this.syncId });

// With:
syncLogger.info('Initializing instance', { syncId: this.syncId });
```

### Phase 5: Create a Migration Guide

Create a guide for developers to follow when updating existing code:

```markdown
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
import { syncLogger, replicationLogger, apiLogger, dbLogger } from '../middleware/logger';
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
```

## Timeline and Priorities

### Week 1: Foundation
- Create the structured logger middleware
- Update the main application to use the new logger
- Create the migration guide

### Week 2: Core Modules
- Update SyncDO.ts
- Update ReplicationDO.ts
- Update key API handlers

### Week 3: Remaining Modules
- Update remaining modules
- Add tests for the logger
- Review and refine

## Success Criteria

The refactor will be considered successful when:

1. All direct console calls are replaced with structured logger calls
2. Logs have consistent format and include appropriate context
3. Duplicate logging is eliminated
4. Sensitive information is properly excluded from logs
5. Log levels are appropriate for different environments
6. Logs are more useful for debugging and monitoring

## Future Enhancements

After the initial refactor, we can consider:

1. Integration with external logging services (e.g., Sentry, Datadog)
2. Adding log rotation for development environments
3. Implementing log sampling for high-volume endpoints
4. Creating a log viewer UI for development 