import React, { Suspense, useMemo } from 'react' // Removed useState
import { CellContext, ColumnDef } from '@tanstack/react-table' // Removed SortingState
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  EditableTextCell,
  EditableSelectCell,
  EditableDateCell,
  // EditableCheckboxCell, // Not used in current columns
  // ProjectCell, // Not used directly
  EditableProjectCell, // Still used, but will need rework due to cache removal
  EditableUserCell,   // Still used, but will need rework due to cache removal
} from '@/components/data-table/data-table-cells'
import { usePGliteContext } from '@/db/pglite-provider'
// import { Badge } from '@/components/ui/badge' // Not used
import { Task, TaskStatus, TaskPriority } from '@repo/dataforge/client-entities'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { SearchProvider } from '@/context/search-context'
import { DebugNavigation } from './components/DebugNavigation'
import { format } from 'date-fns'
import { DataTableProvider } from '@/components/data-table/data-table-provider'
import { DataTableErrorBoundary } from '@/components/data-table/data-table-error' // DataTableError removed as EntityDataTable handles it
import { pluginRegistry } from '@/components/data-table/data-table-plugins'
import { DataTableSkeleton } from '@/components/ui/table-skeleton'
import { RepositoryDataTable } from '@/components/data-table/data-table-entity' // Changed to RepositoryDataTable

// Register plugins for Task-specific cell renderers
pluginRegistry.registerCellPlugin({
  id: 'task-status-cell',
  name: 'Task Status Cell',
  canHandle: (context) =>
    context.column.id === 'status' &&
    typeof context.getValue() === 'string',
  render: (context) => {
    const options = Object.values(TaskStatus).map(status => ({
      label: status,
      value: status
    }))
    return <EditableSelectCell {...context} options={options} />
  }
})

pluginRegistry.registerCellPlugin({
  id: 'task-priority-cell',
  name: 'Task Priority Cell',
  canHandle: (context) =>
    context.column.id === 'priority' &&
    typeof context.getValue() === 'string',
  render: (context) => {
    const options = Object.values(TaskPriority).map(priority => ({
      label: priority,
      value: priority
    }))
    return <EditableSelectCell {...context} options={options} />
  }
})

