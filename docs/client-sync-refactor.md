# Client Sync Refactor Plan

## Overview

This document outlines the recommended improvements for the frontend signals and queries implementation in the VibeStack application. The current implementation has several issues that may be causing unexpected behavior, including inefficient signal updates, inconsistent state management, and suboptimal WebSocket handling.

## Key Issues Identified

1. **Signal Update Mechanism**: Direct updates within query hooks causing unnecessary re-renders
2. **Multiple Signal Sources**: Redundant signals tracking the same data in different formats
3. **Sync State Management**: Duplicate sync client implementations and inefficient polling
4. **WebSocket Connection Handling**: Complex reconnection logic with potential edge cases
5. **Database Initialization**: Race conditions in database initialization
6. **Query Caching**: Lack of proper caching mechanism
7. **Signal Propagation**: No debouncing or batching for signal updates
8. **LSN Handling**: Potential synchronization issues with Log Sequence Numbers

## Recommended Improvements

### 1. Centralize Signal Management

**Current Issue:**
- Signals are defined and updated directly within query hooks, causing cascading updates and unnecessary re-renders
- Arrays of data are replaced entirely when only individual records change
- Multiple signals track the same data in different formats, leading to inconsistency

**Implementation Plan:**
- Create a dedicated `signals` folder for centralized signal management
- Use Map-based signals for efficient record-level updates
- Implement computed signals for derived data
- Provide action functions for updating signals

```typescript
// Example implementation in signals/tasks.ts
import { signal, computed, batch } from "@preact/signals-react";
import type { Task } from "@repo/db";

// Primary data store using Map for O(1) lookups and targeted updates
export const tasksMap = signal<Map<string, Task>>(new Map());

// UI state signals
export const selectedTaskId = signal<string | null>(null);
export const taskViewMode = signal<'list' | 'board'>('board');
export const taskFilter = signal<{
  status?: TaskStatus[];
  priority?: TaskPriority[];
  assigneeId?: string;
}>({});

// Computed signals for derived data
export const tasksList = computed(() => 
  Array.from(tasksMap.value.values())
);

export const tasksByProject = computed(() => {
  const result = new Map<string, Task[]>();
  for (const task of tasksMap.value.values()) {
    if (!task.projectId) continue;
    
    const tasks = result.get(task.projectId) || [];
    result.set(task.projectId, [...tasks, task]);
  }
  return result;
});

export const tasksByAssignee = computed(() => {
  const result = new Map<string, Task[]>();
  for (const task of tasksMap.value.values()) {
    if (!task.assigneeId) continue;
    
    const tasks = result.get(task.assigneeId) || [];
    result.set(task.assigneeId, [...tasks, task]);
  }
  return result;
});

// Action functions for updating state
export function updateTask(task: Task) {
  tasksMap.value = new Map(tasksMap.value).set(task.id, task);
}

export function updateTasks(tasks: Task[]) {
  const newMap = new Map(tasksMap.value);
  for (const task of tasks) {
    newMap.set(task.id, task);
  }
  tasksMap.value = newMap;
}

export function deleteTask(taskId: string) {
  const newMap = new Map(tasksMap.value);
  newMap.delete(taskId);
  tasksMap.value = newMap;
}

export function batchUpdateTasks(updates: Task[], deletions: string[] = []) {
  batch(() => {
    if (updates.length > 0) {
      updateTasks(updates);
    }
    
    for (const id of deletions) {
      deleteTask(id);
    }
  });
}
```

**Query Implementation:**
```typescript
// db/queries/tasks.ts
import { useLiveIncrementalQuery } from '@electric-sql/pglite-react';
import { updateTasks } from '../../signals/tasks';

export const useTasksList = () => {
  const result = useLiveIncrementalQuery<Task>(`
    SELECT 
      t.*,
      u.name as assignee_name,
      p.name as project_name
    FROM "task" t
    LEFT JOIN "user" u ON t."assigneeId" = u.id
    LEFT JOIN "project" p ON t."projectId" = p.id
    ORDER BY t."createdAt" DESC
  `, [], 'id');

  // Update signals when result changes
  if (result?.rows) {
    updateTasks(result.rows);
  }

  return result;
};
```

