# Phase 1: Signal Foundation Implementation

## Overview

Phase 1 focuses on establishing the signal foundation with persistent caching for immediate rendering. This phase transitions from blocking database-dependent initialization to a cache-first architecture using Preact Signals and IndexedDB.

## Architecture

### Signal Layer
```
App State
├─> Core Signals (dbReady, initState, etc.)
├─> Query Signals (projects, tasks, etc.)
└─> Computed Signals (derived states)
```

### Cache Layer
```
IndexedDB
├─> Signal Cache
│   ├─> Last Known Values
│   └─> Metadata (version, timestamp)
└─> Query Cache
    ├─> Results by Query
    └─> Invalidation Rules
```

## Implementation Steps

### 1. Core Signal Setup

**Technical Details**:
- Use `@preact/signals-core` for module-level signals
- Use `@preact/signals` for component integration
- Implement signal versioning for cache compatibility

**Implementation**:
```typescript
// Core initialization signals
const dbReady = signal(false);
const initState = signal<InitState>('loading');
const cacheState = signal<CacheState>('checking');

// Query result signals with versioning
interface CachedSignal<T> {
  version: number;
  timestamp: number;
  value: T;
}
```

### 2. Cache Implementation

**Technical Details**:
- Use IndexedDB for signal persistence
- Implement versioning and timestamps
- Add type-safe serialization
- Handle cache invalidation

**Signal Persistence Strategy**:

1. **Cache Structure**:
   ```typescript
   interface SignalCache<T> {
     key: string;              // Unique identifier for the signal
     value: T;                 // The actual signal value
     version: number;          // Cache version for invalidation
     timestamp: number;        // Last update timestamp
     metadata: {              // Additional metadata
       type: 'query' | 'state' | 'computed';
       dependencies?: string[]; // For computed signals
       ttl?: number;           // Time-to-live in milliseconds
     }
   }
   ```

2. **Persistence Layer**:
   ```typescript
   class SignalPersistence {
     // Store signal value with metadata
     async persist(key: string, signal: Signal<unknown>): Promise<void> {
       const cache: SignalCache<unknown> = {
         key,
         value: signal.value,
         version: CACHE_VERSION,
         timestamp: Date.now(),
         metadata: this.getSignalMetadata(signal)
       };
       await this.store.set(key, cache);
     }

     // Hydrate signal from cache
     async hydrate(key: string): Promise<unknown> {
       const cache = await this.store.get(key);
       if (this.isValid(cache)) {
         return cache.value;
       }
       return null;
     }
   }
   ```

3. **Effect Management**:
   ```typescript
   // Automatic persistence using effects
   function persistSignal<T>(signal: Signal<T>, key: string) {
     return effect(() => {
       signalPersistence.persist(key, signal);
     });
   }
   ```

4. **Cache Invalidation Rules**:
   ```typescript
   interface InvalidationRule {
     condition: (cache: SignalCache<unknown>) => boolean;
     action: 'delete' | 'refresh';
   }

   const defaultRules: InvalidationRule[] = [
     {
       // Version mismatch
       condition: (cache) => cache.version !== CACHE_VERSION,
       action: 'delete'
     },
     {
       // TTL expired
       condition: (cache) => cache.metadata.ttl && 
         Date.now() - cache.timestamp > cache.metadata.ttl,
       action: 'refresh'
     }
   ];
   ```

5. **Batch Operations**:
   ```typescript
   class SignalBatchManager {
     // Batch multiple signal updates
     async batchUpdate(updates: Map<string, unknown>) {
       return batch(() => {
         updates.forEach((value, key) => {
           const signal = this.signals.get(key);
           if (signal) signal.value = value;
         });
       });
     }
   }
   ```

**Implementation Flow**:

1. **Initialization**:
   ```typescript
   // Initialize persistence system
   const persistence = new SignalPersistence({
     storeName: 'signal-cache',
     version: 1,
     invalidationRules: defaultRules
   });

   // Setup automatic persistence for core signals
   effect(() => {
     persistence.persist('dbState', dbReady);
     persistence.persist('initState', initState);
   });
   ```

2. **Query Signal Integration**:
   ```typescript
   function createQuerySignal<T>(query: string, options: QueryOptions) {
     const signal = new Signal<T>(null);
     const key = `query:${query}`;

     // Hydrate from cache first
     persistence.hydrate(key).then(cached => {
       if (cached) signal.value = cached;
     });

     // Setup persistence
     persistSignal(signal, key);

     return signal;
   }
   ```

3. **Computed Signal Handling**:
   ```typescript
   function persistComputedSignal<T>(
     computed: Computed<T>,
     key: string,
     dependencies: Signal[]
   ) {
     // Track dependencies for cache invalidation
     const deps = dependencies.map(dep => 
       dep instanceof Signal ? dep.key : null
     ).filter(Boolean);

     return effect(() => {
       persistence.persist(key, {
         value: computed.value,
         dependencies: deps
       });
     });
   }
   ```

