/**
 * React Hooks for Data Access
 * 
 * This file provides React hooks for interacting with the database.
 */

import { useState, useEffect } from 'react';
import { getDatabase } from './db';
import { usePGliteContext } from './pglite-provider';
import { User, Project, Task, Comment } from '@repo/dataforge/client-entities';
import { getNewPGliteDataSource } from './newtypeorm/NewDataSource';
import { SelectQueryBuilder } from 'typeorm';
import { useLiveEntity } from './hooks/useLiveEntity';

// Define QueryState type if it's not exported from db.ts
interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

/**
 * React hook for executing a SQL query
 */
export function useQuery<T = any>(
  sql: string, 
  params: any[] = [], 
  options?: { enabled?: boolean }
): QueryState<T[]> {
  const [state, setState] = useState<QueryState<T[]>>({
    data: null,
    loading: true,
    error: null
  });
  
  const enabled = options?.enabled !== false;
  
  useEffect(() => {
    if (!sql || !enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    
    let mounted = true;
    
    async function executeQuery() {
      try {
        setState(prev => ({ ...prev, loading: true }));
        
        const db = await getDatabase();
        const results = await db.query(sql, params);
        
        if (mounted) {
          // Handle PGlite results type correctly
          const formattedResults = Array.isArray(results) 
            ? results as unknown as T[] 
            : ([] as T[]);
          
          setState({
            data: formattedResults,
            loading: false,
            error: null
          });
        }
      } catch (error) {
        console.error('Error executing query:', error);
        
        if (mounted) {
          setState({
            data: null,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error))
          });
        }
      }
    }
    
    executeQuery();
    
    return () => {
      mounted = false;
    };
  }, [sql, JSON.stringify(params), enabled]);
  
  return state;
}

/**
 * React hook for executing a mutation query (INSERT, UPDATE, DELETE)
 */
export function useMutation<T = any>(
  sql?: string
): [
  (params?: any[]) => Promise<T[]>,
  { loading: boolean; error: Error | null; data: T[] | null }
] {
  const [state, setState] = useState<{
    loading: boolean;
    error: Error | null;
    data: T[] | null;
  }>({
    loading: false,
    error: null,
    data: null
  });
  
  const executeMutation = async (params: any[] = []) => {
    try {
      setState(prev => ({ ...prev, loading: true }));
      
      const db = await getDatabase();
      const result = await db.query(sql || '', params);
      
      // Handle PGlite results type correctly
      const formattedResults = Array.isArray(result) 
        ? result as unknown as T[] 
        : ([] as T[]);
      
      setState({
        loading: false,
        error: null,
        data: formattedResults
      });
      
      return formattedResults;
    } catch (error) {
      console.error('Error executing mutation:', error);
      
      const errorObj = error instanceof Error 
        ? error 
        : new Error(String(error));
      
      setState({
        loading: false,
        error: errorObj,
        data: null
      });
      
      throw errorObj;
    }
  };
  
  return [executeMutation, state];
}

/**
 * Simplistic live query implementation
 * Note: This is a basic implementation that doesn't actually
 * use server-sent events or websockets. It polls for changes.
 */
export function useLive<T = any>(
  sql: string,
  params: any[] = [],
  options?: { pollingInterval?: number; enabled?: boolean }
): QueryState<T[]> {
  const [state, setState] = useState<QueryState<T[]>>({
    data: null,
    loading: true,
    error: null
  });
  
  const pollingInterval = options?.pollingInterval || 2000;
  const enabled = options?.enabled !== false;
  
  useEffect(() => {
    if (!sql || !enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    
    let mounted = true;
    let intervalId: NodeJS.Timeout;
    
    async function executeLiveQuery() {
      try {
        if (!mounted) return;
        
        setState(prev => ({ ...prev, loading: true }));
        
        const db = await getDatabase();
        
        // If db.live exists and has a query method, use it
        if (db.live?.query) {
          try {
            const { results } = await db.live.query(sql, params);
            
            if (mounted) {
              // Handle PGlite results type correctly
              const formattedResults = Array.isArray(results) 
                ? results as unknown as T[] 
                : ([] as T[]);
              
              setState({
                data: formattedResults,
                loading: false,
                error: null
              });
            }
          } catch (error) {
            console.error('Error executing live query:', error);
            // Fallback to regular query if live query fails
            const results = await db.query(sql, params);
            
            if (mounted) {
              // Handle PGlite results type correctly
              const formattedResults = Array.isArray(results) 
                ? results as unknown as T[] 
                : ([] as T[]);
              
              setState({
                data: formattedResults,
                loading: false,
                error: null
              });
            }
          }
        } else {
          // Fallback to regular query
          const results = await db.query(sql, params);
          
          if (mounted) {
            // Handle PGlite results type correctly
            const formattedResults = Array.isArray(results) 
              ? results as unknown as T[] 
              : ([] as T[]);
            
            setState({
              data: formattedResults,
              loading: false,
              error: null
            });
          }
        }
      } catch (error) {
        console.error('Error in live query:', error);
        
        if (mounted) {
          setState({
            data: null,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error))
          });
        }
      }
    }
    
    // Execute immediately
    executeLiveQuery();
    
    // Set up polling interval
    intervalId = setInterval(executeLiveQuery, pollingInterval);
    
    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [sql, JSON.stringify(params), pollingInterval, enabled]);
  
  return state;
}

