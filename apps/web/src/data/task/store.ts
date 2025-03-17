import { atom } from 'jotai';
import { useAtom } from 'jotai';
import { atomWithReset } from 'jotai/utils';
import { atomFamily } from 'jotai/utils';
import { Task, TaskStatus, TaskPriority } from '@repo/typeorm/client-entities';
import { 
  getAllTasks, 
  createTask, 
  updateTask, 
  deleteTask, 
  getTaskById
} from './api';
import { PerformanceMetrics } from '../common/base/DataAccess';
import { dbMessageBus, DbEventType } from '../../db/message-bus';
import { useEffect } from 'react';

// Extended Task type for optimistic updates
interface OptimisticTask extends Task {
  _optimistic?: boolean;
  _temp?: boolean;
}

// ===== Base atoms =====
export const tasksAtom = atom<OptimisticTask[]>([]);
export const tasksLoadingAtom = atom<boolean>(false);
export const tasksErrorAtom = atom<string | null>(null);
export const tasksTotalCountAtom = atom<number>(0);
export const tasksMetricsAtom = atom<PerformanceMetrics>({ queryTime: 0, totalTime: 0 });

// ===== Normalized store atoms =====
// Map of task IDs to task objects
export const tasksByIdAtom = atom<Record<string, OptimisticTask>>({});
// Set of task IDs that are currently loading
export const loadingTaskIdsAtom = atom<Set<string>>(new Set<string>());
// Set of task IDs that have errors
export const errorTaskIdsAtom = atom<Record<string, string>>({});
// Set of task IDs that are loaded
export const loadedTaskIdsAtom = atom<Set<string>>(new Set<string>());

// ===== UI state atoms =====
export const selectedTaskIdAtom = atomWithReset<string | null>(null);
export const highlightedTaskIdAtom = atomWithReset<string | null>(null);

// ===== Derived atoms =====
export const selectedTaskAtom = atom(
  (get) => {
    const selectedId = get(selectedTaskIdAtom);
    if (!selectedId) return null;
    
    // First check the normalized store
    const tasksById = get(tasksByIdAtom);
    if (tasksById[selectedId]) return tasksById[selectedId];
    
    // Fall back to the array if not found in normalized store
    const tasks = get(tasksAtom);
    return tasks.find(task => task.id === selectedId) || null;
  }
);

// Create an atom family for accessing individual tasks by ID
export const taskByIdAtom = atomFamily((taskId: string) => 
  atom(
    (get) => {
      const tasksById = get(tasksByIdAtom);
      return tasksById[taskId] || null;
    }
  )
);

// ===== Action atoms =====

// Fetch all tasks with optional filtering
export const fetchTasksAtom = atom(
  null,
  async (get, set, options: {
    projectId?: string;
    assigneeId?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
  } = {}) => {
    set(tasksLoadingAtom, true);
    set(tasksErrorAtom, null);
    
    try {
      const startTime = performance.now();
      
      // Fetch tasks from API
      const tasks = await getAllTasks({
        projectId: options.projectId,
        assigneeId: options.assigneeId,
        status: options.status,
        priority: options.priority
      });
      
      // Calculate metrics
      const endTime = performance.now();
      const metrics = {
        queryTime: endTime - startTime,
        totalTime: endTime - startTime
      };
      
      // Update atoms
      set(tasksAtom, tasks as OptimisticTask[]);
      set(tasksTotalCountAtom, tasks.length);
      set(tasksMetricsAtom, metrics);
      
      // Update normalized store
      const tasksById: Record<string, OptimisticTask> = {};
      const loadedIds = new Set<string>();
      
      tasks.forEach((task: Task) => {
        tasksById[task.id] = task as OptimisticTask;
        loadedIds.add(task.id);
      });
      
      set(tasksByIdAtom, tasksById);
      set(loadedTaskIdsAtom, loadedIds);
      set(tasksLoadingAtom, false);
      
      return tasks;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to fetch tasks';
      set(tasksErrorAtom, errorMessage);
      set(tasksLoadingAtom, false);
      throw error;
    }
  }
);

