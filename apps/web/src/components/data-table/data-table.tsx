import * as React from 'react'
import {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  VisibilityState,
  OnChangeFn,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  Table as TableInstance,
  RowData,
  PaginationState,
  ColumnOrderState, // ADDED for future use
  ColumnSizingState, // ADDED for future use
} from '@tanstack/react-table'
import { useDataTableUiStore } from '../../stores/dataTableUiStore' // FIXED PATH
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { 
  ChevronLeftIcon, 
  ChevronRightIcon, 
  DoubleArrowLeftIcon, 
  DoubleArrowRightIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CaretSortIcon,
} from '@radix-ui/react-icons'
import { DataTableColumns } from './data-table-columns'

export interface DataTableProps<TData extends RowData, TValue> {
  tableId: string; // ADDED: Required
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  
  // Optional initial state props
  defaultSorting?: SortingState; // ADDED
  defaultColumnVisibility?: VisibilityState; // ADDED
  defaultColumnFilters?: ColumnFiltersState; // ADDED
  defaultColumnOrder?: ColumnOrderState; // ADDED
  defaultColumnSizing?: ColumnSizingState; // ADDED
  initialDefaultPagination?: PaginationState; // RENAMED from defaultPagination

  // Direct state control (optional, overrides defaults if provided)
  sorting?: SortingState // Ensured optional
  setSorting?: OnChangeFn<SortingState> // Ensured optional (parent notification, not primary control)
  // columnVisibility?: VisibilityState; // No longer a direct prop, managed internally
  // onColumnVisibilityChange?: OnChangeFn<VisibilityState>; // No longer a direct prop
  
  // Editing-related props
  onUpdate?: (rowId: string, columnId: string, value: any) => Promise<void>
  isLoading?: boolean
  editableColumns?: string[]
  getRowId?: (row: TData) => string
  // Column visibility props
  showColumnVisibility?: boolean
  columnVisibilityButtonClassName?: string
  // Optional custom components
  pagination?: React.ReactNode
  toolbar?: React.ReactNode
  emptyState?: React.ReactNode
  // Data loading state
  tableReady?: boolean
  // Pagination props
  enablePagination?: boolean
  pageSize?: number
  pageSizeOptions?: number[]
  // Sorting props
  enableSorting?: boolean
}

