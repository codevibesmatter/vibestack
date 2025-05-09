import { useState, useEffect, useCallback } from 'react';
import { useSyncContext } from '@/sync/SyncContext';
import { SyncManager, SyncState } from '@/sync/SyncManager';

export type FlowStatus = 'idle' | 'sending' | 'receiving' | 'acknowledged' | 'processed' | 'error' | 'timeout';

export interface SyncVisualizationState {
  currentLsn: string;
  errorInfo: string | null;
  outgoingStatus: FlowStatus;
  incomingStatus: FlowStatus;
  currentConnectionState: 'disconnected' | 'connecting' | 'initial' | 'catchup' | 'live' | 'error';
}

export function useSyncVisualizationState(): SyncVisualizationState {
  const { isConnected, syncState } = useSyncContext();
  const [currentLsn, setCurrentLsn] = useState<string>('0/0');
  const [errorInfo, setErrorInfo] = useState<string | null>(null);
  const [outgoingStatus, setOutgoingStatus] = useState<FlowStatus>('idle');
  const [incomingStatus, setIncomingStatus] = useState<FlowStatus>('idle');

  // Keep resetStatus outside useEffect as it has stable deps
  const resetStatus = useCallback((setter: React.Dispatch<React.SetStateAction<FlowStatus>>) => {
    setTimeout(() => {
        setter('idle');
    }, 2000); 
  }, []); 

  // --- useEffect for listeners ---
  useEffect(() => {
    const manager = SyncManager.getInstance();

    // --- Define Handlers INSIDE useEffect ---
    const handleInitialized = ({ lsn }: { lsn: string }) => {
      setCurrentLsn(lsn);
    };

    const handleStateChange = ({ newState }: { newState: SyncState }) => {
      setErrorInfo(null);
    };

    const handleLsnUpdate = ({ lsn }: { lsn: string }) => {
      setCurrentLsn(lsn);
    };

    const handleError = (err: any) => {
      const errorString = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
      setErrorInfo(errorString);
      setOutgoingStatus('error'); 
      setIncomingStatus('error'); 
      resetStatus(setOutgoingStatus);
      resetStatus(setIncomingStatus);
      console.error("Sync Error:", err);
    };

    const handleDisconnect = () => {
      setOutgoingStatus('idle');
      setIncomingStatus('idle');
    };

    const handleChangeError = ({ error }: { error: any }) => {
      const errorString = typeof error === 'string' ? error : (error?.message || JSON.stringify(error));
      setErrorInfo(`Change Error: ${errorString}`);
      setOutgoingStatus('error');
      resetStatus(setOutgoingStatus);
      console.error("Sync Change Error:", error);
    };

    const handleAck = () => {
      if (errorInfo?.startsWith('Change Error:') || errorInfo?.startsWith('Change Timeout:')) {
         setErrorInfo(null);
      }
      // Short delay before setting acknowledged to allow 'sending' state to render
      setTimeout(() => {
        setOutgoingStatus('acknowledged');
        resetStatus(setOutgoingStatus);
      }, 100);
    };

    const handleMessageSent = (message: any) => {
      if (message.type === 'clt_send_changes') { 
          setOutgoingStatus('sending');
      }
    };

    const handleChangesReceived = ({ count }: { count: number }) => {
      if (count > 0) {
          setIncomingStatus('receiving');
      }
    };

    const handleIncomingProcessed = ({ success, error }: { success: boolean, error?: any }) => {
      if (success) {
          setIncomingStatus('processed');
      } else {
          setErrorInfo(`Incoming processing failed: ${error?.message || error}`);
          setIncomingStatus('error');
          console.error("Sync Incoming Processing Error:", error);
      }
      resetStatus(setIncomingStatus);
    };

    // --- Subscribe --- (Using handlers defined above)
    manager.on('stateChange', handleStateChange);
    manager.on('lsnUpdate', handleLsnUpdate);
    manager.on('error', handleError);
    manager.on('disconnected', handleDisconnect);
    manager.on('sync:message-sent', handleMessageSent);
    manager.on('changesReceived', handleChangesReceived);
    manager.events.on('sync:initialized', handleInitialized); // Listen for initialization

    manager.events.on('srv_changes_applied', handleAck);
    manager.events.on('outgoing_change_failed_on_server', handleChangeError);
    manager.events.on('incoming_changes_processed', handleIncomingProcessed);

    // Attempt to get initial LSN if SyncManager is already initialized
    // This handles cases where the hook mounts after SyncManager has initialized
    if (manager['isInitialized']) { // Accessing private member for check, consider public getter
        try {
            setCurrentLsn(manager.getLSN());
        } catch (e) {
            console.error("Error getting initial LSN (manager already initialized):", e);
        }
    }


    // --- Cleanup --- (Using handlers defined above)
    return () => {
      manager.off('stateChange', handleStateChange);
      manager.off('lsnUpdate', handleLsnUpdate);
      manager.off('error', handleError);
      manager.off('disconnected', handleDisconnect);
      manager.off('sync:message-sent', handleMessageSent);
      manager.off('changesReceived', handleChangesReceived);
      manager.events.off('sync:initialized', handleInitialized); // Unsubscribe

      manager.events.off('srv_changes_applied', handleAck);
      manager.events.off('outgoing_change_failed_on_server', handleChangeError);
      manager.events.off('incoming_changes_processed', handleIncomingProcessed);
    };
  }, []); // Empty dependency array: Ensures effect runs only once on mount

   // Determine the current animation state based on context and local state
  let currentConnectionState: SyncVisualizationState['currentConnectionState'] = 'disconnected';
  if (errorInfo && !(outgoingStatus === 'acknowledged' || incomingStatus === 'processed')) { 
    currentConnectionState = 'error';
  } else if (isConnected) {
    // Ensure syncState is a valid key for the connection state type
    const validStates: SyncVisualizationState['currentConnectionState'][] = ['initial', 'catchup', 'live'];
    if (validStates.includes(syncState as any)) {
        currentConnectionState = syncState as SyncVisualizationState['currentConnectionState'];
    } else if (syncState === 'connecting') {
        // Handle connecting state explicitly if it's different from the SyncState type used
        currentConnectionState = 'connecting'; 
    }
    // else stays disconnected if syncState is unexpected while isConnected is true (shouldn't happen)
  } else if (syncState === 'connecting') {
     currentConnectionState = 'connecting';
  }

  return {
    currentLsn,
    errorInfo,
    outgoingStatus,
    incomingStatus,
    currentConnectionState
  };
} 