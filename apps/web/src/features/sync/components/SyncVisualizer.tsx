import React from 'react';
import { useSyncContext } from '@/sync/SyncContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useSyncVisualizationState } from '../hooks/useSyncVisualizationState';
import { SyncVisualizationCore } from './SyncVisualizationCore';

interface SyncVisualizerProps {
  className?: string;
}

export function SyncVisualizer({ className }: SyncVisualizerProps) {
  const { isConnected, syncState, pendingChanges } = useSyncContext();
  const { currentLsn, errorInfo } = useSyncVisualizationState();

  return (
    <Card className={className}>
        <CardHeader>
            <CardTitle>Sync Status</CardTitle>
        </CardHeader>
        <CardContent>
            <div className="flex flex-col space-y-2">
                 <p>Status: {isConnected ? `Connected (${syncState})` : (syncState === 'connecting' ? 'Connecting...' : 'Disconnected')}</p>
                 <p>Pending Outgoing: {pendingChanges ?? 0}</p>
                 <p>LSN: {currentLsn}</p>
                 {errorInfo && <p className="text-red-500 text-sm">Error: {errorInfo}</p>}

                 <SyncVisualizationCore className="mt-4" />
            </div>
        </CardContent>
    </Card>
  );
} 