export function DataTable<TData extends RowData, TValue>({
  tableId, // ADDED
  columns,
  data,
  defaultSorting, // ADDED
  defaultColumnVisibility, // ADDED
  defaultColumnFilters, // ADDED
  defaultColumnOrder, // ADDED
  defaultColumnSizing, // ADDED
  initialDefaultPagination, // RENAMED from defaultPagination
  sorting: propsSorting, // RENAMED from sorting, default [] removed
  onUpdate,
  isLoading = false,
  editableColumns = [],
  getRowId = (row: any) => row.id || '',
  showColumnVisibility = false,
  columnVisibilityButtonClassName,
  pagination: customPagination,
  toolbar,
  emptyState,
  tableReady = false,
  enablePagination = false,
  pageSize: initialPageSizeProp = 10, // RENAMED from pageSize
  pageSizeOptions = [5, 10, 20, 50, 100],
  enableSorting = true,
}: DataTableProps<TData, TValue>) {
  if (!tableId) {
    throw new Error('DataTable: tableId prop is required.');
  }

  const { getUiState, setUiState } = useDataTableUiStore();
  const persistedState = getUiState(tableId);

  // Initialize sorting state
  const initialSorting = persistedState?.sorting ?? defaultSorting ?? propsSorting ?? [];
  const [currentSorting, setCurrentSorting] = React.useState<SortingState>(initialSorting);

  // Initialize column visibility state
  const initialColumnVisibility = persistedState?.columnVisibility ?? defaultColumnVisibility ?? {};
  const [currentColumnVisibility, setCurrentColumnVisibility] = React.useState<VisibilityState>(initialColumnVisibility);

  // Initialize column filters state
  const initialColumnFilters = persistedState?.columnFilters ?? defaultColumnFilters ?? [];
  const [currentColumnFilters, setCurrentColumnFilters] = React.useState<ColumnFiltersState>(initialColumnFilters);
  
  // Initialize column order state
  const initialColumnOrder = persistedState?.columnOrder ?? defaultColumnOrder ?? [];
  const [currentColumnOrder, setCurrentColumnOrder] = React.useState<ColumnOrderState>(initialColumnOrder);

  // Initialize column sizing state
  const initialColumnSizing = persistedState?.columnSizing ?? defaultColumnSizing ?? {};
  const [currentColumnSizing, setCurrentColumnSizing] = React.useState<ColumnSizingState>(initialColumnSizing);
  
  const [rowSelection, setRowSelection] = React.useState({})

  // Initialize pagination state
  const initialPaginationState = persistedState?.pagination ?? initialDefaultPagination ?? { // UPDATED to use renamed prop
    pageIndex: 0,
    pageSize: initialPageSizeProp,
  };
  const [{ pageIndex, pageSize: currentPageSize }, setPagination] = React.useState<PaginationState>(initialPaginationState);

  // Memoize pagination settings to avoid unnecessary rerenders
  const pagination = React.useMemo(
    () => ({
      pageIndex,
      pageSize: currentPageSize,
    }),
    [pageIndex, currentPageSize]
  )

  // Create a table instance with meta data for editing
  const table = useReactTable({
    data,
    columns,
    state: {
      sorting: currentSorting,
      columnVisibility: currentColumnVisibility, // UPDATED
      rowSelection,
      columnFilters: currentColumnFilters, // UPDATED
      columnOrder: currentColumnOrder, // ADDED
      columnSizing: currentColumnSizing, // ADDED
      ...(enablePagination && { pagination }),
    },
    meta: {
      onUpdate,
      editableColumns,
      tableReady,
    },
    enableRowSelection: true,
    enableSorting,
    enableColumnResizing: true, // ADDED - Or make this a prop / conditional
    onRowSelectionChange: setRowSelection,
    onSortingChange: setCurrentSorting,
    onColumnFiltersChange: setCurrentColumnFilters, // UPDATED
    onColumnVisibilityChange: setCurrentColumnVisibility, // UPDATED
    onColumnOrderChange: setCurrentColumnOrder, // ADDED
    onColumnSizingChange: setCurrentColumnSizing, // ADDED
    ...(enablePagination && { onPaginationChange: setPagination }),
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    ...(enablePagination && { getPaginationRowModel: getPaginationRowModel() }),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getRowId: (row) => getRowId(row),
  })

  // Persist sorting state
  React.useEffect(() => {
    const newSortingState = table.getState().sorting;
    if (newSortingState !== undefined) {
      // Avoid saving if it's the same as what's already persisted for this aspect,
      // or if it's the initial default empty array and nothing meaningful has been set.
      // For now, a direct save as per example, but deep comparison could be added.
      if (JSON.stringify(newSortingState) !== JSON.stringify(persistedState?.sorting ?? [])) {
         setUiState(tableId, { sorting: newSortingState });
      }
    }
  }, [table.getState().sorting, tableId, setUiState, persistedState?.sorting]);

  // Persist column visibility state
  React.useEffect(() => {
    const newColumnVisibilityState = table.getState().columnVisibility;
    if (newColumnVisibilityState !== undefined) {
      if (JSON.stringify(newColumnVisibilityState) !== JSON.stringify(persistedState?.columnVisibility ?? {})) {
        setUiState(tableId, { columnVisibility: newColumnVisibilityState });
      }
    }
  }, [table.getState().columnVisibility, tableId, setUiState, persistedState?.columnVisibility]);

  // Persist column order state
  React.useEffect(() => {
    const newColumnOrderState = table.getState().columnOrder;
    if (newColumnOrderState !== undefined) {
      if (JSON.stringify(newColumnOrderState) !== JSON.stringify(persistedState?.columnOrder ?? [])) {
        setUiState(tableId, { columnOrder: newColumnOrderState });
      }
    }
  }, [table.getState().columnOrder, tableId, setUiState, persistedState?.columnOrder]);

  // Persist column sizing state
  React.useEffect(() => {
    const newColumnSizingState = table.getState().columnSizing;
    // Check if newColumnSizingState is not empty, as it defaults to {}
    // and we only want to save if it has actual sizing info or differs from persisted.
    if (newColumnSizingState !== undefined && Object.keys(newColumnSizingState).length > 0) {
      if (JSON.stringify(newColumnSizingState) !== JSON.stringify(persistedState?.columnSizing ?? {})) {
        setUiState(tableId, { columnSizing: newColumnSizingState });
      }
    } else if (newColumnSizingState !== undefined && Object.keys(newColumnSizingState).length === 0 && persistedState?.columnSizing && Object.keys(persistedState.columnSizing).length > 0) {
      // If new state is empty but persisted state had values, clear it
      setUiState(tableId, { columnSizing: {} });
    }
  }, [table.getState().columnSizing, tableId, setUiState, persistedState?.columnSizing]);
  
  // Persist column filters state
  React.useEffect(() => {
    const newColumnFiltersState = table.getState().columnFilters;
    if (newColumnFiltersState !== undefined) {
      if (JSON.stringify(newColumnFiltersState) !== JSON.stringify(persistedState?.columnFilters ?? [])) {
        setUiState(tableId, { columnFilters: newColumnFiltersState });
      }
    }
  }, [table.getState().columnFilters, tableId, setUiState, persistedState?.columnFilters]);

  // Persist pagination state
  React.useEffect(() => {
    const newPaginationState = table.getState().pagination;
    if (newPaginationState !== undefined) {
      // Ensure we have valid pageIndex and pageSize
      const validNewPaginationState = {
        pageIndex: newPaginationState.pageIndex ?? 0,
        pageSize: newPaginationState.pageSize ?? initialPageSizeProp,
      };
      const persistedPagination = persistedState?.pagination ?? { pageIndex: 0, pageSize: initialPageSizeProp };
      
      if (JSON.stringify(validNewPaginationState) !== JSON.stringify(persistedPagination)) {
        setUiState(tableId, { pagination: validNewPaginationState });
      }
    }
  }, [table.getState().pagination, tableId, setUiState, persistedState?.pagination, initialPageSizeProp]);

  // Render the sortable header
  const renderSortableHeader = (header: any) => {
    const canSort = header.column.getCanSort()
    const isSorted = header.column.getIsSorted()
    
    return (
      <div className="flex items-center">
        {flexRender(
          header.column.columnDef.header,
          header.getContext()
        )}
        
        {canSort && (
          <div className="ml-2">
            {isSorted === "desc" ? (
              <ArrowDownIcon className="h-4 w-4" />
            ) : isSorted === "asc" ? (
              <ArrowUpIcon className="h-4 w-4" />
            ) : (
              enableSorting && <CaretSortIcon className="h-4 w-4 opacity-50" />
            )}
          </div>
        )}
      </div>
    )
  }

  // Default pagination component
  const defaultPagination = enablePagination && (
    <div className="flex items-center justify-between p-4 border-t">
      <div className="flex-1 text-sm text-muted-foreground">
        {table.getFilteredSelectedRowModel().rows.length} of{" "}
        {table.getFilteredRowModel().rows.length} row(s) selected.
      </div>
      <div className="flex items-center space-x-6 lg:space-x-8">
        <div className="flex items-center space-x-2">
          <p className="text-sm font-medium">Rows per page</p>
          <Select
            value={`${table.getState().pagination?.pageSize || initialPageSizeProp}`}
            onValueChange={(value) => {
              table.setPageSize(Number(value))
            }}
          >
            <SelectTrigger className="h-8 w-[70px]">
              <SelectValue placeholder={table.getState().pagination?.pageSize || initialPageSizeProp} />
            </SelectTrigger>
            <SelectContent side="top">
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={`${size}`}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex w-[100px] items-center justify-center text-sm font-medium">
          Page {table.getState().pagination?.pageIndex !== undefined 
            ? table.getState().pagination.pageIndex + 1 
            : 1} of{" "}
          {table.getPageCount()}
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            className="hidden h-8 w-8 p-0 lg:flex"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">Go to first page</span>
            <DoubleArrowLeftIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">Go to previous page</span>
            <ChevronLeftIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">Go to next page</span>
            <ChevronRightIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="hidden h-8 w-8 p-0 lg:flex"
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">Go to last page</span>
            <DoubleArrowRightIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )

  return (
    <div className='space-y-4'>
      {/* Render custom toolbar if provided */}
      <div className="flex items-center justify-between">
        {toolbar && <div>{toolbar}</div>}
        
        {showColumnVisibility && (
          <DataTableColumns
            table={table}
            tableId={tableId} // Pass tableId here
            className={columnVisibilityButtonClassName}
            enableColumnVisibility={true}
            enableColumnSorting={enableSorting}
            enableColumnFiltering={true}
            // enableColumnResizing and enableColumnReordering can be added as props if needed
          />
        )}
      </div>
      
      <div className='rounded-md border'>
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const isClickable = enableSorting && header.column.getCanSort()
                  return (
                    <TableHead 
                      key={header.id} 
                      colSpan={header.colSpan}
                      className={isClickable ? 'cursor-pointer select-none' : ''}
                      onClick={isClickable ? header.column.getToggleSortingHandler() : undefined}
                    >
                      {header.isPlaceholder
                        ? null
                        : renderSortableHeader(header)
                      }
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className='h-24 text-center'
                >
                  Loading data...
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && 'selected'}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className='h-24 text-center'
                >
                  {emptyState || "No results."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      
      {/* Render custom pagination if provided, or default if enabled */}
      {customPagination || defaultPagination}
    </div>
  )
}

// Add type declaration for table meta
declare module '@tanstack/react-table' {
  interface TableMeta<TData extends RowData> {
    onUpdate?: (rowId: string, columnId: string, value: any) => Promise<void>
    editableColumns?: string[]
    tableReady?: boolean
  }
} 