function DataTableDebugPanel() {
  // const [sorting, setSorting] = useState<SortingState>([]) // Removed, RepositoryDataTable handles its own sorting state
  const { services, isLoading: servicesLoading, repositories } = usePGliteContext()

  const ormTaskRepository = useMemo(() => {
    if (repositories?.tasks) {
      // Ensure getOrmRepository is callable
      if (typeof (repositories.tasks as any).getOrmRepository === 'function') {
        return (repositories.tasks as any).getOrmRepository();
      }
      console.warn("[DataTablePage] repositories.tasks.getOrmRepository is not a function");
    }
    return undefined;
  }, [repositories]);
  
  // Define columns with all available task fields
  // Note: EditableProjectCell and EditableUserCell will require rework
  // as globalEntityCache has been removed.
  const columns = useMemo<ColumnDef<Task, any>[]>(() => [
    {
      accessorKey: 'id',
      header: 'ID',
      enableSorting: true,
      enableHiding: true,
    },
    {
      accessorKey: 'title',
      header: 'Title',
      enableHiding: false, // Don't allow hiding the title
      cell: (props: CellContext<Task, string>) => <EditableTextCell {...props} />,
    },
    {
      accessorKey: 'description',
      header: 'Description',
      enableHiding: true,
      cell: (props: CellContext<Task, string>) => <EditableTextCell {...props} />,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      enableHiding: true,
      cell: (props: CellContext<Task, TaskStatus>) => (
        <EditableSelectCell
          {...props}
          options={Object.values(TaskStatus).map(status => ({
            label: status,
            value: status
          }))}
        />
      ),
    },
    {
      accessorKey: 'priority',
      header: 'Priority',
      enableHiding: true,
      cell: (props: CellContext<Task, TaskPriority>) => (
        <EditableSelectCell
          {...props}
          options={Object.values(TaskPriority).map(priority => ({
            label: priority,
            value: priority
          }))}
        />
      ),
    },
    {
      accessorKey: 'dueDate',
      header: 'Due Date',
      enableHiding: true,
      cell: (props: CellContext<Task, Date>) => <EditableDateCell {...props} />,
    },
    {
      accessorKey: 'completedAt',
      header: 'Completed At',
      enableHiding: true,
      cell: ({ getValue }: CellContext<Task, Date | null>) => {
        const date = getValue()
        return date ? format(date, 'PPP p') : '-'
      },
    },
    {
      accessorKey: 'projectId',
      header: 'Project',
      enableHiding: true,
      // This cell will likely not work correctly until EntityDataTable's relationship handling
      // is configured or the cell is adapted.
      cell: (props: CellContext<Task, string>) => <EditableProjectCell {...props} />,
    },
    {
      accessorKey: 'assigneeId',
      header: 'Assignee',
      enableHiding: true,
      // This cell will likely not work correctly until EntityDataTable's relationship handling
      // is configured or the cell is adapted.
      cell: (props: CellContext<Task, string>) => <EditableUserCell {...props} />,
    },
    {
      accessorKey: 'tags',
      header: 'Tags',
      enableHiding: true,
      cell: ({ getValue }: CellContext<Task, string[]>) => {
        const tags = getValue()
        return tags && tags.length > 0 ? tags.join(', ') : '-'
      },
    },
    {
      accessorKey: 'createdAt',
      header: 'Created At',
      enableHiding: true,
      cell: ({ getValue }: CellContext<Task, Date>) => {
        const date = getValue()
        return date ? format(date, 'PPP p') : '-'
      },
    },
    {
      accessorKey: 'updatedAt',
      header: 'Updated At',
      enableHiding: true,
      cell: ({ getValue }: CellContext<Task, Date>) => {
        const date = getValue()
        return date ? format(date, 'PPP p') : '-'
      },
    },
  ], [])

  // Show skeleton while PGlite services are loading or if the ormTaskRepository isn't ready
  if (servicesLoading || !ormTaskRepository) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            Tasks with Editable Cells
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <DataTableSkeleton />
            <div className="text-xs text-muted-foreground">
              {servicesLoading ? "Loading database services..." :
               !repositories ? "Initializing repositories..." :
               !repositories.tasks ? "Initializing task repository..." :
               !ormTaskRepository ? "Obtaining ORM task repository..." :
               "Loading tasks..."}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }
  
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            Tasks with Editable Cells
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RepositoryDataTable<Task>
            tableId="debug-tasks-table"
            entityType="Task"
            repository={ormTaskRepository}
            customColumns={columns}
            title=""
            showCard={false}
            tableConfig={{
              pageSize: 10,
              enableSorting: true,
              showColumnVisibility: true,
              enablePagination: true,
            }}
            additionalTableProps={{
              columnVisibilityButtonClassName:"ml-auto",
            }}
            customEditableColumns={['title', 'description', 'status', 'priority', 'dueDate', 'projectId', 'assigneeId']} // ADDED
            // onEntityUpdated, onEntityDeleted, onEntityCreated can be added if needed
            relatedServices={ services?.projects && services?.users ? {
                project: services.projects, // Assuming services.projects is the service for Project entities
                user: services.users        // Assuming services.users is the service for User entities
              } : {} }
            // typeormOptions would be needed to configure how 'project' and 'user' relationships are handled
            // e.g. typeormOptions={{ relationshipConfigs: { projectId: { serviceKey: 'project', displayField: 'name' }, assigneeId: { serviceKey: 'user', displayField: 'name' } } }}
          />
        </CardContent>
      </Card>
    </>
  )
}

export default function DataTablePage() {
  return (
    <SearchProvider>
      <Header fixed>
        <Search />
        <div className='ml-auto flex items-center space-x-4'>
          <ThemeSwitch />
          <ProfileDropdown />
        </div>
      </Header>
      <Main>
        <div className="mb-2 flex items-center justify-between space-y-2">
          <h1 className='text-2xl font-bold tracking-tight'>DataTable Debug</h1>
        </div>
        
        <DataTableProvider
          initialConfig={{
            defaultPageSize: 10,
            cacheExpiryTime: 5 * 60 * 1000, // 5 minutes
            retryOnError: true,
            maxRetryAttempts: 3
          }}
        >
          <DataTableErrorBoundary>
          <Suspense fallback={<div>Loading data table debug panel...</div>}>
            <DataTableDebugPanel />
          </Suspense>
          </DataTableErrorBoundary>
        </DataTableProvider>
        
        <DebugNavigation />
      </Main>
    </SearchProvider>
  )
} 