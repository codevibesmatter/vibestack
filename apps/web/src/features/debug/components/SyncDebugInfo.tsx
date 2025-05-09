import { useState, useEffect } from 'react';
import { useSyncContext } from '../../../sync/SyncContext';
import { getSyncWebSocketUrl } from '../../../sync/config';
import { SyncManager } from '../../../sync/SyncManager';

// UI components
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress"; // Import progress bar component

// Properties for the SyncDebugInfo component
interface SyncDebugInfoProps {
  showDetailedStats?: boolean;
}

/**
 * Component for displaying sync status and controls using shadcn/ui components
 */
export function SyncDebugInfo({ showDetailedStats = false }: SyncDebugInfoProps) {
  // Use the sync context as the single source of truth
  const {
    isConnected,
    syncState,
    lsn,
    clientId,
    lastSyncTime,
    pendingChanges,
    connect,
    disconnect,
    resetLSN,
    processQueuedChanges,
    serverUrl,
    setServerUrl,
    isLoading,
    resyncAllEntities
  } = useSyncContext();
  
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [isResyncing, setIsResyncing] = useState<boolean>(false);
  const [resyncDialogOpen, setResyncDialogOpen] = useState<boolean>(false);
  const [resyncProgress, setResyncProgress] = useState<{current: number, total: number | null}>({
    current: 0,
    total: null
  });
  
  // Get direct state for comparison (debugging only)
  const syncManager = SyncManager.getInstance();
  
  // Handle connect button click
  const handleConnect = async () => {
    try {
      setIsConnecting(true);
      await connect(serverUrl);
    } catch (error: unknown) {
      console.error('Failed to connect:', error instanceof Error ? error.message : String(error));
    } finally {
      setIsConnecting(false);
    }
  };
  
  // Format the sync state for display
  const formatSyncState = (state: string): string => {
    return state.charAt(0).toUpperCase() + state.slice(1);
  };

  // Handle URL change
  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setServerUrl(e.target.value);
  };
  
  // Reset URL to default
  const handleResetUrl = () => {
    setServerUrl(getSyncWebSocketUrl());
  };
  
  // Handle processing queued changes
  const handleProcessQueuedChanges = () => {
    processQueuedChanges()
      .catch(error => console.error('Error processing queued changes:', error));
  };
  
  // Handle clearing the change queue
  const handleClearChangeQueue = async () => {
    try {
      // Get the SyncManager instance
      const syncManagerInstance = SyncManager.getInstance();
      
      // Get the OutgoingChangeProcessor
      const outgoingProcessor = syncManagerInstance.getOutgoingChangeProcessor();
      
      // Call the method to clear changes on the processor
      if (outgoingProcessor) {
        await outgoingProcessor.clearUnprocessedChanges();
        console.log('Successfully cleared the change queue via OutgoingChangeProcessor.');
      } else {
        console.error('OutgoingChangeProcessor is not available.');
      }
      
      // Force a re-render to update the queue size display
      setLastUpdate(new Date());
    } catch (error) {
      console.error('Error clearing change queue via OutgoingChangeProcessor:', error);
      // Optionally, display an error message to the user here
    }
  };
  
  // Handle initiating a full entity resync
  const handleOpenResyncDialog = () => {
    setResyncDialogOpen(true);
  };
  
  // Handle confirming the resync
  const handleConfirmResync = async () => {
    try {
      setIsResyncing(true);
      setResyncDialogOpen(false);
      setResyncProgress({ current: 0, total: null });
      
      // Call the resync function
      const totalProcessed = await resyncAllEntities();
      
      console.log(`Successfully resynced ${totalProcessed} entities`);
      setResyncProgress({ current: totalProcessed, total: totalProcessed });
    } catch (error) {
      console.error('Error during full entity resync:', error);
    } finally {
      setIsResyncing(false);
    }
  };
  
  // refresh this component more frequently to ensure debug display is accurate
  useEffect(() => {
    const intervalId = setInterval(() => {
      // Force a re-render to get fresh sync state
      setLastUpdate(new Date());
    }, 1000); // Update every second

    return () => clearInterval(intervalId);
  }, []);

  // Get status badge color based on state
  const getStatusBadgeProps = (state: string): { variant: "default" | "destructive" | "secondary" | "outline", className?: string } => {
    switch (state.toLowerCase()) {
      case 'live': return { variant: 'default', className: 'bg-green-500 text-white hover:bg-green-600' }; // Changed for live state
      case 'initializing': return { variant: 'secondary' };
      case 'syncing':
      case 'catchup': 
      case 'initial':
        return { variant: 'outline', className: 'text-blue-600 border-blue-600' }; // Example: make sync states blue
      case 'connecting':
        return { variant: 'secondary' };
      case 'disconnected': return { variant: 'destructive' };
      default: return { variant: 'secondary' };
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Sync Status</h3>
        {pendingChanges > 0 && (
          <Badge variant="outline" className="ml-2">
            {pendingChanges} pending
          </Badge>
        )}
      </div>

      {isLoading ? (
        <Alert>
          <AlertDescription>Loading sync metadata...</AlertDescription>
        </Alert>
      ) : (
        <>
          {/* Connection URL and controls */}
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1 flex gap-2">
              <Input
                value={serverUrl}
                onChange={handleUrlChange}
                placeholder="WebSocket URL"
                className="flex-1"
              />
              <Button 
                variant="outline" 
                onClick={handleResetUrl}
                title="Reset to default URL"
                size="sm"
              >
                Reset
              </Button>
            </div>
            <div className="flex gap-2">
              <Button 
                onClick={handleConnect} 
                disabled={isConnecting || isConnected}
                variant="default"
              >
                {isConnecting ? 'Connecting...' : 'Connect'}
              </Button>
              
              <Button 
                onClick={disconnect} 
                disabled={!isConnected}
                variant="destructive"
              >
                Disconnect
              </Button>
            </div>
          </div>

          {/* Status indicators */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Card className="overflow-hidden">
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">WebSocket</div>
                <div className="font-medium">
                  {isConnected ? (
                    <Badge variant="default" className="mt-1 bg-green-500">Connected</Badge>
                  ) : (
                    <Badge variant="destructive" className="mt-1">Disconnected</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
            
            <Card className="overflow-hidden">
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">Sync State</div>
                <div className="font-medium">
                  <Badge 
                    {...getStatusBadgeProps(syncState)} // Spread the props
                    className={`mt-1 ${getStatusBadgeProps(syncState).className || ''}`} // Apply className
                  >
                    {formatSyncState(syncState)}
                  </Badge>
                </div>
              </CardContent>
            </Card>
            
            <Card className="overflow-hidden">
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">LSN</div>
                <div className="font-medium mt-1">
                  {lsn || '0/0'}
                </div>
              </CardContent>
            </Card>
            
            <Card className="overflow-hidden">
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">Last Sync</div>
                <div className="font-medium mt-1">
                  {lastSyncTime ? lastSyncTime.toLocaleTimeString() : 'Never'}
                </div>
              </CardContent>
            </Card>
          </div>
          
          {/* Action buttons */}
          <div className="flex flex-wrap gap-2">
            <Button 
              onClick={resetLSN}
              variant="outline"
              title="Reset LSN to 0/0 to force full resync"
              size="sm"
            >
              Reset LSN
            </Button>
            
            <Button 
              onClick={handleProcessQueuedChanges}
              variant="default"
              disabled={pendingChanges === 0}
              title="Process queued changes manually"
              size="sm"
            >
              Process Changes {pendingChanges > 0 && `(${pendingChanges})`}
            </Button>
            
            <Button 
              onClick={handleClearChangeQueue}
              variant="destructive"
              title="Emergency: Clear the change processing queue"
              disabled={pendingChanges === 0}
              size="sm"
            >
              Clear Queue
            </Button>
            
            <Button
              onClick={handleOpenResyncDialog}
              variant="destructive"
              title="Emergency: Resync all entities from scratch"
              disabled={!isConnected || syncState !== 'live' || isResyncing}
              size="sm"
            >
              Resync All Entities
            </Button>
          </div>
          
          {/* Resync progress */}
          {isResyncing && (
            <div className="mt-4">
              <div className="flex justify-between mb-2">
                <span className="text-sm font-medium">Resyncing entities...</span>
                {resyncProgress.current > 0 && (
                  <span className="text-sm text-muted-foreground">
                    {resyncProgress.current} {resyncProgress.total ? `/ ${resyncProgress.total}` : ''} entities
                  </span>
                )}
              </div>
              <Progress value={resyncProgress.total ? (resyncProgress.current / resyncProgress.total) * 100 : undefined} />
            </div>
          )}
          
          {/* Confirmation Dialog */}
          <Dialog open={resyncDialogOpen} onOpenChange={setResyncDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Confirm Full Entity Resync</DialogTitle>
                <DialogDescription>
                  This will resend all local entities to the server as new inserts, regardless of whether they've been synced before. 
                  The server will handle conflict resolution. This operation may take some time and increase server load.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => setResyncDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleConfirmResync}
                >
                  Resync All Entities
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          
          {/* Debug information */}
          {showDetailedStats && (
            <>
              <Separator className="my-4" />
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Debug Info</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                  <div className="overflow-hidden text-ellipsis">
                    <span className="text-muted-foreground">Client ID:</span>{' '}
                    <span className="font-mono">{clientId}</span>
                  </div>
                  
                  <div>
                    <span className="text-muted-foreground">Context State:</span>{' '}
                    <span>{syncState}</span>
                  </div>
                  
                  <div>
                    <span className="text-muted-foreground">Last Update:</span>{' '}
                    <span>{lastUpdate.toLocaleTimeString()}</span>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
} 