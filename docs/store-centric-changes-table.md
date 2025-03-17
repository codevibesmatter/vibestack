# Store-Centric Changes Table Architecture

This document outlines an enhanced architecture for VibeStack that combines the changes table approach with a store-centric design pattern.

## Core Principles

1. **UI-Driven Data Shapes**: Each UI visualization has specific data requirements that drive the shape of our stores.
2. **Visualization-Specific Stores**: Stores are created based on UI presentation needs, not just entity types.
3. **Changes Table as Source of Truth**: All data modifications flow through the changes table.
4. **Decentralized Entity Logic**: Entity-specific logic is encapsulated within its own module.

## Architecture Components

### 1. UI-Driven Stores

Stores are created based on how data needs to be presented in the UI, not just mirroring entity types:

- Multiple stores might exist for the same entity type, each optimized for a different visualization
- Store structure is optimized for the specific UI component it serves
- Selectors provide convenient access patterns for the UI components

Example: Different stores for different Task visualizations:

```typescript
// stores/taskKanbanStore.ts
import { create } from 'zustand';
import { Task } from '@repo/typeorm/client-entities';

interface TaskKanbanState {
  // Data optimized for Kanban view
  columns: Record<string, string[]>; // status -> task IDs
  tasks: Record<string, Task>;
  columnOrder: string[];
  isLoading: boolean;
  
  // Actions
  setTasks: (tasks: Task[]) => void;
  upsertTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  moveTask: (taskId: string, fromStatus: string, toStatus: string) => void;
  setLoading: (isLoading: boolean) => void;
}

export const useTaskKanbanStore = create<TaskKanbanState>((set) => ({
  // Initial state
  columns: { 
    'todo': [], 
    'in-progress': [], 
    'done': [] 
  },
  tasks: {},
  columnOrder: ['todo', 'in-progress', 'done'],
  isLoading: false,
  
  // Actions
  setTasks: (tasks) => set((state) => {
    const tasksMap: Record<string, Task> = {};
    const columns = { ...state.columns };
    
    // Reset columns
    Object.keys(columns).forEach(status => {
      columns[status] = [];
    });
    
    // Populate columns and tasks map
    tasks.forEach(task => {
      tasksMap[task.id] = task;
      const status = task.status || 'todo';
      if (columns[status]) {
        columns[status].push(task.id);
      } else {
        columns[status] = [task.id];
      }
    });
    
    return {
      tasks: tasksMap,
      columns,
      lastUpdated: Date.now()
    };
  }),
  
  upsertTask: (task) => set((state) => {
    const oldTask = state.tasks[task.id];
    const oldStatus = oldTask?.status || 'todo';
    const newStatus = task.status || 'todo';
    
    // Create new state objects to maintain immutability
    const tasks = { ...state.tasks, [task.id]: task };
    const columns = { ...state.columns };
    
    // Handle status change
    if (oldTask && oldStatus !== newStatus) {
      // Remove from old status column
      columns[oldStatus] = columns[oldStatus].filter(id => id !== task.id);
      
      // Add to new status column
      if (!columns[newStatus]) {
        columns[newStatus] = [];
      }
      columns[newStatus].push(task.id);
    } 
    // Handle new task
    else if (!oldTask) {
      if (!columns[newStatus]) {
        columns[newStatus] = [];
      }
      columns[newStatus].push(task.id);
    }
    
    return {
      tasks,
      columns,
      lastUpdated: Date.now()
    };
  }),
  
  removeTask: (taskId) => set((state) => {
    const task = state.tasks[taskId];
    if (!task) return state;
    
    const status = task.status || 'todo';
    const tasks = { ...state.tasks };
    const columns = { ...state.columns };
    
    // Remove task from state
    delete tasks[taskId];
    
    // Remove task from column
    columns[status] = columns[status].filter(id => id !== taskId);
    
    return {
      tasks,
      columns,
      lastUpdated: Date.now()
    };
  }),
  
  moveTask: (taskId, fromStatus, toStatus) => set((state) => {
    const columns = { ...state.columns };
    const tasks = { ...state.tasks };
    
    // Remove from source column
    columns[fromStatus] = columns[fromStatus].filter(id => id !== taskId);
    
    // Add to destination column
    if (!columns[toStatus]) {
      columns[toStatus] = [];
    }
    columns[toStatus].push(taskId);
    
    // Update task status
    if (tasks[taskId]) {
      tasks[taskId] = {
        ...tasks[taskId],
        status: toStatus,
        updatedAt: new Date().toISOString()
      };
    }
    
    return {
      columns,
      tasks,
      lastUpdated: Date.now()
    };
  }),
  
  setLoading: (isLoading) => set({ isLoading })
}));

// Selector hooks
export const useTasksByStatus = (status: string) => {
  return useTaskKanbanStore(state => {
    const taskIds = state.columns[status] || [];
    return taskIds.map(id => state.tasks[id]).filter(Boolean);
  });
};

Another store for the same entity but different visualization:

```typescript
// stores/taskGanttStore.ts
import { create } from 'zustand';
import { Task } from '@repo/typeorm/client-entities';

