# Database Layer Refactoring Plan

## Overview

This document outlines a comprehensive plan to refactor the database layer of VibeStack to implement a consistent TypeORM-based entity management system. The goal is to unify both UI-initiated and sync-received database operations through a single, consistent API while maintaining a clear separation between these two change pathways.

## Current Architecture Issues

1. **Inconsistent Data Access**: UI changes use direct PGlite calls while sync changes use TypeORM
2. **Duplicate Logic**: Entity operations defined in both services and DBChangeProcessor
3. **Unclear Boundaries**: No clean separation between UI and sync change pathways
4. **Maintenance Challenges**: Changes to entity structure require updates in multiple places
5. **No Single Source of Truth**: Business logic spread across different components
6. **Multiple Providers**: Both `pglite-provider.tsx` and empty `DBProvider.tsx` files exist, but need consolidation
7. **Legacy Code**: Services still use direct `db.X` calls to entities rather than TypeORM repositories

## Target Architecture

### Simplified Directory Structure

```
apps/web/src/db/
├── repositories.ts     # All TypeORM repositories in one file
├── services.ts         # All entity services with UI & sync methods
├── sync-adapters.ts    # Sync adapters for all entities
├── db-provider.tsx     # Enhanced provider that extends existing PGlite provider
├── hooks.ts            # React hooks for data access
└── change-processor.ts # Renamed from DBChangeProcessor
```

### Three-Layer Architecture (Simplified)

All entities share the same pattern with a clear separation between:

1. **Repository Layer** (in `repositories.ts`):
   - Pure TypeORM data access
   - One repository class per entity, all in one file
   - Uses existing newtypeorm DataSource

2. **Service Layer** (in `services.ts`):
   - Business logic with UI and sync methods
   - Clear distinction between tracked (UI) and untracked (sync) operations

3. **Sync Adapter Layer** (in `sync-adapters.ts`):
   - Translates sync changes to service calls
   - All adapters in one file for simplicity

## Implementation Plan

### Phase 1: Foundation

1. **Use Existing TypeORM Setup**
   - Leverage the existing `getNewPGliteDataSource()` from `newtypeorm/NewDataSource.ts`

2. **Repository Implementation**
   - Create repositories.ts with TypeORM repositories for all entities
   - Implement basic CRUD operations using the existing DataSource

3. **Provider Consolidation**
   - Enhance the existing `pglite-provider.tsx` to expose TypeORM DataSource
   - Remove the empty `DBProvider.tsx` file

### Phase 2: Service Layer

1. **Service Implementation**
   - Create services.ts with all entity services
   - Each service should have both UI and sync methods
   - UI methods track changes, sync methods don't
   - Replace direct db.X calls with TypeORM repository calls

2. **Sync Adapter Implementation**
   - Create sync-adapters.ts with adapters for all entities
   - Connect to change processor

### Phase 3: Integration

1. **Change Processor Refactor**
   - Update to delegate to sync adapters
   - Remove direct entity manipulation
   - Use existing NewPGliteQueryRunner from newtypeorm

2. **React Integration**
   - Update existing provider to expose services
   - Update hooks.ts to use new services

### Phase 4: Clean-up and Testing

1. **Remove Legacy Code**
   - Remove direct db.X references in services
   - Remove any other Dexie-specific code
   - Handle IndexedDB migrations if needed

2. **Testing**
   - Test each layer
   - Test end-to-end workflows

## Detailed Implementation Approach

### Legacy Code Identification

Current identified legacy code includes:

1. Direct db.X entity access in `services.ts` (35+ instances)
2. References to Dexie transactions
3. Empty `DBProvider.tsx` file
4. Potentially unnecessary `MinimalPGliteProvider` in `pglite-provider.tsx`

### Provider Enhancement

Instead of creating a new provider, enhance the existing `pglite-provider.tsx`:

```typescript
import React, { createContext, useContext, useEffect, useState } from 'react';
import { initializeDatabase, getDatabase, dbMessageBus } from './db.ts';
import { getNewPGliteDataSource } from './newtypeorm/NewDataSource';
import { createRepositories } from './repositories';
import { createServices } from './services';
import { SyncChangeManager } from '../sync/SyncChangeManager.typeorm';

// Extend existing context with repositories and services
interface PGliteContextValue {
  isLoading: boolean;
  isReady: boolean;
  error: Error | null;
  repositories?: Awaited<ReturnType<typeof createRepositories>> | null;
  services?: ReturnType<typeof createServices> | null;
}

const PGliteContext = createContext<PGliteContextValue>({
  isLoading: true,
  isReady: false,
  error: null,
  repositories: null,
  services: null
});

// Keep existing hook
export function usePGliteContext() {
  return useContext(PGliteContext);
}

interface PGliteProviderProps {
  children: React.ReactNode;
}

/**
 * Vibestack PGlite Provider Component
 * 
 * This provider initializes both legacy PGlite and TypeORM and provides context
 * about its status to the application.
 */
export function VibestackPGliteProvider({ children }: PGliteProviderProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [repositories, setRepositories] = useState<Awaited<ReturnType<typeof createRepositories>> | null>(null);
  const [services, setServices] = useState<ReturnType<typeof createServices> | null>(null);

  useEffect(() => {
    let isMounted = true;
    
    // Set up event listeners (keep existing)
    const unsubInitialized = dbMessageBus.subscribe('initialized', () => {
      if (isMounted) {
        setIsReady(true);
        setIsLoading(false);
      }
    });
    
    const unsubError = dbMessageBus.subscribe('error', (data) => {
      if (isMounted) {
        setError(data.error || new Error('Unknown database error'));
        setIsLoading(false);
      }
    });
    
    // Initialize the database AND TypeORM
    async function init() {
      try {
        console.log('PGlite Provider initializing...');
        
        // Initialize legacy PGlite first
        await initializeDatabase();
        
        // Then initialize TypeORM
        const dataSource = await getNewPGliteDataSource();
        const repos = await createRepositories();
        const syncChangeManager = SyncChangeManager.getInstance();
        const svcs = createServices(repos, syncChangeManager);
        
        if (isMounted) {
          setRepositories(repos);
          setServices(svcs);
          setIsReady(true);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Error initializing database in provider:', err);
        
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      }
    }
    
    // Start initialization (keep existing logic)
    getDatabase()
      .then(() => {
        if (isMounted) {
          init(); // Call init here to set up TypeORM after legacy is ready
        }
      })
      .catch(() => {
        // If not already initialized, start initialization
        init();
      });
    
    return () => {
      isMounted = false;
      unsubInitialized();
      unsubError();
    };
  }, []);

  // Provide context to children with additional repositories and services
  return (
    <PGliteContext.Provider value={{ 
      isLoading, 
      isReady, 
      error,
      repositories,
      services 
    }}>
      {children}
    </PGliteContext.Provider>
  );
}
```