**Component Implementation:**
```tsx
// components/TaskRow.tsx
import { useComputed } from "@preact/signals-react";
import { tasksMap } from "../../signals/tasks";

export function TaskRow({ taskId }: { taskId: string }) {
  // This component only re-renders when this specific task changes
  const task = useComputed(() => tasksMap.value.get(taskId));
  
  if (!task.value) return null;
  
  return (
    <tr>
      <td>{task.value.title}</td>
      <td>{task.value.status}</td>
      {/* other cells */}
    </tr>
  );
}

// components/TasksTable.tsx
import { useComputed } from "@preact/signals-react";
import { tasksMap, taskFilter } from "../../signals/tasks";
import { TaskRow } from "./TaskRow";

export function TasksTable() {
  // This component only gets the list of IDs, not the full data
  const filteredTaskIds = useComputed(() => {
    const filter = taskFilter.value;
    return Array.from(tasksMap.value.entries())
      .filter(([_, task]) => {
        // Apply filters
        if (filter.status && filter.status.length > 0 && !filter.status.includes(task.status)) {
          return false;
        }
        if (filter.assigneeId && task.assigneeId !== filter.assigneeId) {
          return false;
        }
        return true;
      })
      .map(([id]) => id);
  });
  
  return (
    <table>
      <thead>{/* headers */}</thead>
      <tbody>
        {filteredTaskIds.value.map(id => (
          <TaskRow key={id} taskId={id} />
        ))}
      </tbody>
    </table>
  );
}
```

### 2. Improve Sync Client

**Current Issue:**
- Two different sync client implementations causing potential conflicts
- Polling mechanism for state changes is inefficient

**Implementation Plan:**
- Consolidate sync clients into a single implementation
- Replace polling with event-based updates
- Implement proper error handling and recovery

```typescript
// Example implementation
import { EventEmitter } from 'events';
import type { SyncState, SyncConfig } from './types';

export class SyncClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: SyncState;
  private config: SyncConfig;
  
  constructor(config: SyncConfig) {
    super();
    this.state = this.loadState();
    this.config = config;
  }
  
  // Load state from storage
  private loadState(): SyncState {
    // Implementation
  }
  
  // Save state to storage
  private saveState(state: Partial<SyncState>): void {
    this.state = { ...this.state, ...state };
    // Save to localStorage
    this.emit('stateChange', this.state);
  }
  
  // Connect with proper error handling
  async connect(): Promise<void> {
    // Implementation with proper error handling
  }
  
  // Other methods...
}

// Usage
const syncClient = new SyncClient(config);
syncClient.on('stateChange', (state) => {
  // Update UI or take other actions
});
```

### 3. Enhance WebSocket Handling

**Current Issue:**
- Complex reconnection logic with potential edge cases
- Insufficient error reporting

**Implementation Plan:**
- Implement a robust WebSocket manager with proper backoff strategy
- Add comprehensive logging and monitoring
- Improve error handling and user feedback

```typescript
// Example implementation
export class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseDelay = 1000; // 1 second
  
  constructor(private url: string, private options: WebSocketOptions) {}
  
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
        
        // Set up event handlers with proper error handling
        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          this.options.onOpen?.();
          resolve();
        };
        
        this.ws.onclose = (event) => {
          this.handleClose(event);
        };
        
        this.ws.onerror = (error) => {
          this.options.onError?.(error);
          reject(error);
        };
        
        this.ws.onmessage = (event) => {
          this.handleMessage(event);
        };
      } catch (error) {
        reject(error);
      }
    });
  }
  
  // Implement exponential backoff with jitter
  private getBackoffDelay(): number {
    const delay = this.baseDelay * Math.pow(2, this.reconnectAttempts);
    const jitter = delay * 0.2 * Math.random();
    return Math.min(delay + jitter, 30000); // Cap at 30 seconds
  }
  
  // Other methods...
}
```

### 4. Optimize Query Performance

**Current Issue:**
- No proper caching mechanism for queries
- Redundant database operations

**Implementation Plan:**
- Implement a query cache with proper invalidation
- Add batching for related queries
- Use React Query or a similar library for data fetching

```typescript
// Example implementation with React Query
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { db } from '../db';

// Query hooks with caching
export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: async () => {
      const result = await db.query(`SELECT * FROM task ORDER BY "createdAt" DESC`);
      return result.rows;
    },
    staleTime: 30000, // 30 seconds
  });
}

export function useTasksByProject(projectId: string) {
  return useQuery({
    queryKey: ['tasks', 'project', projectId],
    queryFn: async () => {
      const result = await db.query(
        `SELECT * FROM task WHERE "projectId" = $1 ORDER BY "priority" DESC`,
        [projectId]
      );
      return result.rows;
    },
    staleTime: 30000,
  });
}

// Mutation with cache updates
export function useUpdateTask() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (task) => {
      // Update task in database
      return updatedTask;
    },
    onSuccess: (updatedTask) => {
      // Update all related queries
      queryClient.setQueryData(['tasks', updatedTask.id], updatedTask);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ 
        queryKey: ['tasks', 'project', updatedTask.projectId] 
      });
    },
  });
}
```

