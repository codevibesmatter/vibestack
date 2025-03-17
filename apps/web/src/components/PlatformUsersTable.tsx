import React, { useRef, useState, useEffect, forwardRef, useImperativeHandle, useCallback, useMemo } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
  SortingState,
  getFilteredRowModel,
  ColumnFiltersState,
  getPaginationRowModel,
  TableMeta
} from '@tanstack/react-table';
import { User } from '@repo/typeorm/client-entities';
// Import from the new data layer structure
import { PerformanceMetrics } from '../data/common/base/DataAccess';
// Import from our Jotai store
import { useAtom, atom, SetStateAction } from 'jotai';
import {
  usersAtom,
  usersLoadingAtom,
  usersErrorAtom,
  usersTotalCountAtom,
  usersMetricsAtom,
  selectedUserIdAtom,
  highlightedUserIdAtom,
  usersByIdAtom,
  loadingUserIdsAtom,
  errorUserIdsAtom,
  loadedUserIdsAtom,
  fetchUsersAtom,
  fetchUserByIdAtom,
  updateUserAtom,
  // Import the subscription hook
  useUserDbSubscription
} from '../data/user/store';
// Import the direct API functions
import { updateUser, getUserById } from '../data/user/api';
// Import database message bus
import { dbMessageBus, DbEventType } from '../db/message-bus';

// Define the User type for TypeScript
export type UserRow = User;

export interface PlatformUsersTableRef {
  resetPagination: () => void;
  getVisibleUsers: () => UserRow[];
  refreshUser: (userId: string) => Promise<User | null>;
  getCurrentSorting: () => SortingState;
  refreshSorting: () => void;
  refreshData: () => void;
}

interface PlatformUsersTableProps {
  onEdit: (user: UserRow) => void;
  onDelete: (user: UserRow) => void;
  isVisible?: boolean; // Optional prop to control visibility from parent
  users?: UserRow[]; // Add users prop
  loading?: boolean; // Add loading prop
  error?: string | null; // Add error prop
  highlightedUserId?: string | null; // Add highlightedUserId prop
  externalMetrics?: PerformanceMetrics; // Add externalMetrics prop
  useByIdStore?: boolean; // Add option to use by-ID store
}

// Define custom meta type for the table
interface UserTableMeta {
  updateData: (userId: string, columnId: string, value: any) => Promise<void>;
}