interface TaskGanttState {
  // Data optimized for Gantt chart view
  tasks: Record<string, Task>;
  dependencies: Record<string, string[]>; // taskId -> dependent task IDs
  timelineStart: Date | null;
  timelineEnd: Date | null;
  zoomLevel: number;
  isLoading: boolean;
  
  // Actions
  setTasks: (tasks: Task[]) => void;
  upsertTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  setTimeRange: (start: Date, end: Date) => void;
  setZoomLevel: (level: number) => void;
  setLoading: (isLoading: boolean) => void;
}

export const useTaskGanttStore = create<TaskGanttState>((set) => ({
  // Initial state
  tasks: {},
  dependencies: {},
  timelineStart: null,
  timelineEnd: null,
  zoomLevel: 1,
  isLoading: false,
  
  // Actions
  setTasks: (tasks) => set((state) => {
    const tasksMap: Record<string, Task> = {};
    const dependencies: Record<string, string[]> = {};
    
    // Calculate timeline range
    let minDate: Date | null = null;
    let maxDate: Date | null = null;
    
    tasks.forEach(task => {
      tasksMap[task.id] = task;
      
      // Extract dependencies
      if (task.dependsOn) {
        dependencies[task.id] = Array.isArray(task.dependsOn) 
          ? task.dependsOn 
          : [task.dependsOn];
      }
      
      // Update timeline range
      if (task.startDate) {
        const startDate = new Date(task.startDate);
        if (!minDate || startDate < minDate) {
          minDate = startDate;
        }
      }
      
      if (task.dueDate) {
        const dueDate = new Date(task.dueDate);
        if (!maxDate || dueDate > maxDate) {
          maxDate = dueDate;
        }
      }
    });
    
    return {
      tasks: tasksMap,
      dependencies,
      timelineStart: minDate,
      timelineEnd: maxDate,
      lastUpdated: Date.now()
    };
  }),
  
  upsertTask: (task) => set((state) => {
    // Update tasks
    const tasks = { ...state.tasks, [task.id]: task };
    
    // Update dependencies
    const dependencies = { ...state.dependencies };
    if (task.dependsOn) {
      dependencies[task.id] = Array.isArray(task.dependsOn) 
        ? task.dependsOn 
        : [task.dependsOn];
    } else {
      delete dependencies[task.id];
    }
    
    // Update timeline if needed
    let { timelineStart, timelineEnd } = state;
    
    if (task.startDate) {
      const startDate = new Date(task.startDate);
      if (!timelineStart || startDate < timelineStart) {
        timelineStart = startDate;
      }
    }
    
    if (task.dueDate) {
      const dueDate = new Date(task.dueDate);
      if (!timelineEnd || dueDate > timelineEnd) {
        timelineEnd = dueDate;
      }
    }
    
    return {
      tasks,
      dependencies,
      timelineStart,
      timelineEnd,
      lastUpdated: Date.now()
    };
  }),
  
  removeTask: (taskId) => set((state) => {
    const tasks = { ...state.tasks };
    const dependencies = { ...state.dependencies };
    
    // Remove task
    delete tasks[taskId];
    
    // Remove dependencies
    delete dependencies[taskId];
    
    // Remove this task from other tasks' dependencies
    Object.keys(dependencies).forEach(id => {
      dependencies[id] = dependencies[id].filter(depId => depId !== taskId);
    });
    
    return {
      tasks,
      dependencies,
      lastUpdated: Date.now()
    };
  }),
  
  setTimeRange: (start, end) => set({
    timelineStart: start,
    timelineEnd: end
  }),
  
  setZoomLevel: (level) => set({
    zoomLevel: level
  }),
  
  setLoading: (isLoading) => set({ isLoading })
}));

// Selector hooks
export const useTasksInTimeRange = (start: Date, end: Date) => {
  return useTaskGanttStore(state => {
    return Object.values(state.tasks).filter(task => {
      if (!task.startDate || !task.dueDate) return false;
      
      const taskStart = new Date(task.startDate);
      const taskEnd = new Date(task.dueDate);
      
      return (taskStart <= end && taskEnd >= start);
    });
  });
};
```

### 2. Entity-Specific API Modules

Each entity type still has its own API module that:

- Provides functions for CRUD operations
- Records changes in the changes table
- Handles entity-specific validation and business logic

Example structure for a Task API module:

```typescript
// api/taskApi.ts
import { Task } from '@repo/typeorm/client-entities';
import { recordChange } from '../db/changes-table';
import { ensureDB } from '../db/types';
import { db } from '../db';

