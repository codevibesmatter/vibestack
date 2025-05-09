import React, { useState, useMemo } from 'react'
import { Settings, ArrowUpDown, ArrowDown, ArrowUp, GripVertical, Filter } from 'lucide-react'
import { Table, Column, ColumnOrderState, ColumnSizingState, SortingState, Row } from '@tanstack/react-table'
import { Button } from '@/components/ui/button'
import { 
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetDescription,
  SheetClose
} from '@/components/ui/sheet'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { 
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useDataTableUiStore } from '@/stores/dataTableUiStore'

/**
 * Main interface for the DataTableColumns component
 */
export interface DataTableColumnsProps<TData> {
  table: Table<TData>
  tableId: string // Added for reset functionality
  variant?: 'default' | 'outline' | 'ghost'
  className?: string
  enableColumnVisibility?: boolean
  enableColumnSorting?: boolean
  enableColumnFiltering?: boolean
  enableColumnResizing?: boolean
  enableColumnReordering?: boolean
  buttonSize?: 'default' | 'sm' | 'lg' | 'icon'
}

/**
 * Unified component for managing all column-related functionality
 */
export function DataTableColumns<TData>({
  table,
  tableId,
  variant = 'outline',
  className,
  enableColumnVisibility = true,
  enableColumnSorting = true,
  enableColumnFiltering = true,
  enableColumnResizing = false,
  enableColumnReordering = false,
  buttonSize = 'icon'
}: DataTableColumnsProps<TData>) {
  const [activeTab, setActiveTab] = useState("visibility")
  const { resetUiState } = useDataTableUiStore()
  const [open, setOpen] = useState(false)
  
  // Get all manageable columns (excluding special columns like selection)
  const columns = table.getAllColumns().filter(
    column => typeof column.accessorFn !== 'undefined'
  )
  
  // Calculate active feature counts for badges
  const activeFiltersCount = useMemo(() => {
    return table.getState().columnFilters.length
  }, [table.getState().columnFilters])
  
  const activeSortingCount = useMemo(() => {
    return table.getState().sorting.length
  }, [table.getState().sorting])

  // Get enabled features count to determine if we should show tabs
  const enabledFeaturesCount = [
    enableColumnVisibility,
    enableColumnSorting,
    enableColumnFiltering,
    enableColumnResizing,
    enableColumnReordering
  ].filter(Boolean).length
  
  // Don't render if no columns exist or no features are enabled
  if (!columns.length || enabledFeaturesCount === 0) {
    return null
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button 
              variant={variant} 
              size={buttonSize}
              className={className}
            >
              <Settings className="h-4 w-4" />
              {activeFiltersCount > 0 && (
                <Badge variant="secondary" className="ml-1 h-4 w-4 p-0 font-normal">
                  {activeFiltersCount}
                </Badge>
              )}
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>Column Management</p>
        </TooltipContent>
      </Tooltip>
      
      <SheetContent side="right" className="w-[300px] sm:w-[400px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Column Management</SheetTitle>
          <SheetDescription>
            Customize how table columns are displayed
          </SheetDescription>
        </SheetHeader>
        
        {enabledFeaturesCount > 1 ? (
          <Tabs
            defaultValue="visibility"
            value={activeTab}
            onValueChange={setActiveTab}
            className="mt-4"
          >
            <TabsList className="grid" style={{ 
              gridTemplateColumns: `repeat(${enabledFeaturesCount}, 1fr)` 
            }}>
              {enableColumnVisibility && (
                <TabsTrigger value="visibility">Visibility</TabsTrigger>
              )}
              {enableColumnSorting && (
                <TabsTrigger value="sorting">
                  Sorting
                  {activeSortingCount > 0 && (
                    <Badge variant="secondary" className="ml-1">{activeSortingCount}</Badge>
                  )}
                </TabsTrigger>
              )}
              {enableColumnFiltering && (
                <TabsTrigger value="filtering">
                  Filters
                  {activeFiltersCount > 0 && (
                    <Badge variant="secondary" className="ml-1">{activeFiltersCount}</Badge>
                  )}
                </TabsTrigger>
              )}
              {enableColumnResizing && (
                <TabsTrigger value="sizing">Sizing</TabsTrigger>
              )}
              {enableColumnReordering && (
                <TabsTrigger value="ordering">Order</TabsTrigger>
              )}
            </TabsList>
            
            {enableColumnVisibility && (
              <TabsContent value="visibility" className="mt-4">
                <ColumnVisibilityContent table={table} />
              </TabsContent>
            )}
            
            {enableColumnSorting && (
              <TabsContent value="sorting" className="mt-4">
                <ColumnSortingContent table={table} />
              </TabsContent>
            )}
            
            {enableColumnFiltering && (
              <TabsContent value="filtering" className="mt-4">
                <ColumnFilteringContent table={table} />
              </TabsContent>
            )}
            
            {enableColumnResizing && (
              <TabsContent value="sizing" className="mt-4">
                <ColumnResizingContent table={table} />
              </TabsContent>
            )}
            
            {enableColumnReordering && (
              <TabsContent value="ordering" className="mt-4">
                <ColumnReorderingContent table={table} />
              </TabsContent>
            )}
          </Tabs>
        ) : (
          // If only one feature is enabled, don't show tabs
          <div className="mt-4">
            {enableColumnVisibility && <ColumnVisibilityContent table={table} />}
            {enableColumnSorting && <ColumnSortingContent table={table} />}
            {enableColumnFiltering && <ColumnFilteringContent table={table} />}
            {enableColumnResizing && <ColumnResizingContent table={table} />}
            {enableColumnReordering && <ColumnReorderingContent table={table} />}
          </div>
        )}
        
        <Separator className="my-4" />

        <div className="mt-4 mb-2">
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              resetUiState(tableId)
              table.resetSorting(true)
              table.resetColumnVisibility(true)
              table.resetColumnOrder(true)
              table.resetColumnSizing(true)
              table.resetColumnFilters(true)
              table.resetPagination(true)
              // Optionally close the sheet after reset, or inform user.
              // For now, let's keep it open so they see the changes.
              // setOpen(false)
            }}
          >
            Reset View to Defaults
          </Button>
        </div>

        <div className="mt-6">
          <SheetClose asChild>
            <Button className="w-full">Apply & Close</Button>
          </SheetClose>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * Column visibility tab content
 */