// Fetch tasks by project ID
export const fetchTasksByProjectIdAtom = atom(
  null,
  async (get, set, projectId: string) => {
    try {
      const startTime = performance.now();
      
      // Fetch tasks from API
      const tasks = await getAllTasks({
        projectId
      });
      
      // Calculate metrics
      const endTime = performance.now();
      const metrics = {
        queryTime: endTime - startTime,
        totalTime: endTime - startTime
      };
      
      // Update normalized store
      const tasksById: Record<string, OptimisticTask> = {};
      const loadedIds = new Set<string>();
      
      tasks.forEach((task: Task) => {
        tasksById[task.id] = task as OptimisticTask;
        loadedIds.add(task.id);
      });
      
      set(tasksByIdAtom, { ...get(tasksByIdAtom), ...tasksById });
      set(loadedTaskIdsAtom, new Set([...get(loadedTaskIdsAtom), ...loadedIds]));
      
      return tasks;
    } catch (error) {
      console.error(`Error fetching tasks for project ${projectId}:`, error);
      throw error;
    }
  }
);

// Fetch tasks by assignee ID
export const fetchTasksByAssigneeIdAtom = atom(
  null,
  async (get, set, assigneeId: string) => {
    try {
      const startTime = performance.now();
      
      // Fetch tasks from API
      const tasks = await getAllTasks({
        assigneeId
      });
      
      // Calculate metrics
      const endTime = performance.now();
      const metrics = {
        queryTime: endTime - startTime,
        totalTime: endTime - startTime
      };
      
      // Update normalized store
      const tasksById: Record<string, OptimisticTask> = {};
      const loadedIds = new Set<string>();
      
      tasks.forEach((task: Task) => {
        tasksById[task.id] = task as OptimisticTask;
        loadedIds.add(task.id);
      });
      
      set(tasksByIdAtom, { ...get(tasksByIdAtom), ...tasksById });
      set(loadedTaskIdsAtom, new Set([...get(loadedTaskIdsAtom), ...loadedIds]));
      
      return tasks;
    } catch (error) {
      console.error(`Error fetching tasks for assignee ${assigneeId}:`, error);
      throw error;
    }
  }
);

// Fetch a single task by ID
export const fetchTaskByIdAtom = atom(
  null,
  async (get, set, taskId: string) => {
    // Check if already loading this task
    const loadingIds = get(loadingTaskIdsAtom);
    if (loadingIds.has(taskId)) return;
    
    // Add to loading set
    set(loadingTaskIdsAtom, new Set([...loadingIds, taskId]));
    
    try {
      // Fetch task from API
      const task = await getTaskById(taskId);
      
      if (task) {
        // Update normalized store
        const tasksById = { ...get(tasksByIdAtom) };
        tasksById[taskId] = task;
        set(tasksByIdAtom, tasksById);
        
        // Add to loaded set
        const loadedIds = new Set(get(loadedTaskIdsAtom));
        loadedIds.add(taskId);
        set(loadedTaskIdsAtom, loadedIds);
        
        // Remove any error for this task
        const errorIds = { ...get(errorTaskIdsAtom) };
        delete errorIds[taskId];
        set(errorTaskIdsAtom, errorIds);
      }
      
      return task;
    } catch (error) {
      // Record error for this task
      const errorIds = { ...get(errorTaskIdsAtom) };
      errorIds[taskId] = error instanceof Error ? error.message : 'Failed to fetch task';
      set(errorTaskIdsAtom, errorIds);
      
      return null;
    } finally {
      // Remove from loading set
      const updatedLoadingIds = new Set(get(loadingTaskIdsAtom));
      updatedLoadingIds.delete(taskId);
      set(loadingTaskIdsAtom, updatedLoadingIds);
    }
  }
);

