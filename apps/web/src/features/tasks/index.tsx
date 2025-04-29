import React, { useState, useEffect } from 'react';
import { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "./components/data-table";
import { Checkbox } from "@/components/ui/checkbox";
import { columns as taskColumns } from './components/columns';
import { TasksMutateDrawer } from './components/tasks-mutate-drawer';
import { useTasks } from './context/tasks-context';
import TasksProvider from './context/tasks-context';
import { Main } from '@/components/layout/main';
import { Header } from '@/components/layout/header';
import { TopNav } from '@/components/layout/top-nav';
import { Button } from '@/components/ui/button';
import { clientEntities, Task } from '@repo/dataforge/client-entities'; // Corrected path
import { getNewPGliteDataSource, NewPGliteDataSource } from '@/db/newtypeorm/NewDataSource';
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { TasksDialogs } from './components/tasks-dialogs'
import { TasksPrimaryButtons } from './components/tasks-primary-buttons'
import { SortingState } from '@tanstack/react-table'
import { useLiveEntity } from '@/db/hooks/useLiveEntity'
import { SelectQueryBuilder } from 'typeorm'

/**
 * Main Tasks Feature Component
 * Responsible for initializing context and rendering the task display.
 */
const Tasks: React.FC = () => {
  // HMR test comment
  const [dataSourceReady, setDataSourceReady] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // State for DataSource and the QueryBuilder
  const [dataSource, setDataSource] = useState<NewPGliteDataSource | null>(null);
  const [queryBuilder, setQueryBuilder] = useState<SelectQueryBuilder<Task> | null>(null);
  // Add state for sorting
  const [sorting, setSorting] = useState<SortingState>([]);
  
  // Remove state variables that will be replaced by the hook's return value
  // const [tasksData, setTasksData] = useState<Task[]>([]);
  // const [isLoading, setIsLoading] = useState(true);
  // const [error, setError] = useState<Error | null>(null);

  // Effect to initialize DataSource
  useEffect(() => {
    // setIsLoading(true); // Loading state managed by hook
    // setError(null); // Error state managed by hook
    const initDataSource = async () => {
      try {
        const ds = await getNewPGliteDataSource({
          database: 'shadadmin_db',
          synchronize: false,
          logging: true, // Keep logging for now
          entities: clientEntities,
        });
        setDataSource(ds);
        console.log("Tasks component: DataSource Initialized.");
      } catch (err) {
        console.error('Tasks component: Error initializing DataSource:', err);
        // If DS fails to init, maybe set an error state for the whole component?
        // For now, the hook will handle its own error state if QB is null
      }
    };
    initDataSource();
  }, []);

  // Effect to create QueryBuilder when DataSource is ready
  useEffect(() => {
    if (dataSource) {
      console.log("Tasks component: Creating QueryBuilder for tasks..."); 
      const taskRepo = dataSource.getRepository(Task);
      const qb = taskRepo.createQueryBuilder("task")
        // Explicitly select necessary database columns
        .select([
          "task.id",
          "task.title",
          "task.status",
          "task.priority",
          "task.created_at", // Include for sorting/filtering if needed
          "task.updated_at"
        ]); 
        
      setQueryBuilder(qb);
    } else {
      setQueryBuilder(null); // Clear QB if dataSource is not available
    }
  }, [dataSource]);

  // Use the live entity hook with the query builder
  const { data: liveTasks, loading: liveLoading, error: liveError } = useLiveEntity<Task>(
    queryBuilder, // Pass the stateful query builder
    { enabled: !!queryBuilder } // Only enable when QB is ready
  );

  // Remove the manual fetching useEffect
  /*
  useEffect(() => {
    if (!dataSource) return; 
    const fetchTasks = async () => { ... };
    fetchTasks();
  }, [dataSource]);
  */

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
          {/* Use loading/error state from the hook */}
          {liveLoading && <p>Loading tasks...</p>}
          {liveError && <p>Error loading tasks: {liveError.message}</p>}
          {!liveLoading && !liveError && (
            // Pass sorting state and handler to DataTable
            <DataTable 
              data={(liveTasks || []).filter(Boolean)} 
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