**Key Functions**:
- Cache Reading: Load and validate cached signals
- Cache Writing: Persist signal updates
- Cache Invalidation: Version and timestamp checks
- Cache Cleanup: Remove stale/invalid cache entries

**Error Handling**:
```typescript
class CacheError extends Error {
  constructor(
    message: string,
    public readonly key: string,
    public readonly type: 'validation' | 'persistence' | 'hydration'
  ) {
    super(message);
  }
}

// Error recovery strategy
async function recoverFromCacheError(error: CacheError) {
  if (error.type === 'validation') {
    await persistence.invalidate(error.key);
    return persistence.refresh(error.key);
  }
  // ... other recovery strategies
}
```

### 3. Query Signal System

**Technical Details**:
- Implement cache-first query signals
- Use PGlite live queries for updates
- Add stale-while-revalidate pattern
- Handle cache invalidation

**Pattern**:
1. Load from cache immediately
2. Start database query in background
3. Update signal with fresh data
4. Cache new results

### 4. Initialization Flow

**Technical Details**:
- Non-blocking initialization sequence
- Background database setup
- Parallel system initialization
- Cache-aware loading states

**Sequence**:
1. Load cached signals
2. Render initial UI
3. Initialize database
4. Start sync system
5. Update signals

### 5. Error Handling

**Technical Details**:
- Type-safe error states
- Cache fallback mechanism
- Retry strategies
- Error boundaries

**Key Patterns**:
- Cache validation errors
- Database connection errors
- Sync system errors
- Cache inconsistency handling

### 6. Entity Cache Integration

**Technical Details**:
- Automatic cache generation for TypeORM entities
- Type-safe query results
- Entity-specific invalidation rules
- Relationship handling

1. **Entity Cache Types**:
   ```typescript
   // cache/entity-types.ts
   import { BaseEntity } from '@repo/db';
   
   type EntityName = 'user' | 'project' | 'task';
   
   interface EntityCache<T extends BaseEntity> {
     type: EntityName;
     query: string;
     result: T[];
     relationships: {
       [K in keyof T]?: EntityName;
     };
   }
   
   interface EntityCacheConfig<T extends BaseEntity> {
     type: EntityName;
     ttl?: number;
     relationships?: Array<keyof T>;
     invalidationTriggers?: Array<EntityName>;
   }
   ```

2. **Automatic Query Signal Generation**:
   ```typescript
   // cache/entity-signals.ts
   import { Entity } from 'typeorm';
   import { signal, computed } from '@preact/signals-core';
   
   function createEntitySignal<T extends BaseEntity>(
     config: EntityCacheConfig<T>
   ) {
     // Create base query signal
     const querySignal = signal<T[]>([]);
     
     // Create loading and error states
     const loadingSignal = signal(true);
     const errorSignal = signal<Error | null>(null);
     
     // Create computed view state
     const viewSignal = computed(() => ({
       loading: loadingSignal.value,
       error: errorSignal.value,
       data: querySignal.value
     }));
     
     // Setup cache persistence
     const cacheKey = `entity:${config.type}`;
     persistSignal(querySignal, cacheKey, {
       type: 'entity',
       entityType: config.type,
       ttl: config.ttl
     });
     
     return {
       query: querySignal,
       loading: loadingSignal,
       error: errorSignal,
       view: viewSignal
     };
   }
   ```

3. **Entity Cache Manager**:
   ```typescript
   // cache/entity-manager.ts
   class EntityCacheManager {
     private entitySignals = new Map<EntityName, ReturnType<typeof createEntitySignal>>();
     
     registerEntity<T extends BaseEntity>(
       config: EntityCacheConfig<T>
     ) {
       const signals = createEntitySignal(config);
       this.entitySignals.set(config.type, signals);
       
       // Setup relationship invalidation
       if (config.relationships) {
         this.setupRelationshipInvalidation(config);
       }
       
       return signals;
     }
     
     private setupRelationshipInvalidation(
       config: EntityCacheConfig<any>
     ) {
       config.invalidationTriggers?.forEach(triggerEntity => {
         effect(() => {
           // When related entity updates, invalidate this cache
           const trigger = this.entitySignals.get(triggerEntity);
           if (trigger?.query.value) {
             this.invalidateEntity(config.type);
           }
         });
       });
     }
   }
   ```

