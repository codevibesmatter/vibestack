import { useContext } from 'react';
import { useSyncContext } from '@/sync/SyncContext'; // Context hook
// Removed unused imports: SyncState, Badge, icons, formatDateTime, getSyncStatusVisuals
import { Skeleton } from '@/components/ui/skeleton';

export function Overview() {
  // Keep useSyncContext hook for isLoading, but data is no longer used here
  const { isLoading: isSyncLoading } = useSyncContext(); 

  if (isSyncLoading) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-5 w-2/3" />
      </div>
    );
  }

  // Return placeholder content if not loading
  return (
    <div className="p-4 text-sm text-muted-foreground">
      (Overview content TBD)
    </div>
  );
}