// Create a task with optimistic updates
export const createTaskAtom = atom(
  null,
  async (get, set, taskData: Partial<Task>) => {
    // Generate a temporary ID for optimistic update
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    try {
      // Create optimistic task
      const now = new Date();
      const optimisticTask: OptimisticTask = {
        id: tempId,
        title: taskData.title || 'New Task',
        description: taskData.description || '',
        status: taskData.status || TaskStatus.OPEN,
        priority: taskData.priority || TaskPriority.MEDIUM,
        projectId: taskData.projectId || '',
        assigneeId: taskData.assigneeId || '',
        dueDate: taskData.dueDate || undefined,
        completedAt: taskData.completedAt || undefined,
        timeEstimate: taskData.timeEstimate || 0,
        timeSpent: taskData.timeSpent || 0,
        tags: taskData.tags || [],
        dependencyIds: taskData.dependencyIds || [],
        createdAt: now,
        updatedAt: now,
        _optimistic: true,
        _temp: true,
        project: {} as any,
        dependencies: []
      };
      
      // Apply optimistic update to store immediately
      const tasksById = { ...get(tasksByIdAtom) };
      tasksById[tempId] = optimisticTask;
      set(tasksByIdAtom, tasksById);
      
      // Update tasks array optimistically
      const tasks = [optimisticTask, ...get(tasksAtom)];
      set(tasksAtom, tasks);
      set(tasksTotalCountAtom, tasks.length);
      
      // Add to loaded set
      const loadedIds = new Set(get(loadedTaskIdsAtom));
      loadedIds.add(tempId);
      set(loadedTaskIdsAtom, loadedIds);
      
      // Perform actual API create
      const newTask = await createTask(taskData);
      
      // Remove temporary task
      const updatedTasksById = { ...get(tasksByIdAtom) };
      delete updatedTasksById[tempId];
      updatedTasksById[newTask.id] = newTask as OptimisticTask;
      set(tasksByIdAtom, updatedTasksById);
      
      // Update tasks array with real task
      const updatedTasks = get(tasksAtom)
        .filter(task => !task._temp)
        .concat([newTask as OptimisticTask])
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      set(tasksAtom, updatedTasks);
      
      // Update loaded IDs
      const updatedLoadedIds = new Set(get(loadedTaskIdsAtom));
      updatedLoadedIds.delete(tempId);
      updatedLoadedIds.add(newTask.id);
      set(loadedTaskIdsAtom, updatedLoadedIds);
      
      return newTask;
    } catch (error: unknown) {
      // Revert optimistic create on failure
      const tasksById = { ...get(tasksByIdAtom) };
      delete tasksById[tempId];
      set(tasksByIdAtom, tasksById);
      
      // Update tasks array
      const tasks = get(tasksAtom).filter(task => task.id !== tempId);
      set(tasksAtom, tasks);
      set(tasksTotalCountAtom, tasks.length);
      
      // Remove from loaded set
      const loadedIds = new Set(get(loadedTaskIdsAtom));
      loadedIds.delete(tempId);
      set(loadedTaskIdsAtom, loadedIds);
      
      throw error;
    }
  }
);

// Update a task with optimistic updates
export const updateTaskAtom = atom(
  null,
  async (get, set, taskId: string, taskData: Partial<Task>) => {
    try {
      // Get current task data
      const currentTask = get(tasksByIdAtom)[taskId];
      if (!currentTask) {
        throw new Error(`Task with ID ${taskId} not found in store`);
      }
      
      // Create optimistic update with current timestamp
      const now = new Date();
      const optimisticTask: OptimisticTask = {
        ...currentTask,
        ...taskData,
        updatedAt: now,
        _optimistic: true // Mark as optimistic
      };
      
      // Apply optimistic update to store immediately
      const tasksById = { ...get(tasksByIdAtom) };
      tasksById[taskId] = optimisticTask;
      set(tasksByIdAtom, tasksById);
      
      // Update tasks array optimistically
      const tasks = get(tasksAtom).map(task => 
        task.id === taskId ? optimisticTask : task
      );
      set(tasksAtom, tasks);
      
      // Perform actual API update
      const updatedTask = await updateTask(taskId, taskData);
      
      // Confirm update with actual data from API
      const confirmedTask: OptimisticTask = {
        ...updatedTask,
        _optimistic: false
      };
      
      // Update normalized store with confirmed data
      const confirmedTasksById = { ...get(tasksByIdAtom) };
      confirmedTasksById[taskId] = confirmedTask;
      set(tasksByIdAtom, confirmedTasksById);
      
      // Update tasks array with confirmed data
      const confirmedTasks = get(tasksAtom).map(task => 
        task.id === taskId ? confirmedTask : task
      );
      set(tasksAtom, confirmedTasks);
      
      return updatedTask;
    } catch (error: unknown) {
      // Revert optimistic update on failure
      if (get(tasksByIdAtom)[taskId]?._optimistic) {
        // Fetch the original data to revert
        try {
          const originalTask = await getTaskById(taskId);
          
          if (originalTask) {
            // Revert in normalized store
            const tasksById = { ...get(tasksByIdAtom) };
            tasksById[taskId] = originalTask as OptimisticTask;
            set(tasksByIdAtom, tasksById);
            
            // Revert in tasks array
            const tasks = get(tasksAtom).map(task => 
              task.id === taskId ? (originalTask as OptimisticTask) : task
            );
            set(tasksAtom, tasks);
          }
        } catch (fetchError) {
          console.error('Error fetching original task data for revert:', fetchError);
        }
      }
      
      throw error;
    }
  }
);