/**
 * React hooks for the new service layer
 */

/**
 * Hook for accessing users
 */
export function useUsers() {
  const { services, isLoading, error } = usePGliteContext();
  const [users, setUsers] = useState<User[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [userError, setUserError] = useState<Error | null>(null);

  useEffect(() => {
    // Skip if services aren't ready yet
    if (isLoading || !services?.users) return;

    let mounted = true;

    async function loadUsers() {
      try {
        setIsLoadingUsers(true);
        const allUsers = await services.users.getAll();
        
        if (mounted) {
          setUsers(allUsers);
          setIsLoadingUsers(false);
        }
      } catch (err) {
        console.error('Error loading users:', err);
        
        if (mounted) {
          setUserError(err instanceof Error ? err : new Error(String(err)));
          setIsLoadingUsers(false);
        }
      }
    }

    loadUsers();

    return () => {
      mounted = false;
    };
  }, [services, isLoading]);

  async function createUser(userData: { name: string; email: string }) {
    if (!services?.users) {
      throw new Error('User service not available');
    }
    
    try {
      const newUser = await services.users.createUser(userData);
      setUsers((prevUsers) => [...prevUsers, newUser]);
      return newUser;
    } catch (err) {
      console.error('Error creating user:', err);
      throw err;
    }
  }

  async function updateUser(id: string, changes: Partial<User>) {
    if (!services?.users) {
      throw new Error('User service not available');
    }
    
    try {
      const updatedUser = await services.users.updateUser(id, changes);
      setUsers((prevUsers) => 
        prevUsers.map((user) => (user.id === id ? updatedUser : user))
      );
      return updatedUser;
    } catch (err) {
      console.error('Error updating user:', err);
      throw err;
    }
  }

  async function deleteUser(id: string) {
    if (!services?.users) {
      throw new Error('User service not available');
    }
    
    try {
      const success = await services.users.deleteUser(id);
      if (success) {
        setUsers((prevUsers) => prevUsers.filter((user) => user.id !== id));
      }
      return success;
    } catch (err) {
      console.error('Error deleting user:', err);
      throw err;
    }
  }

  return {
    users,
    isLoading: isLoadingUsers,
    error: userError || error,
    createUser,
    updateUser,
    deleteUser
  };
}

/**
 * Hook for accessing projects
 */
export function useProjects() {
  const { services, isLoading, error } = usePGliteContext();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [projectError, setProjectError] = useState<Error | null>(null);
  
  // Effect to load projects and set up live query subscription
  useEffect(() => {
    if (isLoading || !services?.projects) return;
    
    let mounted = true;
    let unsubscribe: (() => Promise<void>) | undefined;
    
    async function setupLiveQuery() {
      try {
        // Initial load using the service
        setIsLoadingProjects(true);
        console.log('[useProjects] Initial fetch using project service');
        const allProjects = await services.projects.getAll();
        
        if (mounted) {
          console.log('[useProjects] Projects loaded:', allProjects.length);
          setProjects(allProjects);
          setIsLoadingProjects(false);
        }
        
        // Set up live query to detect changes
        const db = await getDatabase();
        if (!db.live?.query) {
          console.warn('[useProjects] Live query not available, changes will only be seen on reload');
          return;
        }
        
        console.log('[useProjects] Setting up live query for projects table');
        const liveQueryResult = await db.live.query(
          'SELECT * FROM projects ORDER BY updated_at DESC',
          [],
          async (results: { rows: any[] }) => {
            console.log('[useProjects] Live query update detected, refreshing projects');
            // When changes are detected, use the service to get the updated list
            // This ensures proper entity mapping
            if (mounted && services?.projects) {
              try {
                const refreshedProjects = await services.projects.getAll();
                console.log('[useProjects] Refreshed projects from service:', refreshedProjects.length);
                setProjects(refreshedProjects);
              } catch (refreshError) {
                console.error('[useProjects] Error refreshing projects:', refreshError);
              }
            }
          }
        );
        
        unsubscribe = liveQueryResult.unsubscribe;
        console.log('[useProjects] Live query subscription set up successfully');
      } catch (err) {
        console.error('[useProjects] Error setting up projects and live query:', err);
        
        if (mounted) {
          setProjectError(err instanceof Error ? err : new Error(String(err)));
          setIsLoadingProjects(false);
        }
      }
    }
    
    setupLiveQuery();
    
    return () => {
      mounted = false;
      if (unsubscribe) {
        console.log('[useProjects] Unsubscribing from live query');
        unsubscribe().catch(err => 
          console.error('[useProjects] Error unsubscribing from live query:', err)
        );
      }
    };
  }, [services, isLoading]);

  async function createProject(projectData: { name: string; description?: string; ownerId?: string }) {
    if (!services?.projects) {
      throw new Error('Project service not available');
    }
    
    try {
      const newProject = await services.projects.createProject(projectData);
      // Update local state immediately to avoid waiting for live query
      setProjects(prev => [...prev, newProject]);
      console.log('[useProjects] Created project:', newProject.id);
      return newProject;
    } catch (err) {
      console.error('[useProjects] Error creating project:', err);
      throw err;
    }
  }

  async function updateProject(id: string, changes: Partial<Project>) {
    if (!services?.projects) {
      throw new Error('Project service not available');
    }
    
    try {
      const updatedProject = await services.projects.updateProject(id, changes);
      // Update local state immediately to avoid waiting for live query
      setProjects(prev => prev.map(p => p.id === id ? updatedProject : p));
      console.log('[useProjects] Updated project:', updatedProject.id);
      return updatedProject;
    } catch (err) {
      console.error('[useProjects] Error updating project:', err);
      throw err;
    }
  }

  async function deleteProject(id: string) {
    if (!services?.projects) {
      throw new Error('Project service not available');
    }
    
    try {
      const success = await services.projects.deleteProject(id);
      if (success) {
        // Update local state immediately to avoid waiting for live query
        setProjects(prev => prev.filter(p => p.id !== id));
      }
      console.log('[useProjects] Deleted project:', id, success);
      return success;
    } catch (err) {
      console.error('[useProjects] Error deleting project:', err);
      throw err;
    }
  }

  return {
    projects,
    isLoading: isLoadingProjects || isLoading,
    error: projectError || error,
    createProject,
    updateProject,
    deleteProject
  };
}

/**
 * Hook for accessing tasks
 */
export function useTasks(projectId?: string) {
  const { services, isLoading, error } = usePGliteContext();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(true);
  const [taskError, setTaskError] = useState<Error | null>(null);

  useEffect(() => {
    // Skip if services aren't ready yet
    if (isLoading || !services?.tasks) return;

    let mounted = true;

    async function loadTasks() {
      try {
        setIsLoadingTasks(true);
        let tasksData: Task[];
        
        if (projectId) {
          tasksData = await services.tasks.getByProject(projectId);
        } else {
          tasksData = await services.tasks.getAll();
        }
        
        if (mounted) {
          setTasks(tasksData);
          setIsLoadingTasks(false);
        }
      } catch (err) {
        console.error('Error loading tasks:', err);
        
        if (mounted) {
          setTaskError(err instanceof Error ? err : new Error(String(err)));
          setIsLoadingTasks(false);
        }
      }
    }

    loadTasks();

    return () => {
      mounted = false;
    };
  }, [services, isLoading, projectId]);

  async function createTask(taskData: {
    title: string;
    projectId: string;
    description?: string;
    status?: any;
    priority?: any;
    assigneeId?: string;
    dueDate?: Date;
    timeRange?: [Date, Date];
    estimatedDuration?: number;
    tags?: string[];
  }) {
    if (!services?.tasks) {
      throw new Error('Task service not available');
    }
    
    try {
      const newTask = await services.tasks.createTask(taskData);
      
      // Only update state if no projectId filter or task matches the filter
      if (!projectId || newTask.projectId === projectId) {
        setTasks((prevTasks) => [...prevTasks, newTask]);
      }
      
      return newTask;
    } catch (err) {
      console.error('Error creating task:', err);
      throw err;
    }
  }

  async function updateTask(id: string, changes: Partial<Task>) {
    if (!services?.tasks) {
      throw new Error('Task service not available');
    }
    
    try {
      const updatedTask = await services.tasks.updateTask(id, changes);
      
      // Only update state if task still matches any projectId filter
      if (!projectId || updatedTask.projectId === projectId) {
        setTasks((prevTasks) => 
          prevTasks.map((task) => (task.id === id ? updatedTask : task))
        );
      } else {
        // Remove task from state if it no longer matches the filter
        setTasks((prevTasks) => prevTasks.filter((task) => task.id !== id));
      }
      
      return updatedTask;
    } catch (err) {
      console.error('Error updating task:', err);
      throw err;
    }
  }

  async function deleteTask(id: string) {
    if (!services?.tasks) {
      throw new Error('Task service not available');
    }
    
    try {
      const success = await services.tasks.deleteTask(id);
      if (success) {
        setTasks((prevTasks) => prevTasks.filter((task) => task.id !== id));
      }
      return success;
    } catch (err) {
      console.error('Error deleting task:', err);
      throw err;
    }
  }

  async function updateTaskStatus(id: string, status: any) {
    if (!services?.tasks) {
      throw new Error('Task service not available');
    }
    
    try {
      const updatedTask = await services.tasks.updateTaskStatus(id, status);
      
      // Only update state if task still matches any projectId filter
      if (!projectId || updatedTask.projectId === projectId) {
        setTasks((prevTasks) => 
          prevTasks.map((task) => (task.id === id ? updatedTask : task))
        );
      } else {
        // Remove task from state if it no longer matches the filter
        setTasks((prevTasks) => prevTasks.filter((task) => task.id !== id));
      }
      
      return updatedTask;
    } catch (err) {
      console.error('Error updating task status:', err);
      throw err;
    }
  }

  return {
    tasks,
    isLoading: isLoadingTasks,
    error: taskError || error,
    createTask,
    updateTask,
    deleteTask,
    updateTaskStatus
  };
}

/**
 * Hook for accessing comments
 */
export function useComments(taskId?: string) {
  const { services, isLoading, error } = usePGliteContext();
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoadingComments, setIsLoadingComments] = useState(true);
  const [commentError, setCommentError] = useState<Error | null>(null);

  useEffect(() => {
    // Skip if services aren't ready yet or no taskId provided
    if (isLoading || !services?.comments || !taskId) return;

    let mounted = true;

    async function loadComments() {
      try {
        setIsLoadingComments(true);
        const commentsData = await services.comments.getByTask(taskId);
        
        if (mounted) {
          setComments(commentsData);
          setIsLoadingComments(false);
        }
      } catch (err) {
        console.error('Error loading comments:', err);
        
        if (mounted) {
          setCommentError(err instanceof Error ? err : new Error(String(err)));
          setIsLoadingComments(false);
        }
      }
    }

    loadComments();

    return () => {
      mounted = false;
    };
  }, [services, isLoading, taskId]);

  async function createComment(commentData: {
    content: string;
    taskId: string;
    authorId: string;
    parentId?: string;
  }) {
    if (!services?.comments) {
      throw new Error('Comment service not available');
    }
    
    try {
      const newComment = await services.comments.createComment(commentData);
      
      // Only update state if matches taskId filter
      if (!taskId || newComment.taskId === taskId) {
        setComments((prevComments) => [...prevComments, newComment]);
      }
      
      return newComment;
    } catch (err) {
      console.error('Error creating comment:', err);
      throw err;
    }
  }

  async function updateComment(id: string, changes: Partial<Comment>) {
    if (!services?.comments) {
      throw new Error('Comment service not available');
    }
    
    try {
      const updatedComment = await services.comments.updateComment(id, changes);
      
      // Only update state if comment still matches taskId filter
      if (!taskId || updatedComment.taskId === taskId) {
        setComments((prevComments) => 
          prevComments.map((comment) => (comment.id === id ? updatedComment : comment))
        );
      } else {
        // Remove comment from state if it no longer matches the filter
        setComments((prevComments) => prevComments.filter((comment) => comment.id !== id));
      }
      
      return updatedComment;
    } catch (err) {
      console.error('Error updating comment:', err);
      throw err;
    }
  }

  async function deleteComment(id: string) {
    if (!services?.comments) {
      throw new Error('Comment service not available');
    }
    
    try {
      const success = await services.comments.deleteComment(id);
      if (success) {
        setComments((prevComments) => prevComments.filter((comment) => comment.id !== id));
      }
      return success;
    } catch (err) {
      console.error('Error deleting comment:', err);
      throw err;
    }
  }

  return {
    comments,
    isLoading: isLoadingComments,
    error: commentError || error,
    createComment,
    updateComment,
    deleteComment
  };
} 