// Fetch all tasks from the database
export const fetchAllTasks = async (): Promise<Task[]> => {
  try {
    const result = await ensureDB(db).query(`
      SELECT * FROM "task" 
      ORDER BY created_at DESC
    `);
    
    return result.rows as Task[];
  } catch (error) {
    console.error('Error fetching tasks:', error);
    throw error;
  }
};

// Create a new task
export const createTask = async (data: Partial<Task>): Promise<void> => {
  if (!data.title) {
    throw new Error('Task title is required');
  }

  const taskId = data.id || crypto.randomUUID();
  
  const taskData = {
    id: taskId,
    title: data.title,
    description: data.description || '',
    status: data.status || 'todo',
    assigneeId: data.assigneeId,
    projectId: data.projectId,
    priority: data.priority || 'medium',
    startDate: data.startDate,
    dueDate: data.dueDate,
    dependsOn: data.dependsOn || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  // Record the change in the changes table
  await recordChange('Task', taskId, 'insert', taskData);
};

// Update a task
export const updateTask = async (id: string, data: Partial<Task>): Promise<void> => {
  // Fetch the current task from the database
  const result = await ensureDB(db).query(`
    SELECT * FROM "task" 
    WHERE id = $1
  `, [id]);
  
  const currentTask = result.rows?.[0] as Task | undefined;
  
  if (!currentTask) {
    throw new Error(`Task ${id} not found`);
  }
  
  // Create updated task data
  const updatedTask = {
    ...currentTask,
    ...data,
    updatedAt: new Date().toISOString()
  };
  
  // Record the change in the changes table
  await recordChange('Task', id, 'update', updatedTask);
};

// Delete a task
export const deleteTask = async (id: string): Promise<void> => {
  // Record the change in the changes table
  await recordChange('Task', id, 'delete');
};
```

### 3. Entity-Specific Processors

Each entity type has its own processor module that:

- Handles changes specific to that entity type
- Updates all relevant stores for that entity
- Implements entity-specific business logic for processing changes

Example structure for a Task processor that updates multiple stores:

```typescript
// processors/taskProcessor.ts
import { useTaskKanbanStore } from '../stores/taskKanbanStore';
import { useTaskGanttStore } from '../stores/taskGanttStore';
import { syncLogger } from '../utils/logger';

/**
 * Process a Task entity change
 * @param taskId The task ID
 * @param operation The operation (insert, update, delete)
 * @param taskData The task data
 */
export async function processTaskChange(taskId: string, operation: string, taskData: any): Promise<void> {
  // Get all task-related stores
  const kanbanStore = useTaskKanbanStore.getState();
  const ganttStore = useTaskGanttStore.getState();
  
  switch (operation) {
    case 'insert':
    case 'update':
      if (!taskData) {
        throw new Error('Task data is required for insert/update operations');
      }
      
      // Ensure the ID in the data matches the entity ID
      taskData.id = taskId;
      
      // Update all relevant stores
      kanbanStore.upsertTask(taskData);
      ganttStore.upsertTask(taskData);
      
      syncLogger.info(`Updated task in stores: ${taskId}`);
      break;
      
    case 'delete':
      // Remove from all relevant stores
      kanbanStore.removeTask(taskId);
      ganttStore.removeTask(taskId);
      
      syncLogger.info(`Removed task from stores: ${taskId}`);
      break;
      
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}
```

### 4. Enhanced Change Processor

The main change processor is updated to delegate to entity-specific processors:

```typescript
// db/change-processor.ts
import { getDatabase } from './core';
import { dbMessageBus } from './message-bus';
import { syncLogger } from '../utils/logger';
// Import entity processors
import { processUserChange } from '../processors/userProcessor';
import { processTaskChange } from '../processors/taskProcessor';
// Import other entity processors as needed

// Process a single change
async function processChange(change: any): Promise<void> {
  const { id, entity_type, entity_id, operation, data } = change;
  
  syncLogger.info(`Processing change: ${id} - ${entity_type}/${entity_id} - ${operation}`);
  
  try {
    const db = await getDatabase();
    
    // Increment attempt counter
    await db.query(`
      UPDATE local_changes 
      SET attempts = attempts + 1 
      WHERE id = $1
    `, [id]);
    
    // Parse the data if it's a string, otherwise use as is
    let parsedData = null;
    if (data) {
      try {
        parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      } catch (error: any) {
        throw new Error(`Failed to parse data: ${error.message}`);
      }
    }
    
    // Process the change based on entity type
    switch (entity_type) {
      case 'User':
        await processUserChange(entity_id, operation, parsedData);
        break;
      case 'Task':
        await processTaskChange(entity_id, operation, parsedData);
        break;
      // Add cases for other entity types
      default:
        syncLogger.warn(`Unknown entity type: ${entity_type}`);
        break;
    }
    
    // Mark as processed locally
    await db.query(`
      UPDATE local_changes 
      SET processed_local = TRUE, 
          error = NULL
      WHERE id = $1
    `, [id]);
    
    // Publish event
    dbMessageBus.publish('change_processed', {
      changeId: id,
      entityType: entity_type,
      entityId: entity_id,
      operation,
      success: true
    });
    
  } catch (error) {
    // Error handling logic
  }
}
```

## Directory Structure

```
src/
  stores/
    userStore.ts           # User entity store
    taskKanbanStore.ts     # Task store optimized for Kanban view
    taskGanttStore.ts      # Task store optimized for Gantt chart view
    taskCalendarStore.ts   # Task store optimized for Calendar view
    projectListStore.ts    # Project store optimized for list view
    projectDetailsStore.ts # Project store optimized for details view
  api/
    userApi.ts             # User-specific API functions
    taskApi.ts             # Task-specific API functions
    projectApi.ts          # Project-specific API functions
  processors/
    userProcessor.ts       # User-specific change processor
    taskProcessor.ts       # Task-specific change processor
    projectProcessor.ts    # Project-specific change processor
  db/
    changes-table.ts       # Generic changes table functionality
    change-processor.ts    # Generic processor that delegates to entity processors
    message-bus.ts         # Message bus for communication
```

## Benefits of This Approach

1. **UI-Optimized Data**: Each store is structured to match the exact needs of its UI components.

2. **Modularity**: Each visualization's logic is self-contained, making it easier to understand and maintain.

3. **Scalability**: New visualizations can be added without modifying existing code.

4. **Performance**: Each store only updates when relevant data changes and is structured for efficient rendering.

5. **Type Safety**: Visualization-specific stores can have proper TypeScript typing.

6. **Testability**: Smaller, focused modules are easier to test.

7. **Developer Experience**: Clear separation of concerns makes it easier for developers to find and modify code.

8. **Offline Support**: Changes are recorded even when offline.

9. **Audit Trail**: Complete history of all data modifications.

10. **Resilience**: Failed operations can be retried.

## Implementation Steps

1. **Identify UI Visualizations**: For each entity type, identify the different ways it needs to be visualized in the UI.

2. **Create Visualization-Specific Stores**: For each visualization, create a dedicated Zustand store optimized for that view.

3. **Create Entity API Modules**: For each entity type, create an API module with CRUD operations.

4. **Create Entity Processors**: For each entity type, create a processor module that updates all relevant stores.

5. **Update Change Processor**: Modify the main change processor to delegate to entity-specific processors.

6. **Update UI Components**: Update UI components to use the visualization-specific stores.

## Usage Example

```typescript
// In a Kanban board component
import { useEffect } from 'react';
import { useTasksByStatus } from '../stores/taskKanbanStore';
import { fetchAllTasks, createTask, updateTask } from '../api/taskApi';

function KanbanBoard() {
  const todoTasks = useTasksByStatus('todo');
  const inProgressTasks = useTasksByStatus('in-progress');
  const doneTasks = useTasksByStatus('done');
  
  useEffect(() => {
    // Fetch tasks when component mounts
    fetchAllTasks();
  }, []);
  
  const handleAddTask = async () => {
    await createTask({
      title: 'New Task',
      status: 'todo'
    });
  };
  
  const handleMoveTask = async (taskId: string, newStatus: string) => {
    await updateTask(taskId, { status: newStatus });
  };
  
  return (
    <div className="kanban-board">
      <button onClick={handleAddTask}>Add Task</button>
      
      <div className="columns">
        <div className="column">
          <h2>To Do</h2>
          {todoTasks.map(task => (
            <div key={task.id} className="task-card">
              {task.title}
              <button onClick={() => handleMoveTask(task.id, 'in-progress')}>
                Move to In Progress
              </button>
            </div>
          ))}
        </div>
        
        <div className="column">
          <h2>In Progress</h2>
          {inProgressTasks.map(task => (
            <div key={task.id} className="task-card">
              {task.title}
              <button onClick={() => handleMoveTask(task.id, 'done')}>
                Move to Done
              </button>
            </div>
          ))}
        </div>
        
        <div className="column">
          <h2>Done</h2>
          {doneTasks.map(task => (
            <div key={task.id} className="task-card">
              {task.title}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

## Conclusion

The UI-driven store-centric changes table architecture combines the benefits of the changes table approach with a modular, visualization-specific design. This approach makes the codebase more maintainable, scalable, and resilient, while providing a great developer experience and ensuring that each UI component has access to data in the most optimal format for its specific needs. 