export const PlatformUsersTable = forwardRef<PlatformUsersTableRef, PlatformUsersTableProps>(({ 
  onEdit, 
  onDelete, 
  isVisible = false,
  users: externalUsers,
  loading: externalLoading,
  error: externalError,
  highlightedUserId: externalHighlightedUserId,
  externalMetrics,
  useByIdStore = true // Default to using the by-ID store
}, ref) => {
  // Local state for table features
  const [renderTime, setRenderTime] = useState(0);
  
  // Add cache metrics
  const [cacheMetrics, setCacheMetrics] = useState({
    hits: 0,
    misses: 0,
    lastAccess: 0
  });
  
  // Jotai state
  const [allUsers] = useAtom(usersAtom);
  const [loading] = useAtom(usersLoadingAtom);
  const [error] = useAtom(usersErrorAtom);
  const [totalUsers, setTotalUsers] = useAtom(usersTotalCountAtom);
  const [metrics] = useAtom(usersMetricsAtom);
  const [highlightedUserId] = useAtom(highlightedUserIdAtom);
  const [, fetchUsers] = useAtom(fetchUsersAtom);
  
  // By-ID store state
  const [usersById] = useAtom(usersByIdAtom);
  const [, fetchUserById] = useAtom(fetchUserByIdAtom);
  const [, updateUserById] = useAtom(updateUserAtom);
  
  // Subscribe to database changes for users
  useUserDbSubscription();
  
  // State for table features
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'updatedAt', desc: true } // Initial sort by updatedAt in descending order
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  
  // Pagination state
  const [pageSize, setPageSize] = useState(20);
  const [pageIndex, setPageIndex] = useState(0);
  
  // Inline editing state
  const [editingCell, setEditingCell] = useState<{userId: string, field: string} | null>(null);
  const [editValue, setEditValue] = useState('');
  
  // Add a ref to prevent table state resets during data updates
  const skipPageResetRef = useRef(false);
  
  // Refs for tracking component state
  const isMountedRef = useRef(true);
  const lastSortRefreshTime = useRef<number>(0);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  
  // Add a ref to track if we've already attempted to fetch users
  const hasFetchedRef = useRef(false);
  
  // Effect to reset the skipPageReset flag
  useEffect(() => {
    skipPageResetRef.current = false;
  });
  
  // Function to get the effective users list for the table
  const getEffectiveUsers = useCallback(() => {
    if (useByIdStore) {
      const usersList = Object.values(usersById);
      console.log(`[DEBUG] Using usersById for table data, found ${usersList.length} users`);
      
      return usersList;
    } else {
      return allUsers;
    }
  }, [useByIdStore, usersById, allUsers]);
  
  // Memoize the data to prevent unnecessary re-renders
  const tableData = useMemo(() => getEffectiveUsers(), [getEffectiveUsers]);
  
  const effectiveLoading = externalLoading !== undefined ? externalLoading : loading;
  const effectiveError = externalError !== undefined ? externalError : error;
  const effectiveHighlightedUserId = externalHighlightedUserId !== undefined ? externalHighlightedUserId : highlightedUserId;
  const effectiveMetrics = externalMetrics || metrics;
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  
  // Function to refresh the sorting
  const refreshSorting = useCallback(() => {
    // Force a re-sort by creating a new sorting array with the same values
    const currentSorting = [...sorting];
    setSorting(currentSorting);
    
    // Log the refresh
    console.log(`Refreshing sorting with ${currentSorting.length} sort criteria`);
  }, [sorting]);
  
  // Reset pagination and fetch data on mount
  useEffect(() => {
    // Reset to first page
    setPageIndex(0);
    
    // Check if we already have cached data or if we've already attempted to fetch
    if (useByIdStore && Object.keys(usersById).length === 0 && !hasFetchedRef.current) {
      // Fetch users if we don't have any cached and haven't tried yet
      console.log('No users in cache and no fetch attempt yet, fetching users...');
      fetchUsers();
      hasFetchedRef.current = true;
    }
  }, [useByIdStore, usersById, fetchUsers]);
  
  // Reset the hasFetched flag when the component becomes visible
  useEffect(() => {
    if (!isVisible) {
      hasFetchedRef.current = false;
    }
  }, [isVisible]);
  
  // Create a custom editable cell component
  const EditableCell = useCallback(
    ({ getValue, row, column, table }: any) => {
      const initialValue = getValue();
      const [value, setValue] = useState(initialValue);
      const [isEditing, setIsEditing] = useState(false);
      
      // Update internal state when the value changes externally
      useEffect(() => {
        setValue(getValue());
      }, [getValue]);
      
      // Handle cell click to start editing
      const onCellClick = () => {
        // Only allow editing certain fields
        const editableFields = ['name', 'email', 'role', 'status'];
        if (!editableFields.includes(column.id)) return;
        
        setIsEditing(true);
      };
      
      // Handle blur to save changes
      const onBlur = () => {
        setIsEditing(false);
        
        // Only update if the value has changed
        if (value !== initialValue) {
          table.options.meta?.updateData(row.original.id, column.id, value);
        }
      };
      
      // Handle key press events
      const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          onBlur();
        } else if (e.key === 'Escape') {
          setIsEditing(false);
          setValue(initialValue);
        }
      };
      
      // Render either the input or the display value
      if (isEditing) {
        return (
          <input
            className="w-full bg-gray-700 text-white px-2 py-1 rounded"
            value={value}
            onChange={e => setValue(e.target.value)}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            autoFocus
          />
        );
      }
      
      return (
        <div 
          className="cursor-pointer hover:bg-gray-700 px-2 py-1 rounded"
          onClick={onCellClick}
        >
          {value}
        </div>
      );
    },
    []
  );
  
  // Create the table columns with editable cells
  const columns = useMemo(() => {
      const columnHelper = createColumnHelper<UserRow>();
    
      return [
      columnHelper.accessor('id', {
        header: 'ID',
        cell: info => <span className="text-gray-400">{info.getValue().substring(0, 8)}...</span>,
      }),
        columnHelper.accessor('name', {
          header: 'Name',
        cell: EditableCell,
        }),
        columnHelper.accessor('email', {
          header: 'Email',
        cell: EditableCell,
      }),
      columnHelper.accessor((row: any) => row.role || '', {
        id: 'role',
        header: 'Role',
        cell: EditableCell,
      }),
      columnHelper.accessor((row: any) => row.status || '', {
        id: 'status',
        header: 'Status',
        cell: EditableCell,
        }),
        columnHelper.accessor('createdAt', {
        header: 'Created',
        cell: info => new Date(info.getValue()).toLocaleString(),
        }),
        columnHelper.accessor('updatedAt', {
        header: 'Updated',
        cell: info => new Date(info.getValue()).toLocaleString(),
        // Add a custom sorting function to properly compare dates
        sortingFn: (rowA, rowB, columnId) => {
          // Get the raw date values
          const dateA = rowA.original.updatedAt;
          const dateB = rowB.original.updatedAt;
          
          // Convert to Date objects if they're strings
          const timeA = dateA instanceof Date ? dateA.getTime() : new Date(dateA).getTime();
          const timeB = dateB instanceof Date ? dateB.getTime() : new Date(dateB).getTime();
          
          // Compare the timestamps
          return timeA - timeB;
        }
        }),
        columnHelper.display({
          id: 'actions',
          header: 'Actions',
        cell: info => (
          <div className="flex space-x-2">
            <button
              onClick={() => onEdit(info.row.original)}
              className="px-2 py-1 bg-blue-600 text-white text-xs rounded"
            >
              Edit
            </button>
            <button
              onClick={() => onDelete(info.row.original)}
              className="px-2 py-1 bg-red-600 text-white text-xs rounded"
            >
              Delete
            </button>
          </div>
        ),
      }),
    ];
  }, [EditableCell, onEdit, onDelete]);
  
  // Create the table instance
  const table = useReactTable<UserRow>({
    data: tableData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    state: {
      sorting,
      columnFilters,
      globalFilter,
      pagination: {
        pageIndex,
        pageSize,
      },
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: (updater) => {
      const newPagination = updater instanceof Function ? updater({ pageIndex, pageSize }) : updater;
      setPageIndex(newPagination.pageIndex);
      setPageSize(newPagination.pageSize);
    },
    // Disable auto-reset when we're updating data
    autoResetPageIndex: !skipPageResetRef.current,
    enableSortingRemoval: false,
    getRowId: row => row.id,
    // Add meta object with updateData function
    meta: {
      updateData: async (userId: string, columnId: string, value: any) => {
        // Set the flag to prevent table state resets
        skipPageResetRef.current = true;
        
        try {
          // Prepare the update data
          const updateData: Partial<User> = {};
          updateData[columnId as keyof User] = value as any;
          
          // Use the atom instead of calling the API directly
          console.log(`Updating user ${userId}, field ${columnId}, value ${value}`);
          const updatedUser = await updateUserById(userId, updateData);
          console.log(`Atom update completed successfully`);
          
          // The store will handle the optimistic update, but we'll also update the table data
          // to ensure the UI is consistent with the store
          const updatedData = [...tableData];
          const userIndex = updatedData.findIndex(user => user.id === userId);
          
          if (userIndex !== -1) {
            // Save the current scroll position
            const tableContainer = tableContainerRef.current;
            const scrollTop = tableContainer?.scrollTop || 0;
            
            // Update the user data with ALL fields from the API response
            updatedData[userIndex] = {
              ...updatedData[userIndex],
              ...updatedUser
            };
            
            // Update the table data directly
            table.setOptions(prev => ({
              ...prev,
              data: updatedData
            }));
            
            // Restore scroll position after a short delay to allow for re-render
            setTimeout(() => {
              if (tableContainer) {
                tableContainer.scrollTop = scrollTop;
              }
            }, 0);
          }
        } catch (error) {
          console.error('[PlatformUsersTable] Failed to update user:', error);
        }
      },
    } as any,
  });
  
  // Measure render time once after initial render
  useEffect(() => {
    const startTime = performance.now();
    
    return () => {
      const endTime = performance.now();
      setRenderTime(endTime - startTime);
    };
  }, [tableData.length]);
  
  // Function to refresh a specific user
  const refreshUser = useCallback(async (userId: string): Promise<User | null> => {
    console.log(`Refreshing user ${userId}`);
    
    try {
      // Set the flag to prevent table state resets
      skipPageResetRef.current = true;
      
      // Fetch the user by ID
      const user = await getUserById(userId);
      
      if (user) {
        console.log(`User ${userId} refreshed successfully`);
        
        // Update the local data without triggering a refresh
        const updatedData = [...tableData];
        const userIndex = updatedData.findIndex(u => u.id === userId);
        
        if (userIndex !== -1) {
          // Update the user with the actual updatedAt from the database
          updatedData[userIndex] = user;
          
          // Update the table data directly
          table.setOptions(prev => ({
            ...prev,
            data: updatedData
          }));
        }
      
      return user;
      } else {
        console.error(`User ${userId} not found`);
        return null;
      }
    } catch (error) {
      console.error(`Error refreshing user ${userId}:`, error);
      return null;
    }
  }, [tableData, table]);
  
  // Expose a method to explicitly refresh data
  const refreshData = useCallback(() => {
    console.log('Explicitly refreshing user data...');
    hasFetchedRef.current = false; // Reset the flag to allow fetching
    fetchUsers();
    hasFetchedRef.current = true; // Set it back to true after fetching
  }, [fetchUsers]);
  
  // Expose methods to parent component via ref
  useImperativeHandle(ref, () => ({
    resetPagination: () => {
      table.resetPageIndex();
    },
    getVisibleUsers: () => {
      return table.getRowModel().rows.map(row => row.original);
    },
    refreshUser,
    getCurrentSorting: () => sorting,
    refreshSorting,
    refreshData // Add the new method to the ref
  }));
  
  // Render the component
  return isVisible ? (
    <div className="w-full overflow-hidden">
      <div className="space-y-4">
        {/* Search and filter controls */}
        <div className="flex justify-between items-center mb-4 p-4 rounded-lg border border-[#404040] bg-[#1a1a1a]">
          <div className="text-sm text-gray-400">
            <span className="font-medium">Performance:</span> 
            {useByIdStore && Object.keys(usersById).length > 0 ? (
              <>
                <span className="ml-2 text-green-400">Using cached data</span>
                <span className="ml-2">Cache size: {Object.keys(usersById).length} users</span>
                <span className="ml-2">Cache hits: {cacheMetrics.hits}</span>
                <span className="ml-2">Cache misses: {cacheMetrics.misses}</span>
                <span className="ml-2">Render: {renderTime.toFixed(2)}ms</span>
              </>
            ) : (
              <>
                <span className="ml-2">Query: {effectiveMetrics.queryTime.toFixed(2)}ms</span>
                <span className="ml-2">Total: {effectiveMetrics.totalTime.toFixed(2)}ms</span>
                <span className="ml-2">Render: {renderTime.toFixed(2)}ms</span>
              </>
            )}
          </div>
          <div className="flex space-x-2">
            <input
              type="text"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder="Search users..."
              className="px-3 py-2 bg-[#2a2a2a] border border-[#404040] rounded-md shadow-sm focus:outline-none focus:ring-purple-500 focus:border-purple-500 sm:text-sm text-white"
            />
            <button
              onClick={() => {
                // Reset the fetch flag when explicitly refreshing
                hasFetchedRef.current = false;
                fetchUsers();
                hasFetchedRef.current = true;
              }}
              className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md shadow-sm text-white bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500"
            >
              Refresh
            </button>
            {useByIdStore && (
              <button
                onClick={() => {
                  setCacheMetrics({
                    hits: 0,
                    misses: 0,
                    lastAccess: 0
                  });
                  
                  // Force a refresh from the database
                  hasFetchedRef.current = false;
                  fetchUsers();
                  hasFetchedRef.current = true;
                }}
                className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                title="Clear cache and fetch fresh data"
              >
                Clear Cache
              </button>
            )}
          </div>
        </div>
        
        {/* Total users count */}
        <div className="text-sm text-gray-300 p-3 rounded-lg border border-[#404040] bg-[#1a1a1a]">
          Total users: <span className="font-semibold">{table.getPrePaginationRowModel().rows.length}</span>
          {useByIdStore && (
            <span className="ml-2 text-xs text-gray-400">
              (Using by-ID store: {Object.keys(usersById).length} users in cache)
            </span>
          )}
        </div>
        
        {/* Loading state */}
        {effectiveLoading && (
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-400"></div>
          </div>
        )}
        
        {/* Error state */}
        {effectiveError && (
          <div className="p-4 rounded-lg bg-red-900 text-white">
            <p className="font-semibold">Error:</p>
            <p>{effectiveError}</p>
          </div>
        )}
        
        {/* Table */}
        {!effectiveLoading && !effectiveError && tableData.length > 0 && (
          <div 
            className="overflow-x-auto rounded-lg border border-[#404040]"
            ref={tableContainerRef}
            key={`table-container-${useByIdStore ? 'byId' : 'list'}-${Object.keys(usersById).length}-${allUsers.length}`}
          >
            <table 
              className="min-w-full divide-y divide-[#404040]"
              key={`table-${useByIdStore ? 'byId' : 'list'}-${Object.keys(usersById).length}-${allUsers.length}-${Date.now()}`}
            >
              <thead className="bg-[#2a2a2a]">
                <tr>
                  {table.getFlatHeaders().map(header => (
                    <th
                      key={header.id}
                      className={`px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider ${
                        header.column.getCanSort() ? 'cursor-pointer select-none' : ''
                      }`}
                      onClick={header.column.getCanSort() ? header.column.getToggleSortingHandler() : undefined}
                    >
                      <div className="flex items-center space-x-1">
                        <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                        {header.column.getIsSorted() && (
                          <span>
                            {header.column.getIsSorted() === 'asc' ? ' 🔼' : ' 🔽'}
                          </span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-[#1a1a1a] divide-y divide-[#404040]">
                {table.getRowModel().rows.map(row => {
                  const isHighlighted = row.original.id === effectiveHighlightedUserId;
                  
                  return (
                    <tr 
                      key={row.id}
                      className={isHighlighted ? 'bg-purple-900/30' : 'hover:bg-[#2a2a2a]'}
                    >
                      {row.getVisibleCells().map(cell => (
                        <td 
                          key={cell.id}
                          className="px-6 py-4 whitespace-nowrap text-sm text-gray-200"
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        
        {/* Empty state */}
        {!effectiveLoading && !effectiveError && tableData.length === 0 && (
          <div className="flex justify-center items-center h-64 bg-[#1a1a1a] rounded-lg border border-[#404040]">
            <div className="text-center">
              <p className="text-gray-400 mb-4">No users found</p>
              <button
                onClick={() => fetchUsers()}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500"
              >
                Refresh Data
              </button>
            </div>
          </div>
        )}
        
        {/* Pagination */}
        <div className="flex items-center justify-between p-4 rounded-lg border border-[#404040] bg-[#1a1a1a]">
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-400">
              Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <select
              value={table.getState().pagination.pageSize}
              onChange={e => {
                table.setPageSize(Number(e.target.value));
              }}
              className="px-2 py-1 bg-[#2a2a2a] border border-[#404040] rounded-md shadow-sm focus:outline-none focus:ring-purple-500 focus:border-purple-500 sm:text-sm text-white"
            >
              {[10, 20, 30, 40, 50].map(pageSize => (
                <option key={pageSize} value={pageSize}>
                  Show {pageSize}
                </option>
              ))}
            </select>
          </div>
          <div className="flex space-x-2">
            <button
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage()}
              className={`px-3 py-1 rounded-md text-sm ${
                table.getCanPreviousPage()
                  ? 'bg-purple-600 hover:bg-purple-700 text-white'
                  : 'bg-[#2a2a2a] text-gray-500 cursor-not-allowed'
              }`}
            >
              {'<<'}
            </button>
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className={`px-3 py-1 rounded-md text-sm ${
                table.getCanPreviousPage()
                  ? 'bg-purple-600 hover:bg-purple-700 text-white'
                  : 'bg-[#2a2a2a] text-gray-500 cursor-not-allowed'
              }`}
            >
              {'<'}
            </button>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className={`px-3 py-1 rounded-md text-sm ${
                table.getCanNextPage()
                  ? 'bg-purple-600 hover:bg-purple-700 text-white'
                  : 'bg-[#2a2a2a] text-gray-500 cursor-not-allowed'
              }`}
            >
              {'>'}
            </button>
            <button
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage()}
              className={`px-3 py-1 rounded-md text-sm ${
                table.getCanNextPage()
                  ? 'bg-purple-600 hover:bg-purple-700 text-white'
                  : 'bg-[#2a2a2a] text-gray-500 cursor-not-allowed'
              }`}
            >
              {'>>'}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;
});

PlatformUsersTable.displayName = 'PlatformUsersTable'; 

export default PlatformUsersTable; 