// Delete a task with optimistic updates
export const deleteTaskAtom = atom(
  null,
  async (get, set, taskId: string) => {
    try {
      // Get current task data
      const currentTask = get(tasksByIdAtom)[taskId];
      if (!currentTask) {
        throw new Error(`Task with ID ${taskId} not found in store`);
      }
      
      // Store the current task for potential revert
      const taskToDelete = { ...currentTask };
      
      // Apply optimistic delete to store immediately
      const tasksById = { ...get(tasksByIdAtom) };
      delete tasksById[taskId];
      set(tasksByIdAtom, tasksById);
      
      // Update tasks array optimistically
      const tasks = get(tasksAtom).filter(task => task.id !== taskId);
      set(tasksAtom, tasks);
      set(tasksTotalCountAtom, tasks.length);
      
      // Remove from loaded set
      const loadedIds = new Set(get(loadedTaskIdsAtom));
      loadedIds.delete(taskId);
      set(loadedTaskIdsAtom, loadedIds);
      
      // Perform actual API delete
      await deleteTask(taskId);
      
      return taskToDelete;
    } catch (error: unknown) {
      // Revert optimistic delete on failure
      try {
        const originalTask = await getTaskById(taskId);
        
        if (originalTask) {
          // Restore in normalized store
          const tasksById = { ...get(tasksByIdAtom) };
          tasksById[taskId] = originalTask as OptimisticTask;
          set(tasksByIdAtom, tasksById);
          
          // Restore in tasks array
          const tasks = [...get(tasksAtom), originalTask as OptimisticTask]
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
          set(tasksAtom, tasks);
          set(tasksTotalCountAtom, tasks.length);
          
          // Add back to loaded set
          const loadedIds = new Set(get(loadedTaskIdsAtom));
          loadedIds.add(taskId);
          set(loadedTaskIdsAtom, loadedIds);
        }
      } catch (fetchError) {
        console.error('Error fetching original task data for revert:', fetchError);
      }
      
      throw error;
    }
  }
);

// Search tasks by title
export const searchTasksByTitleAtom = atom(
  null,
  async (get, set, searchTerm: string) => {
    set(tasksLoadingAtom, true);
    set(tasksErrorAtom, null);
    
    try {
      // For now, we'll implement client-side filtering
      // In a real app, you might want to call an API endpoint for this
      const allTasks = get(tasksAtom);
      
      if (allTasks.length === 0) {
        // If we don't have tasks yet, fetch them first
        try {
          // Call fetchTasksAtom directly
          const fetchTasks = get(fetchTasksAtom);
          // We need to cast it to any to avoid TypeScript errors
          await (fetchTasks as any)(set);
        } catch (fetchError) {
          console.error('Error fetching tasks:', fetchError);
        }
      }
      
      const filteredTasks = get(tasksAtom).filter(task => 
        task.title.toLowerCase().includes(searchTerm.toLowerCase())
      );
      
      return filteredTasks;
    } catch (error) {
      set(tasksErrorAtom, error instanceof Error ? error.message : 'Failed to search tasks');
      return [];
    } finally {
      set(tasksLoadingAtom, false);
    }
  }
);

// Helper atoms for UI
export const isTaskLoadingAtom = atomFamily((taskId: string) => 
  atom(
    (get) => get(loadingTaskIdsAtom).has(taskId)
  )
);

export const taskErrorAtom = atomFamily((taskId: string) => 
  atom(
    (get) => get(errorTaskIdsAtom)[taskId] || null
  )
);

export const isTaskLoadedAtom = atomFamily((taskId: string) => 
  atom(
    (get) => get(loadedTaskIdsAtom).has(taskId)
  )
);

// ===== Subscription atom =====
// This atom subscribes to database change events and updates the tasksByIdAtom
export const taskDbSubscriptionAtom = atom(
  null,
  (get, set, subscribe: boolean) => {
    console.log('Task DB subscription atom is now a no-op with optimistic updates');
    return () => {
      // No-op cleanup
      console.log('Task DB subscription cleanup is now a no-op');
    };
  }
);

// ===== Helper hook for using the subscription =====
// This is now a no-op function since we're handling updates directly in the store
export const useTaskDbSubscription = () => {
  useEffect(() => {
    // This function is now a no-op since we're using optimistic updates
    console.log('Task DB subscription is now a no-op with optimistic updates');
    return () => {
      // No-op cleanup
    };
  }, []);
}; 