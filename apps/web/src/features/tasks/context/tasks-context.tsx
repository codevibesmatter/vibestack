import React, { useState, useEffect, useCallback } from 'react'
import useDialogState from '@/hooks/use-dialog-state'
import { Task, TaskStatus, TaskPriority } from '@repo/dataforge/client-entities'
import { usePGliteContext } from '@/db/pglite-provider'

type TasksDialogType = 'create' | 'update' | 'delete' | 'import'

// Extend the context type to include task operations
interface TasksContextType {
  // UI state
  open: TasksDialogType | null
  setOpen: (str: TasksDialogType | null) => void
  currentRow: Task | null
  setCurrentRow: React.Dispatch<React.SetStateAction<Task | null>>
  
  // Task operations - using service methods only for clean interface
  createTask: (taskData: {
    title: string;
    projectId: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    assigneeId?: string;
    dueDate?: Date;
    timeRange?: [Date, Date];
    estimatedDuration?: number;
    tags?: string[];
  }) => Promise<Task>
  updateTask: (id: string, changes: Partial<Task>) => Promise<Task>
  deleteTask: (id: string) => Promise<boolean>
  updateTaskStatus: (id: string, status: TaskStatus) => Promise<Task>
}

const TasksContext = React.createContext<TasksContextType | null>(null)

interface Props {
  children: React.ReactNode
}

export default function TasksProvider({ children }: Props) {
  // UI state
  const [open, setOpen] = useDialogState<TasksDialogType>(null)
  const [currentRow, setCurrentRow] = useState<Task | null>(null)
  
  // Get task service directly from context
  const { services } = usePGliteContext();
  const taskService = services?.tasks;
  
  // Create a new task
  const createTask = useCallback(async (taskData: {
    title: string;
    projectId: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    assigneeId?: string;
    dueDate?: Date;
    timeRange?: [Date, Date];
    estimatedDuration?: number;
    tags?: string[];
  }) => {
    if (!taskService) {
      throw new Error('Task service not available');
    }
    
    console.log('[TasksContext] Creating task with data:', taskData);
    return await taskService.createTask(taskData);
  }, [taskService]);

  // Update an existing task
  const updateTask = useCallback(async (id: string, changes: Partial<Task>) => {
    if (!taskService) {
      throw new Error('Task service not available');
    }
    
    console.log('[TasksContext] Updating task with id:', id, 'and changes:', changes);
    return await taskService.updateTask(id, changes);
  }, [taskService]);

  // Delete a task
  const deleteTask = useCallback(async (id: string) => {
    if (!taskService) {
      throw new Error('Task service not available');
    }
    
    console.log('[TasksContext] Deleting task with id:', id);
    return await taskService.deleteTask(id);
  }, [taskService]);

  // Update a task's status
  const updateTaskStatus = useCallback(async (id: string, status: TaskStatus) => {
    if (!taskService) {
      throw new Error('Task service not available');
    }
    
    console.log('[TasksContext] Updating task status with id:', id, 'and status:', status);
    return await taskService.updateTaskStatus(id, status);
  }, [taskService]);

  return (
    <TasksContext.Provider 
      value={{ 
        // UI state
        open, 
        setOpen, 
        currentRow, 
        setCurrentRow,
        
        // Task operations
        createTask,
        updateTask,
        deleteTask,
        updateTaskStatus
      }}
    >
      {children}
    </TasksContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useTasks = () => {
  const tasksContext = React.useContext(TasksContext)

  if (!tasksContext) {
    throw new Error('useTasks has to be used within <TasksContext>')
  }

  return tasksContext
}
