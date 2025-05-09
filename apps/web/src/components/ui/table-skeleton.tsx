import { Skeleton } from "@/components/ui/skeleton";

interface TableSkeletonProps {
  rowCount?: number;
  columnCount?: number;
  showHeader?: boolean;
  headerHeight?: number;
  rowHeight?: number;
}

export function TableSkeleton({
  rowCount = 5,
  columnCount = 6,
  showHeader = true,
  headerHeight = 40,
  rowHeight = 50,
}: TableSkeletonProps) {
  // Create an array of rows and columns for the skeleton
  const rows = Array(rowCount).fill(null);
  const columns = Array(columnCount).fill(null);

  return (
    <div className="w-full rounded-md border">
      {/* Table header */}
      {showHeader && (
        <div 
          className="flex border-b bg-muted/50" 
          style={{ height: `${headerHeight}px` }}
        >
          {columns.map((_, i) => (
            <div 
              key={`header-${i}`} 
              className="flex-1 p-2"
            >
              <Skeleton className="h-6 w-full" />
            </div>
          ))}
        </div>
      )}

      {/* Table rows */}
      {rows.map((_, rowIndex) => (
        <div 
          key={`row-${rowIndex}`} 
          className="flex border-b last:border-b-0" 
          style={{ height: `${rowHeight}px` }}
        >
          {columns.map((_, colIndex) => (
            <div 
              key={`cell-${rowIndex}-${colIndex}`} 
              className="flex-1 p-3"
            >
              <Skeleton className="h-6 w-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function DataTableSkeleton() {
  return (
    <div className="space-y-4">
      {/* Column visibility button */}
      <div className="flex justify-end">
        <Skeleton className="h-9 w-9 rounded-md" />
      </div>
      
      {/* Main table */}
      <TableSkeleton />
    </div>
  );
} 