### Migrating from Legacy to TypeORM

To support a gradual migration, services should initially support both access patterns:

```typescript
// Example user service with migration support
export class UserService extends BaseService<User> {
  constructor(
    protected userRepository: UserRepository,
    protected syncChangeManager: SyncChangeManager,
    private legacyDb?: any // Optional legacy db for migration period
  ) {
    super(userRepository, 'users', syncChangeManager);
  }

  // Legacy method for backward compatibility during migration
  async getById(id: string): Promise<User | null> {
    // Prefer TypeORM implementation
    return this.get(id);
  }

  // New TypeORM implementation
  async get(id: string): Promise<User | null> {
    try {
      // Try TypeORM first
      return await this.repository.findById(id);
    } catch (error) {
      // Fall back to legacy during migration if available
      if (this.legacyDb?.users) {
        console.warn('Falling back to legacy DB implementation for get user');
        return await this.legacyDb.users.get(id);
      }
      throw error;
    }
  }

  // Same pattern for other methods...
}
```

### repositories.ts

```typescript
import { Repository } from 'typeorm';
import { User, Project, Task, Comment } from '@repo/dataforge/client-entities';
import { getNewPGliteDataSource } from './newtypeorm/NewDataSource';

// Base repository with common CRUD operations
class BaseRepository<T> {
  constructor(
    protected repository: Repository<T>,
    protected entityName: string
  ) {}

  async findById(id: string): Promise<T | null> {
    return this.repository.findOne({ where: { id } as any });
  }

  async findAll(): Promise<T[]> {
    return this.repository.find();
  }

  async create(data: Partial<T>): Promise<T> {
    const entity = this.repository.create(data);
    return this.repository.save(entity);
  }

  async update(id: string, data: Partial<T>): Promise<T> {
    await this.repository.update(id, data);
    return this.findById(id) as Promise<T>;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.repository.delete(id);
    return result.affected !== 0;
  }
}

// User repository
export class UserRepository extends BaseRepository<User> {
  constructor(dataSource: Awaited<ReturnType<typeof getNewPGliteDataSource>>) {
    super(dataSource.getRepository(User), 'user');
  }

  // User-specific methods here
}

// Project repository
export class ProjectRepository extends BaseRepository<Project> {
  constructor(dataSource: Awaited<ReturnType<typeof getNewPGliteDataSource>>) {
    super(dataSource.getRepository(Project), 'project');
  }

  // Project-specific methods here
}

// Task repository
export class TaskRepository extends BaseRepository<Task> {
  constructor(dataSource: Awaited<ReturnType<typeof getNewPGliteDataSource>>) {
    super(dataSource.getRepository(Task), 'task');
  }

  async findByProject(projectId: string): Promise<Task[]> {
    return this.repository.find({ where: { projectId } as any });
  }

  // Task-specific methods here
}

// Comment repository
export class CommentRepository extends BaseRepository<Comment> {
  constructor(dataSource: Awaited<ReturnType<typeof getNewPGliteDataSource>>) {
    super(dataSource.getRepository(Comment), 'comment');
  }

  async findByTask(taskId: string): Promise<Comment[]> {
    return this.repository.find({ where: { taskId } as any });
  }

  // Comment-specific methods here
}

// Factory function to create all repositories
export async function createRepositories() {
  const dataSource = await getNewPGliteDataSource();
  
  return {
    users: new UserRepository(dataSource),
    projects: new ProjectRepository(dataSource),
    tasks: new TaskRepository(dataSource),
    comments: new CommentRepository(dataSource)
  };
}
```

## Risk Mitigation

1. **Data Integrity**: Ensure proper transactions for complex operations
2. **Testing**: Create unit tests for each repository and service
3. **Gradual Migration**: Support both access patterns initially for safety
4. **Validation**: Add entity validation in services
5. **Logging**: Implement consistent error logging

## Success Criteria

1. All database operations go through TypeORM repositories
2. Clear separation between UI and sync operations in service methods
3. Comprehensive test coverage
4. All UI components use the enhanced provider
5. No more direct db.X references

## Timeline Estimate

- **Phase 1**: 1-2 days
- **Phase 2**: 3-4 days (more time for careful migration from legacy)
- **Phase 3**: 2-3 days
- **Phase 4**: 2-3 days

Total estimated time: 8-12 days 