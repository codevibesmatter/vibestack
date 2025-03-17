# PGlite Database Setup

This document outlines the PGlite database implementation in our application, including the architecture, configuration, and key components.

## Overview

Our application uses [PGlite](https://electric-sql.com/docs/api/pglite), a WebAssembly-based PostgreSQL implementation that runs entirely in the browser. This allows us to have a fully functional PostgreSQL database on the client side, enabling offline-first capabilities and improved performance.

## Architecture

The database implementation follows a modular architecture with clear separation of concerns:

```
apps/web/src/db/
├── core.ts         # Core database initialization and management
├── index.ts        # Public API exports
├── provider.tsx    # React context provider for database access
├── storage.ts      # Data operations and utilities
├── types.ts        # TypeScript type definitions
└── worker.ts       # Web Worker configuration for PGlite
```

### Key Components

1. **Database Core (`core.ts`)**: Handles database initialization, termination, and core operations.
2. **Database Provider (`provider.tsx`)**: React context provider that makes the database available throughout the application.
3. **Storage Utilities (`storage.ts`)**: Functions for data manipulation, clearing, and loading server data.
4. **Type Definitions (`types.ts`)**: TypeScript interfaces and type guards for database entities.
5. **Worker Configuration (`worker.ts`)**: Web Worker setup for running PGlite in a separate thread.

## Database Initialization

The database is initialized in a Web Worker to prevent blocking the main thread. The initialization process:

1. Creates a new Web Worker instance
2. Configures PGlite with the IndexedDB filesystem for persistence
3. Initializes extensions (uuid_ossp, live)
4. Sets up error handling and recovery mechanisms

```typescript
// From core.ts
export const initializeDatabase = async (forceReset: boolean = false): Promise<PGliteWorker> => {
  // ... initialization logic
  const worker = new Worker(
    new URL('./worker.ts', import.meta.url),
    { type: 'module' }
  );
  
  const newDb = new PGliteWorker(
    worker,
    {
      extensions: {
        live
      }
    }
  );
  
  await newDb.waitReady;
  // ... additional setup
  return newDb;
};
```

## Storage Configuration

We use IndexedDB as the storage backend for PGlite, which provides:

- Persistence across browser sessions
- Larger storage capacity compared to localStorage
- Structured storage for database files

```typescript
// From worker.ts
const config = {
  fs: new IdbFs(DB_NAME),
  extensions: { 
    uuid_ossp,
    live 
  },
  relaxedDurability: true,
  cacheSize: 5000
};
```

## Error Handling and Recovery

The implementation includes robust error handling and recovery mechanisms:

1. **Filesystem Error Detection**: Identifies common errors like `ErrnoError` and file handle limitations
2. **Automatic Recovery**: Attempts to clear storage and reinitialize when errors occur
3. **User-Friendly Feedback**: Provides clear error messages and recovery options in the UI

```typescript
// From provider.tsx
if (isFileSystemError && retryCount < 3) {
  setRetryCount(prev => prev + 1);
  setNeedsReset(true);
  
  setTimeout(() => {
    initDB(true);
  }, 1500);
} else {
  setError(err instanceof Error ? err : new Error('Failed to initialize database'));
  setIsInitializing(false);
}
```

## React Integration

The database is integrated with React through a context provider:

```typescript
// From provider.tsx
export function DatabaseProvider({ children }: ProviderProps) {
  // ... state and initialization logic
  
  return (
    <PGliteProvider db={db}>
      {children}
    </PGliteProvider>
  );
}
```

## Data Operations

Common data operations are implemented in the `storage.ts` file:

1. **Clearing Data**: `clearAllData()` truncates all tables while respecting foreign key constraints
2. **Resetting Database**: `resetDatabase()` reinitializes the database and clears all data
3. **Loading Server Data**: `loadServerData()` fetches data from the server API and populates the local database
4. **Database Statistics**: `getDatabaseStats()` provides information about tables and row counts

## Server Data Synchronization

The application supports loading data from the server:

```typescript
// From storage.ts
export const loadServerData = async (database?: PGlite | PGliteWorker): Promise<{ 
  success: boolean; 
  error?: string;
}> => {
  // Fetch data from server API
  const response = await fetch(`${config.apiUrl}/api/db/data`);
  // Process and insert data
  // ...
};
```

## Type Safety

The implementation uses TypeScript for type safety, with specialized types for PGlite instances:

```typescript
// From types.ts
export interface PGliteWithLive extends PGlite {
  live: LiveNamespace
}

export interface PGliteWorkerWithLive extends PGliteWorker {
  live: LiveNamespace
}

export type AnyPGliteWithLive = PGliteWithLive | PGliteWorkerWithLive;
```

## Admin Panel Integration

The Admin Panel component provides a UI for database management:

1. Viewing database schema
2. Managing migrations
3. Loading server data
4. Clearing all data
5. Viewing table statistics

## Best Practices

Our PGlite implementation follows these best practices:

1. **Web Worker Usage**: Running PGlite in a separate thread to prevent UI blocking
2. **Error Recovery**: Implementing automatic recovery mechanisms
3. **Transaction Safety**: Using transactions for data operations to ensure consistency
4. **Type Safety**: Leveraging TypeScript for type checking and developer experience
5. **Modular Architecture**: Separating concerns into focused modules

## Common Issues and Solutions

### File Handle Limitations

**Issue**: Browsers have limits on the number of open file handles, which can cause errors with PGlite.

**Solution**: We use IndexedDB filesystem instead of OPFS (Origin Private File System) to avoid hitting these limits.

### Database Initialization Failures

**Issue**: Database initialization can fail due to corrupted storage or resource limitations.

**Solution**: The implementation includes automatic retry with storage clearing when initialization fails.

### Transaction Management

**Issue**: Failed transactions can leave the database in an inconsistent state.

**Solution**: All data operations use proper transaction management with commit/rollback handling.

## Future Improvements

Potential improvements to the PGlite implementation:

1. **Offline Sync**: Implementing bidirectional synchronization for offline-first capabilities
2. **Performance Optimization**: Fine-tuning cache settings and query performance
3. **Migration Management**: Enhancing the migration system for smoother schema updates
4. **Storage Compression**: Implementing compression for reduced storage footprint
5. **Query Monitoring**: Adding tools for monitoring and optimizing query performance 