function ColumnVisibilityContent<TData>({ table }: { table: Table<TData> }) {
  // Get all columns that can be hidden
  const columns = table.getAllColumns().filter(
    column => typeof column.accessorFn !== 'undefined' && column.getCanHide()
  )
  
  const allColumnsVisible = columns.every(column => column.getIsVisible())
  const noColumnsVisible = columns.every(column => !column.getIsVisible())
  
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="space-y-1">
          <h4 className="text-sm font-medium">Toggle All</h4>
          <p className="text-sm text-muted-foreground">
            Show or hide columns in the table
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.toggleAllColumnsVisible(false)}
            disabled={noColumnsVisible}
          >
            Hide All
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.toggleAllColumnsVisible(true)}
            disabled={allColumnsVisible}
          >
            Show All
          </Button>
        </div>
      </div>
      
      <ScrollArea className="h-[300px] rounded-md border p-4">
        <div className="space-y-4">
          {columns.map(column => {
            const isVisible = column.getIsVisible()
            const columnTitle = typeof column.columnDef.header === 'string' 
              ? column.columnDef.header 
              : column.id
              
            return (
              <div
                key={column.id}
                className="flex items-center justify-between py-2"
              >
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id={`toggle-${column.id}`}
                    checked={isVisible}
                    onCheckedChange={value => {
                      column.toggleVisibility(!!value)
                    }}
                    aria-label={`Toggle ${columnTitle} column visibility`}
                  />
                  <Label
                    htmlFor={`toggle-${column.id}`}
                    className="cursor-pointer"
                  >
                    {columnTitle}
                  </Label>
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

/**
 * Column sorting tab content
 */
function ColumnSortingContent<TData>({ table }: { table: Table<TData> }) {
  const sorting = table.getState().sorting || []
  
  const sortableColumns = table.getAllColumns().filter(
    column => typeof column.accessorFn !== 'undefined' && column.getCanSort()
  )
  
  const handleClearSort = () => {
    table.resetSorting()
  }
  
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="space-y-1">
          <h4 className="text-sm font-medium">Column Sorting</h4>
          <p className="text-sm text-muted-foreground">
            Set the sort order of columns
          </p>
        </div>
        {sorting.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearSort}
          >
            Clear All
          </Button>
        )}
      </div>
      
      {sorting.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-4 border rounded-md">
          No active sorting. Click a column header to sort or add sorting here.
        </div>
      ) : (
        <div className="space-y-4">
          {sorting.map((sort, index) => {
            const column = table.getColumn(sort.id)
            if (!column) return null
            
            const columnTitle = typeof column.columnDef.header === 'string' 
              ? column.columnDef.header 
              : column.id
              
            return (
              <div key={sort.id} className="flex items-center gap-2 p-2 border rounded-md">
                <div className="flex-1">
                  <div className="font-medium">{columnTitle}</div>
                  <div className="text-sm text-muted-foreground flex items-center gap-1">
                    {sort.desc ? (
                      <><ArrowDown className="h-3 w-3" /> Descending</>
                    ) : (
                      <><ArrowUp className="h-3 w-3" /> Ascending</>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const newSorting = [...sorting]
                      newSorting[index] = { ...sort, desc: !sort.desc }
                      table.setSorting(newSorting)
                    }}
                  >
                    <ArrowUpDown className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const newSorting = sorting.filter((_, i) => i !== index)
                      table.setSorting(newSorting)
                    }}
                  >
                    <span>✕</span>
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      
      <Separator className="my-4" />
      
      <div>
        <h4 className="text-sm font-medium mb-2">Add Sorting</h4>
        <div className="flex gap-2">
          <Select
            onValueChange={(columnId) => {
              const newSort = { id: columnId, desc: false }
              table.setSorting([...sorting, newSort])
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select column" />
            </SelectTrigger>
            <SelectContent>
              {sortableColumns
                .filter(column => !sorting.some(sort => sort.id === column.id))
                .map(column => {
                  const columnTitle = typeof column.columnDef.header === 'string' 
                    ? column.columnDef.header 
                    : column.id
                    
                  return (
                    <SelectItem key={column.id} value={column.id}>
                      {columnTitle}
                    </SelectItem>
                  )
                })}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  )
}

/**
 * Column filtering tab content
 */
function ColumnFilteringContent<TData>({ table }: { table: Table<TData> }) {
  const columnFilters = table.getState().columnFilters || []
  
  // Only get columns that can be filtered and have a filterFn
  const filterableColumns = table.getAllColumns().filter(
    column => typeof column.accessorFn !== 'undefined' && column.getCanFilter()
  )
  
  const handleClearFilters = () => {
    table.resetColumnFilters()
  }
  
  const getFilterOperator = (column: Column<any, unknown>) => {
    // Get the filter function from the column definition
    const filterFn = column.columnDef.filterFn
    
    // Handle TanStack Table's built-in filter function names
    if (filterFn === 'equalsString' || filterFn === 'weakEquals') return '='
    if (filterFn === 'includesString' || filterFn === 'includesStringSensitive') return 'contains'
    if (filterFn === 'arrIncludes') return 'includes'
    if (filterFn === 'inNumberRange') return 'between'
    
    // Handle custom filter cases by their string names if provided
    const filterFnName = typeof filterFn === 'string' ? filterFn : 'custom'
    if (filterFnName.includes('startsWith')) return 'starts with'
    if (filterFnName.includes('endsWith')) return 'ends with'
    if (filterFnName.includes('greaterThan')) return '>'
    if (filterFnName.includes('lessThan')) return '<'
    
    return 'contains' // default
  }
  
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="space-y-1">
          <h4 className="text-sm font-medium">Column Filters</h4>
          <p className="text-sm text-muted-foreground">
            Filter table data by column values
          </p>
        </div>
        {columnFilters.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearFilters}
          >
            Clear All
          </Button>
        )}
      </div>
      
      {columnFilters.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-4 border rounded-md">
          No active filters. Add a filter below.
        </div>
      ) : (
        <div className="space-y-4">
          {columnFilters.map((filter, index) => {
            const column = table.getColumn(filter.id)
            if (!column) return null
            
            const columnTitle = typeof column.columnDef.header === 'string' 
              ? column.columnDef.header 
              : column.id
              
            return (
              <div key={filter.id} className="p-2 border rounded-md">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-medium">{columnTitle}</div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const newFilters = columnFilters.filter((_, i) => i !== index)
                      table.setColumnFilters(newFilters)
                    }}
                  >
                    <span>✕</span>
                  </Button>
                </div>
                <div className="text-sm flex gap-2 items-center">
                  <span className="text-muted-foreground">{getFilterOperator(column)}</span>
                  <Input 
                    value={filter.value as string} 
                    onChange={e => {
                      const newFilters = [...columnFilters]
                      newFilters[index] = { ...filter, value: e.target.value }
                      table.setColumnFilters(newFilters)
                    }}
                    className="h-8"
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
      
      <Separator className="my-4" />
      
      <div>
        <h4 className="text-sm font-medium mb-2">Add Filter</h4>
        <div className="flex gap-2">
          <Select
            onValueChange={(columnId) => {
              // Check if a filter already exists for this column
              if (columnFilters.some(filter => filter.id === columnId)) return
              
              const newFilter = { id: columnId, value: '' }
              table.setColumnFilters([...columnFilters, newFilter])
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select column" />
            </SelectTrigger>
            <SelectContent>
              {filterableColumns
                .filter(column => !columnFilters.some(filter => filter.id === column.id))
                .map(column => {
                  const columnTitle = typeof column.columnDef.header === 'string' 
                    ? column.columnDef.header 
                    : column.id
                    
                  return (
                    <SelectItem key={column.id} value={column.id}>
                      {columnTitle}
                    </SelectItem>
                  )
                })}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  )
}

/**
 * Column resizing tab content
 */
function ColumnResizingContent<TData>({ table }: { table: Table<TData> }) {
  const resizableColumns = table.getAllColumns().filter(
    column => typeof column.accessorFn !== 'undefined' && column.getCanResize()
  )
  
  const handleResetSizing = () => {
    table.resetColumnSizing()
  }
  
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="space-y-1">
          <h4 className="text-sm font-medium">Column Sizing</h4>
          <p className="text-sm text-muted-foreground">
            Set the width of columns in the table
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleResetSizing}
        >
          Reset All
        </Button>
      </div>
      
      <ScrollArea className="h-[300px] rounded-md border p-4">
        <div className="space-y-4">
          {resizableColumns.map(column => {
            const columnTitle = typeof column.columnDef.header === 'string' 
              ? column.columnDef.header 
              : column.id
              
            const size = column.getSize()
            
            return (
              <div
                key={column.id}
                className="space-y-2"
              >
                <div className="flex items-center justify-between">
                  <Label
                    htmlFor={`size-${column.id}`}
                    className="text-sm"
                  >
                    {columnTitle}
                  </Label>
                  <span className="text-sm text-muted-foreground">
                    {size}px
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      // Use the correct column sizing API
                      const newSize = Math.max(30, size - 10)
                      table.setColumnSizing(prev => ({
                        ...prev,
                        [column.id]: newSize
                      }))
                    }}
                  >
                    -
                  </Button>
                  <input 
                    type="range"
                    id={`size-${column.id}`}
                    min={30}
                    max={500}
                    value={size}
                    onChange={(e) => {
                      // Use the correct column sizing API
                      const newSize = parseInt(e.target.value)
                      table.setColumnSizing(prev => ({
                        ...prev,
                        [column.id]: newSize
                      }))
                    }}
                    className="flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      // Use the correct column sizing API
                      const newSize = Math.min(500, size + 10)
                      table.setColumnSizing(prev => ({
                        ...prev,
                        [column.id]: newSize
                      }))
                    }}
                  >
                    +
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

/**
 * Column reordering tab content
 */
function ColumnReorderingContent<TData>({ table }: { table: Table<TData> }) {
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(
    table.getState().columnOrder || []
  )
  
  const reorderableColumns = table.getAllLeafColumns().filter(
    column => typeof column.accessorFn !== 'undefined'
  )
  
  const handleResetOrder = () => {
    table.resetColumnOrder()
    setColumnOrder([])
  }
  
  const handleMoveColumn = (columnId: string, direction: 'up' | 'down') => {
    const column = table.getColumn(columnId)
    if (!column) return
    
    const leafColumns = table.getAllLeafColumns().filter(
      col => typeof col.accessorFn !== 'undefined'
    )
    
    // If columnOrder is empty, initialize it with the current visible column order
    const currentOrder = columnOrder.length 
      ? columnOrder
      : leafColumns.map(col => col.id)
    
    const currentIndex = currentOrder.findIndex(id => id === columnId)
    if (currentIndex === -1) return
    
    const newOrder = [...currentOrder]
    
    if (direction === 'up' && currentIndex > 0) {
      // Move up
      [newOrder[currentIndex], newOrder[currentIndex - 1]] = 
      [newOrder[currentIndex - 1], newOrder[currentIndex]]
    } else if (direction === 'down' && currentIndex < newOrder.length - 1) {
      // Move down
      [newOrder[currentIndex], newOrder[currentIndex + 1]] = 
      [newOrder[currentIndex + 1], newOrder[currentIndex]]
    }
    
    setColumnOrder(newOrder)
    table.setColumnOrder(newOrder)
  }
  
  // Get columns in their current order (including any user reordering)
  const orderedColumns = useMemo(() => {
    if (!columnOrder.length) return reorderableColumns
    
    // Create a copy of the columns array to sort
    const columnsToSort = [...reorderableColumns]
    
    // Sort based on the columnOrder state
    return columnsToSort.sort((a, b) => {
      const aIndex = columnOrder.findIndex(id => id === a.id)
      const bIndex = columnOrder.findIndex(id => id === b.id)
      
      // If a column is not in the order state, put it at the end
      if (aIndex === -1) return 1
      if (bIndex === -1) return -1
      
      return aIndex - bIndex
    })
  }, [reorderableColumns, columnOrder])
  
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="space-y-1">
          <h4 className="text-sm font-medium">Column Order</h4>
          <p className="text-sm text-muted-foreground">
            Reorder columns in the table
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleResetOrder}
        >
          Reset Order
        </Button>
      </div>
      
      <ScrollArea className="h-[300px] rounded-md border p-4">
        <div className="space-y-2">
          {orderedColumns.map((column, index) => {
            const columnTitle = typeof column.columnDef.header === 'string' 
              ? column.columnDef.header 
              : column.id
            
            return (
              <div
                key={column.id}
                className="flex items-center justify-between p-2 border rounded-md cursor-move"
              >
                <div className="flex items-center gap-2">
                  <GripVertical className="h-4 w-4 text-muted-foreground" />
                  <span>{columnTitle}</span>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleMoveColumn(column.id, 'up')}
                    disabled={index === 0}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleMoveColumn(column.id, 'down')}
                    disabled={index === orderedColumns.length - 1}
                  >
                    ↓
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
} 