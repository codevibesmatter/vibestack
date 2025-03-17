# Signals Architecture

## Overview

Our state management architecture uses Preact Signals combined with IndexedDB caching to provide immediate rendering with background data synchronization. This document outlines the core concepts, implementation details, and best practices.

## Core Concepts

### 1. Cache-First Loading
```
User Request → Check Cache → Render Cached Data → Fetch Fresh Data → Update UI
```

The system prioritizes immediate rendering using cached data, then updates in the background when fresh data is available. This provides:
- Zero-delay initial renders
- No loading spinners
- Smooth transitions
- Offline capability

### 2. Signal Layer

```typescript
// Core database signals
export const dbInstance = signal<PGliteWithLive | null>(null)
export const dbError = signal<DatabaseError | null>(null)
export const dbReady = computed(() => dbInstance.value !== null && !dbError.value)

// Query signals with caching
interface QueryState<T> {
  data: T[]
  loading: boolean
  error: DatabaseError | null
  isStale: boolean
}

function createQuerySignal<T>(query: string, params: any[] = []): ReadonlySignal<QueryState<T>> {
  const data = signal<T[]>([])
  const loading = signal(true)
  const error = signal<DatabaseError | null>(null)
  const isStale = signal(false)

  // Load from cache immediately
  queryCache.get<T>(query, params).then(cached => {
    if (cached) {
      data.value = cached
      loading.value = false
      isStale.value = true
    }
  })

  // Set up database query when ready
  effect(() => {
    if (dbReady.value) {
      executeQuery()
    }
  })

  return computed(() => ({
    data: data.value,
    loading: loading.value,
    error: error.value,
    isStale: isStale.value
  }))
}
```

### 3. Cache Layer

```typescript
interface CachedQuery<T> {
  query: string
  params: any[]
  data: T[]
  timestamp: number
  version: string
}

class QueryCache {
  async get<T>(query: string, params: any[]): Promise<T[] | null>
  async set<T>(query: string, params: any[], data: T[]): Promise<void>
  async clear(): Promise<void>
}
```

## Implementation Details

### 1. Query Signal Creation

When creating a query signal:
1. Signal initializes with loading state
2. Immediately attempts to load from cache
3. If cache hit:
   - Renders cached data
   - Sets isStale flag
4. When database ready:
   - Executes fresh query
   - Updates cache
   - Updates UI
5. Sets up live query subscription

### 2. Component Integration

```typescript
// Example component using query signal
function UsersList() {
  const usersQuery = createQuerySignal<User>('SELECT * FROM "user" ORDER BY "createdAt" DESC')
  
  const view = computed(() => {
    const { loading, error, data, isStale } = usersQuery.value
    
    if (loading && !isStale) {
      return { type: 'loading' as const }
    }

    if (error) {
      return { type: 'error' as const, error }
    }

    return { type: 'data' as const, data, isStale }
  })

  return (
    <div>
      {view.value.isStale && (
        <div className="text-yellow-500">Showing cached data...</div>
      )}
      <DataTable data={view.value.data} />
    </div>
  )
}
```

### 3. Loading States

Components handle their own loading states using the PageWrapper:
```typescript
function PageWrapper({ children, fallback = <DefaultFallback /> }) {
  if (!dbReady.value) {
    return fallback
  }
  return children
}
```

The fallback shows a content-aware placeholder that matches the app theme:
- Maintains visual consistency
- Reduces perceived loading time
- Prevents layout shifts

## Best Practices

### 1. Signal Creation
- Create signals at module level
- Use computed for derived state
- Keep signals readonly when possible
- Clean up effects properly

### 2. Cache Strategy
- Cache query results in IndexedDB
- Include version/timestamp metadata
- Implement clear invalidation rules
- Handle cache misses gracefully

### 3. Component Design
- Use PageWrapper for loading states
- Show stale data indicators
- Handle errors appropriately
- Implement proper cleanup

### 4. Query Optimization
- Use parameterized queries
- Batch related queries
- Minimize unnecessary updates
- Monitor cache hit rates

## Benefits

1. **Performance**
   - Instant initial renders
   - Background data fetching
   - Smooth transitions
   - Efficient updates

2. **User Experience**
   - No loading spinners
   - Immediate interactivity
   - Clear data freshness
   - Offline support

3. **Developer Experience**
   - Simple signal creation
   - Type-safe queries
   - Automatic cache handling
   - Clear component patterns

4. **Maintainability**
   - Centralized state management
   - Predictable data flow
   - Easy debugging
   - Testable components

## Example Flows

### 1. Initial Page Load
```
Mount Component
    ↓
Check Cache → Found → Render Cached Data
    ↓
Wait for DB Ready
    ↓
Execute Query → Update Cache → Update UI
```

### 2. Data Updates
```
Live Query Update
    ↓
Update Signal
    ↓
Update Cache
    ↓
Update UI
```

### 3. Cache Miss
```
Mount Component
    ↓
Check Cache → Not Found → Show Loading State
    ↓
Wait for DB Ready
    ↓
Execute Query → Update Cache → Update UI
``` 