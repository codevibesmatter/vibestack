import { useMemo, useState } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type SortingState,
  type ColumnDef
} from '@tanstack/react-table'
import type { ClientMigration } from '@repo/dataforge/server-entities'

export type Migration = ClientMigration & { id: string }

export interface MigrationsTableProps {
  columns: ColumnDef<Migration, any>[];
  data: Migration[];
  isLoading?: boolean;
  enableRowSelection?: boolean;
  enableMultiRowSelection?: boolean;
  onRowSelectionChange?: (rows: Record<string, boolean>) => void;
  state?: {
    rowSelection?: Record<string, boolean>;
  };
}

export function MigrationsTable({ 
  columns,
  data,
  isLoading = false,
  enableRowSelection = false,
  enableMultiRowSelection = false,
  onRowSelectionChange,
  state
}: MigrationsTableProps) {
  // Sorting state
  const [sorting, setSorting] = useState<SortingState>([])
  
  // Memoize the table instance
  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      rowSelection: state?.rowSelection || {},
    },
    enableRowSelection: enableRowSelection,
    enableMultiRowSelection: enableMultiRowSelection,
    getRowId: (row) => {
      return row.migrationName || row.id || `migration-${Math.random()}`;
    },
    onRowSelectionChange: (updaterOrValue) => {
      if (onRowSelectionChange) {
        const newValue = typeof updaterOrValue === 'function' 
          ? updaterOrValue(state?.rowSelection || {}) 
          : updaterOrValue;
        onRowSelectionChange(newValue);
      }
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    debugTable: true,
  })

  return (
    <div className="overflow-x-auto">
      {isLoading ? (
        <div className="p-8 text-center text-gray-400">
          Loading...
        </div>
      ) : data.length === 0 ? (
        <div className="p-8 text-center text-gray-400">
          No migrations found.
        </div>
      ) : (
        <>
          <div className="mb-2 text-sm text-gray-400">
            Found {data.length} migrations
          </div>
          <table className="w-full border-collapse">
            <thead>
              {table.getHeaderGroups().map(headerGroup => (
                <tr key={headerGroup.id} className="bg-[#1a1a1a]">
                  {headerGroup.headers.map(header => (
                    <th
                      key={header.id}
                      className="text-left text-sm font-semibold text-gray-300 p-4 border-b border-[#404040]"
                      style={{ width: header.getSize() }}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="bg-[#1a1a1a]">
              {table.getRowModel().rows.map(row => (
                <tr 
                  key={row.id}
                  className={`border-b border-[#404040] hover:bg-[#2a2a2a] transition-colors ${
                    row.getIsSelected() ? 'bg-[#2a2a2a]' : ''
                  }`}
                >
                  {row.getVisibleCells().map(cell => (
                    <td key={cell.id} className="p-4 text-gray-300">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
} 