4. **Usage Example**:
   ```typescript
   // signals/entities.ts
   const entityCache = new EntityCacheManager();
   
   // Register entities with their relationships
   export const userSignals = entityCache.registerEntity({
     type: 'user',
     ttl: 5 * 60 * 1000, // 5 minutes
   });
   
   export const projectSignals = entityCache.registerEntity({
     type: 'project',
     relationships: ['owner'],
     invalidationTriggers: ['user']
   });
   
   export const taskSignals = entityCache.registerEntity({
     type: 'task',
     relationships: ['assignee', 'project'],
     invalidationTriggers: ['user', 'project']
   });
   ```

5. **Component Integration**:
   ```typescript
   // components/TaskList.tsx
   function TaskList() {
     const { view } = taskSignals;
     
     if (view.value.loading) {
       return <LoadingState />;
     }
     
     if (view.value.error) {
       return <ErrorState error={view.value.error} />;
     }
     
     return (
       <DataTable
         data={view.value.data}
         columns={taskColumns}
       />
     );
   }
   ```

**Key Features**:

1. **Automatic Type Safety**:
   - Leverages TypeORM entity types
   - Type-safe query results
   - Relationship type checking

2. **Smart Cache Invalidation**:
   - Entity relationship-based invalidation
   - TTL support per entity type
   - Cascading updates

3. **Performance Optimizations**:
   - Shared cache for related queries
   - Batch updates for relationships
   - Minimal re-renders

4. **Developer Experience**:
   - Automatic signal generation
   - Type inference
   - Consistent API

This integration provides:
- Automatic caching for all entities
- Type-safe query results
- Smart cache invalidation based on relationships
- Minimal boilerplate for new entities
- Consistent component integration

### 7. Display Component Integration

**Technical Details**:
- Mapping entity signals to display components
- Type-safe column definitions
- Automatic refresh handling
- Sort/filter integration

1. **Grid Column Generation**:
   ```typescript
   // components/grid/columns.ts
   import { ColumnDef } from '@tanstack/react-table';
   import { BaseEntity } from '@repo/db';
   
   type ColumnConfig<T extends BaseEntity> = {
     field: keyof T;
     header?: string;
     width?: number;
     formatter?: (value: any) => string | JSX.Element;
     sortable?: boolean;
     filterable?: boolean;
   };

   function createEntityColumns<T extends BaseEntity>(
     configs: ColumnConfig<T>[]
   ): ColumnDef<T>[] {
     return configs.map(config => ({
       accessorKey: config.field as string,
       header: config.header ?? String(config.field),
       cell: config.formatter 
         ? ({ row }) => config.formatter!(row.original[config.field])
         : undefined,
       enableSorting: config.sortable ?? true,
       enableFiltering: config.filterable ?? true,
     }));
   }
   ```

2. **Entity Grid Component**:
   ```typescript
   // components/grid/EntityGrid.tsx
   interface EntityGridProps<T extends BaseEntity> {
     entitySignal: ReturnType<typeof createEntitySignal<T>>;
     columns: ColumnConfig<T>[];
     title?: string;
     toolbar?: ReactNode;
     onRowClick?: (row: T) => void;
   }

   function EntityGrid<T extends BaseEntity>({
     entitySignal,
     columns,
     title,
     toolbar,
     onRowClick
   }: EntityGridProps<T>) {
     const { view } = entitySignal;
     const tableColumns = useMemo(
       () => createEntityColumns(columns),
       [columns]
     );

     if (view.value.loading) {
       return <GridLoadingState />;
     }

     if (view.value.error) {
       return <GridErrorState error={view.value.error} />;
     }

     return (
       <div className="rounded-lg border border-gray-700">
         {title && (
           <div className="px-4 py-3 border-b border-gray-700">
             <h2 className="text-lg font-semibold">{title}</h2>
           </div>
         )}
         {toolbar && (
           <div className="px-4 py-2 border-b border-gray-700">
             {toolbar}
           </div>
         )}
         <DataTable
           data={view.value.data}
           columns={tableColumns}
           onRowClick={onRowClick}
         />
       </div>
     );
   }
   ```

3. **Entity-Specific Grids**:
   ```typescript
   // components/grids/TaskGrid.tsx
   const taskColumns: ColumnConfig<Task>[] = [
     { 
       field: 'title',
       header: 'Task',
       formatter: (value) => (
         <div className="flex items-center gap-2">
           <StatusIcon status={value.status} />
           <span>{value.title}</span>
         </div>
       )
     },
     { 
       field: 'status',
       formatter: (value) => (
         <StatusBadge status={value} />
       )
     },
     {
       field: 'assignee',
       formatter: (user) => user && (
         <UserAvatar user={user} />
       )
     },
     {
       field: 'dueDate',
       formatter: (date) => date && (
         <DateDisplay date={date} />
       )
     }
   ];

   export function TaskGrid() {
     return (
       <EntityGrid
         entitySignal={taskSignals}
         columns={taskColumns}
         title="Tasks"
         toolbar={<TaskToolbar />}
         onRowClick={(task) => openTaskDetails(task)}
       />
     );
   }
   ```

