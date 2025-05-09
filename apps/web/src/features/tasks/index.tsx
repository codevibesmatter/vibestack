import React, { useState } from 'react';
import { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "./components/data-table";
import { Checkbox } from "@/components/ui/checkbox";
import { columns as taskColumns } from './components/columns';
import { TasksMutateDrawer } from './components/tasks-mutate-drawer';
import { useTasks as useTasksUI } from './context/tasks-context';
import TasksProvider from './context/tasks-context';
import { Main } from '@/components/layout/main';
import { Header } from '@/components/layout/header';
import { TopNav } from '@/components/layout/top-nav';
import { Button } from '@/components/ui/button';
import { Task } from '@repo/dataforge/client-entities'; // Corrected path
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { TasksDialogs } from './components/tasks-dialogs'
import { TasksPrimaryButtons } from './components/tasks-primary-buttons'
import { SortingState } from '@tanstack/react-table'
// Import the useLiveEntity hook for real-time updates
import { useLiveEntity } from '@/db/hooks/useLiveEntity';
import { usePGliteContext } from '@/db/pglite-provider';
import { useEffect } from 'react';
import { getNewPGliteDataSource } from '@/db/newtypeorm/NewDataSource';
import { SelectQueryBuilder } from 'typeorm';

/**
 * Main Tasks Feature Component
 * Responsible for initializing context and rendering the task display.
 * Uses live queries for real-time updates.
 */
const Tasks: React.FC = () => {
  // State for sorting
  const [sorting, setSorting] = useState<SortingState>([]);
  // State for task query builder
  const [taskQueryBuilder, setTaskQueryBuilder] = useState<SelectQueryBuilder<Task> | null>(null);
  const { services } = usePGliteContext();

  // Initialize the query builder for tasks
  useEffect(() => {
    const initializeQueryBuilder = async () => {
      try {
        // Get a data source connection
        const dataSource = await getNewPGliteDataSource();
        if (!dataSource.isInitialized) {
          await dataSource.initialize();
        }

        // Create a query builder for tasks
        const tasksQB = dataSource.getRepository(Task)
          .createQueryBuilder("task")
          .orderBy("task.updatedAt", "DESC");

        console.log('[Tasks Component] Query builder initialized');
        setTaskQueryBuilder(tasksQB);
      } catch (error) {
        console.error('[Tasks Component] Error initializing query builder:', error);
      }
    };

    initializeQueryBuilder();
  }, []);

  // Use live entity hook to get real-time task updates
  const { 
    data: tasks, 
    loading: isLoading, 
    error 
  } = useLiveEntity<Task>(
    taskQueryBuilder,
    { 
      enabled: !!taskQueryBuilder,
      transform: true // Enable transformation from snake_case to camelCase
    }
  );

  // Log when live data updates
  useEffect(() => {
    if (tasks && tasks.length > 0) {
      console.log('[Tasks Component] Live tasks updated:', tasks.length);
      // Log the first task to verify proper transformation
      console.log('[Tasks Component] First task sample:', tasks[0]);
    }
  }, [tasks]);

  return (
    <TasksProvider>
      <Header fixed>
        <Search />
        <div className='ml-auto flex items-center space-x-4'>
          <ThemeSwitch />
          <ProfileDropdown />
        </div>
      </Header>

      <Main>
        <div className='mb-2 flex flex-wrap items-center justify-between space-y-2 gap-x-4'>
          <div>
            <h2 className='text-2xl font-bold tracking-tight'>Tasks</h2>
            <p className='text-muted-foreground'>
              Here&apos;s a list of your tasks for this month!
            </p>
          </div>
          <TasksPrimaryButtons />
        </div>
        <div className='-mx-4 flex-1 overflow-auto px-4 py-1 lg:flex-row lg:space-y-0 lg:space-x-12'>
          {/* Display loading, error, or data */}
          {isLoading && <p>Loading tasks...</p>}
          {error && <p>Error loading tasks: {error.message}</p>}
          {!isLoading && !error && (
            // Pass sorting state and handler to DataTable
            <DataTable 
              data={(tasks || []).filter(Boolean)} 
              columns={taskColumns} 
              sorting={sorting}
              setSorting={setSorting}
            /> 
          )}
        </div>
      </Main>

      <TasksDialogs />
    </TasksProvider>
  )
}

export default Tasks;