### 5. Improve State Management

**Current Issue:**
- Complex state interactions without proper structure
- Inconsistent state updates

**Implementation Plan:**
- Adopt a structured state management approach
- Ensure atomic and consistent state updates
- Implement proper state persistence

```typescript
// Example implementation with state slices
// syncSlice.ts
interface SyncState {
  isConnected: boolean;
  lastLSN: string;
  clientId: string;
  // other sync state
}

const initialSyncState: SyncState = {
  isConnected: false,
  lastLSN: '0/0',
  clientId: crypto.randomUUID(),
  // other initial values
};

export const createSyncSlice = (set, get) => ({
  sync: {
    ...initialSyncState,
    connect: async () => {
      // Implementation
      set(state => ({
        sync: {
          ...state.sync,
          isConnected: true,
        }
      }));
    },
    disconnect: () => {
      // Implementation
      set(state => ({
        sync: {
          ...state.sync,
          isConnected: false,
        }
      }));
    },
    updateLSN: (lsn: string) => {
      // Implementation with proper validation
      set(state => ({
        sync: {
          ...state.sync,
          lastLSN: lsn,
        }
      }));
    },
    // other actions
  }
});
```

### 6. Better Error Handling

**Current Issue:**
- Insufficient error handling for network and database operations
- Limited user feedback

**Implementation Plan:**
- Implement comprehensive error handling strategy
- Add error boundaries at appropriate levels
- Provide clear user feedback for errors

```typescript
// Example implementation
// errorSlice.ts
interface ErrorState {
  errors: Record<string, Error>;
  hasError: boolean;
}

const initialErrorState: ErrorState = {
  errors: {},
  hasError: false,
};

export const createErrorSlice = (set, get) => ({
  errors: {
    ...initialErrorState,
    setError: (key: string, error: Error) => {
      console.error(`Error [${key}]:`, error);
      set(state => ({
        errors: {
          ...state.errors,
          errors: {
            ...state.errors.errors,
            [key]: error,
          },
          hasError: true,
        }
      }));
    },
    clearError: (key: string) => {
      set(state => {
        const newErrors = { ...state.errors.errors };
        delete newErrors[key];
        return {
          errors: {
            ...state.errors,
            errors: newErrors,
            hasError: Object.keys(newErrors).length > 0,
          }
        };
      });
    },
    clearAllErrors: () => {
      set(state => ({
        errors: {
          ...state.errors,
          errors: {},
          hasError: false,
        }
      }));
    },
  }
});

// ErrorBoundary component
import { Component, ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  fallback: ReactNode | ((error: Error) => ReactNode);
  children: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.state.error!);
      }
      return this.props.fallback;
    }

    return this.props.children;
  }
}
```

### 7. Code Organization

**Current Issue:**
- Unclear separation of concerns between data fetching, state management, and UI

**Implementation Plan:**
- Reorganize code with clear separation of concerns
- Implement feature-based folder structure
- Add proper documentation and type definitions

```
src/
├── features/
│   ├── tasks/
│   │   ├── api.ts         # Data fetching
│   │   ├── store.ts       # State management
│   │   ├── hooks.ts       # Custom hooks
│   │   ├── components/    # UI components
│   │   └── types.ts       # Type definitions
│   ├── projects/
│   │   └── ...
│   └── users/
│       └── ...
├── core/
│   ├── sync/              # Sync implementation
│   ├── db/                # Database implementation
│   └── state/             # Core state management
├── ui/                    # Shared UI components
└── utils/                 # Utility functions
```

## Implementation Roadmap

1. **Phase 1: State Management Refactor**
   - Implement centralized store
   - Migrate existing signals to store
   - Add proper selectors for derived data

2. **Phase 2: Sync Client Improvements**
   - Consolidate sync implementations
   - Implement robust WebSocket handling
   - Add comprehensive error handling

3. **Phase 3: Query Optimization**
   - Implement query caching
   - Add batching for related queries
   - Optimize data fetching patterns

4. **Phase 4: Code Reorganization**
   - Implement feature-based structure
   - Add proper documentation
   - Improve type definitions

## Conclusion

This refactor will significantly improve the reliability, performance, and maintainability of the frontend code. By addressing the identified issues, we can eliminate unexpected behaviors and provide a more robust user experience.

The implementation should be done incrementally to minimize disruption to the existing functionality, with comprehensive testing at each phase to ensure that the application continues to work as expected.