4. **Custom Display Components**:
   ```typescript
   // components/displays/EntityCard.tsx
   interface EntityCardProps<T extends BaseEntity> {
     entitySignal: ReturnType<typeof createEntitySignal<T>>;
     renderItem: (item: T) => ReactNode;
     layout?: 'grid' | 'list';
   }

   function EntityCard<T extends BaseEntity>({
     entitySignal,
     renderItem,
     layout = 'grid'
   }: EntityCardProps<T>) {
     const { view } = entitySignal;

     if (view.value.loading) {
       return <CardLoadingState />;
     }

     return (
       <div className={`grid ${
         layout === 'grid' ? 'grid-cols-3' : 'grid-cols-1'
       } gap-4`}>
         {view.value.data.map(item => (
           <div key={item.id} className="p-4 border border-gray-700 rounded">
             {renderItem(item)}
           </div>
         ))}
       </div>
     );
   }
   ```

5. **Integration Examples**:
   ```typescript
   // pages/Projects.tsx
   export function Projects() {
     // Grid view
     return (
       <ProjectGrid
         toolbar={
           <div className="flex justify-between">
             <SearchInput />
             <NewProjectButton />
           </div>
         }
       />
     );

     // Or card view
     return (
       <EntityCard
         entitySignal={projectSignals}
         renderItem={(project) => (
           <ProjectCard project={project} />
         )}
       />
     );
   }
   ```

**Key Features**:

1. **Type Safety**:
   - Automatic column type inference
   - Type-safe formatters
   - Relationship type checking

2. **Performance**:
   - Memoized column definitions
   - Efficient updates via signals
   - Minimal re-renders

3. **Flexibility**:
   - Multiple display modes
   - Custom formatters
   - Toolbar integration
   - Event handling

4. **UX Enhancements**:
   - Loading states
   - Error handling
   - Empty states
   - Sort/filter capabilities

This integration provides:
- Consistent grid/display patterns
- Type-safe column definitions
- Automatic signal integration
- Rich formatting options
- Flexible layout options

## Implementation Guide

### Step 1: Signal Foundation

1. **Setup Core Signals**:
   ```typescript
   // signals/core.ts
   import { signal, computed } from '@preact/signals-core';
   
   export const dbReady = signal(false);
   export const initState = signal<InitState>('loading');
   export const cacheState = signal<CacheState>('checking');
   
   export const isReady = computed(() => {
     return dbReady.value && initState.value === 'ready';
   });
   ```

2. **Add Cache Layer**:
   ```typescript
   // cache/store.ts
   interface CacheStore {
     version: number;
     signals: Map<string, CachedSignal<unknown>>;
     queries: Map<string, QueryCache>;
   }
   ```

3. **Create Signal Manager**:
   ```typescript
   // signals/manager.ts
   class SignalManager {
     async hydrate(): Promise<void>;
     async persist(): Promise<void>;
     invalidateCache(): void;
   }
   ```

### Step 2: Query Implementation

1. **Create Query Signal Factory**:
   ```typescript
   // signals/query.ts
   function createQuerySignal<T>(query: string, options: QueryOptions) {
     // Implementation details...
   }
   ```

2. **Add Cache-First Loading**:
   ```typescript
   // Cache hit -> render
   // Cache miss -> loading state -> query -> render
   ```

3. **Setup Live Updates**:
   ```typescript
   // Connect to PGlite live queries
   // Update signals and cache
   ```

### Step 3: Component Integration

1. **Create Provider Components**:
   ```typescript
   // components/StateProvider.tsx
   // components/DatabaseProvider.tsx
   ```

2. **Add Error Boundaries**:
   ```typescript
   // components/ErrorBoundary.tsx
   ```

3. **Create Loading States**:
   ```typescript
   // components/LoadingState.tsx
   ```

## Testing Strategy

1. **Unit Tests**:
   - Signal behavior
   - Cache operations
   - Error handling

2. **Integration Tests**:
   - Cache hydration
   - Database initialization
   - Signal updates

3. **E2E Tests**:
   - Full initialization flow
   - Cache persistence
   - Error recovery

## Success Validation

1. **Performance**:
   - Initial render < 100ms
   - Cache hit rate > 90%
   - Update latency < 50ms

2. **Reliability**:
   - Cache consistency
   - Error recovery
   - State persistence

3. **User Experience**:
   - No empty states
   - Clear loading indicators
   - Smooth updates

## Next Steps

1. Implement core signal system
2. Add cache layer
3. Create query signal factory
4. Setup error handling
5. Add component integration
6. Deploy and validate 