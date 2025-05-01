import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { SyncManager, SyncState } from './SyncManager';
import { SyncChangeManager } from './SyncChangeManager.typeorm';
import { getSyncWebSocketUrl } from './config';
import { usePGliteContext } from '../db/pglite-provider';

// Define props for the SyncProvider component
interface SyncProviderProps {
  children: React.ReactNode;
  autoConnect?: boolean;
}

// Define the context shape
export interface SyncContextState {
  isConnected: boolean;
  syncState: SyncState;
  lsn: string;
  pendingChanges: number;
  lastSyncTime: Date | null;
  clientId: string;
  connect: (url?: string) => Promise<boolean>;
  disconnect: () => void;
  resetLSN: () => Promise<void>;
  serverUrl: string;
  setServerUrl: (url: string) => void;
  isLoading: boolean;
  processQueuedChanges: () => Promise<void>;
  setAutoConnect: (value: boolean) => void;
}

// Create context with default values
const SyncContext = createContext<SyncContextState>({
  isConnected: false,
  syncState: 'disconnected',
  lsn: '0/0',
  pendingChanges: 0,
  lastSyncTime: null,
  clientId: '',
  connect: async () => false,
  disconnect: () => {},
  resetLSN: async () => {},
  serverUrl: '',
  setServerUrl: () => {},
  isLoading: true,
  processQueuedChanges: async () => {},
  setAutoConnect: () => {}
});

// Provider component
export const SyncProvider: React.FC<SyncProviderProps> = ({ children, autoConnect = true }) => {
  // State to track database and sync initialization
  const [isLoading, setIsLoading] = useState(true);
  const [syncManager, setSyncManager] = useState<SyncManager | null>(null);
  const [changeManager, setChangeManager] = useState<SyncChangeManager | null>(null);
  
  // Use the PGlite context to check database status
  const { isReady: isDatabaseReady, isLoading: isDatabaseLoading } = usePGliteContext();
  
  // Initialize sync managers only after database is ready
  useEffect(() => {
    if (!isDatabaseReady) {
      console.log('SyncContext: Waiting for database to be ready before initializing sync');
      return;
    }
    
    console.log('SyncContext: Database is ready, initializing SyncManager');
    
    // Initialize the managers now that the database is ready
    const syncManagerInstance = SyncManager.getInstance();
    setSyncManager(syncManagerInstance);
    
    // Also initialize the SyncChangeManager
    const changeManagerInstance = SyncChangeManager.getInstance();
    setChangeManager(changeManagerInstance);
    
  }, [isDatabaseReady]);
  
  // Configure auto-connect based on props
  useEffect(() => {
    if (!syncManager) return;
    syncManager.setAutoConnect(autoConnect);
  }, [autoConnect, syncManager]);
  
  // Keep the latest values in refs to avoid race conditions
  const latestSyncState = useRef<SyncState>('disconnected');
  const latestLSN = useRef<string>('0/0');
  const latestConnected = useRef<boolean>(false);
  const latestClientId = useRef<string>('');
  const latestPendingChanges = useRef<number>(0);
  
  // State for sync status
  const [state, setState] = useState({
    isConnected: false,
    syncState: 'disconnected' as SyncState,
    lsn: '0/0',
    pendingChanges: 0,
    lastSyncTime: null as Date | null,
    clientId: ''
  });
  
  // State for server URL
  const [serverUrl, setServerUrl] = useState<string>(getSyncWebSocketUrl());
  
  // Update state function - pulls directly from refs to ensure latest state
  const updateState = (forceUpdate = false) => {
    const newState = {
      isConnected: latestConnected.current,
      syncState: latestSyncState.current,
      lsn: latestLSN.current,
      pendingChanges: latestPendingChanges.current,
      lastSyncTime: new Date(),
      clientId: latestClientId.current
    };
    
    // Update state and log any changes for debugging
    setState(prev => {
      if (
        forceUpdate || 
        prev.isConnected !== newState.isConnected ||
        prev.syncState !== newState.syncState ||
        prev.lsn !== newState.lsn ||
        prev.pendingChanges !== newState.pendingChanges ||
        prev.clientId !== newState.clientId
      ) {
        return newState;
      }
      return prev;
    });
  };
  
  // Initialize sync system and set up listeners when syncManager is available
  useEffect(() => {
    if (!syncManager) return;
    
    console.log('SyncContext: Starting initialization sequence with SyncManager');
    
    // Initialize the sync manager asynchronously 
    const init = async () => {
      try {
        // Wait for sync manager to fully initialize
        await syncManager.initialize();
        
        // Set our initial state now that everything is initialized
        latestSyncState.current = syncManager.getState();
        latestLSN.current = syncManager.getLSN();
        latestConnected.current = syncManager.isConnected();
        latestClientId.current = syncManager.getClientId();
        latestPendingChanges.current = syncManager.getPendingChangesCount();
        
        console.log(`SyncContext: Context initialization complete - clientId: ${latestClientId.current}, LSN: ${latestLSN.current}`);
        
        updateState(true);
        setIsLoading(false);
        
        // Set up direct event handlers for state-critical events
        const handleStateChange = (state: SyncState) => {
          latestSyncState.current = state;
          updateState(true);
        };
        
        const handleLSNUpdate = (lsn: string) => {
          latestLSN.current = lsn;
          updateState();
        };
        
        const handleConnection = (connected: boolean) => {
          latestConnected.current = connected;
          updateState();
        };
        
        const handleWebSocketOpen = (event: any) => {
          handleConnection(true);
        };
        
        const handleWebSocketClose = (event: any) => {
          handleConnection(false);
        };
        
        const handlePendingChangesUpdate = (count: number) => {
          if (count > 0 && process.env.NODE_ENV !== 'production') {
            console.debug(`SyncContext: Pending changes count updated to ${count}`);
          }
          latestPendingChanges.current = count;
          updateState();
        };
        
        // Register for all relevant events
        syncManager.on('stateChange', handleStateChange);
        syncManager.on('lsnUpdate', handleLSNUpdate);
        syncManager.on('connection:status', handleConnection);
        syncManager.on('websocket:open', handleWebSocketOpen);
        syncManager.on('websocket:close', handleWebSocketClose);
        syncManager.on('pendingChangesUpdate', handlePendingChangesUpdate);
        
        // If auto-connect is enabled, trigger it now
        if (autoConnect) {
          console.debug('SyncContext: Auto-connect enabled');
          // Wait a moment for event handlers to be properly registered
          setTimeout(async () => {
            try {
              // Call the proper auto-connect method which has internal checks
              await syncManager.autoConnectToServer();
              
              // No additional success log - SyncManager already logs this
            } catch (err) {
              console.error('SyncContext: Auto-connect failed, scheduling retry');
              
              // Schedule a single retry after 3 seconds
              setTimeout(async () => {
                try {
                  // Retry with the auto-connect method as well
                  await syncManager.autoConnectToServer();
                  // No additional success log
                } catch (retryErr) {
                  console.error('SyncContext: Auto-connect retry also failed');
                  // No more retries - user will need to connect manually
                }
              }, 3000);
            }
          }, 1000); // Delay slightly to ensure listeners are attached
        }
        
        // Cleanup on unmount
        return () => {
          // Unregister all event listeners
          syncManager.off('stateChange', handleStateChange);
          syncManager.off('lsnUpdate', handleLSNUpdate);
          syncManager.off('connection:status', handleConnection);
          syncManager.off('websocket:open', handleWebSocketOpen);
          syncManager.off('websocket:close', handleWebSocketClose);
          syncManager.off('pendingChangesUpdate', handlePendingChangesUpdate);
        };
      } catch (error) {
        console.error('SyncContext: Error during initialization', error);
        setIsLoading(false);
      }
    };
    
    // Start the initialization process
    init();
    
    // No immediate cleanup needed since it's handled in the inner async function
    return () => {};
  }, [syncManager, autoConnect, serverUrl]);
  
  // Define handlers for context actions
  const handleConnect = async (url?: string): Promise<boolean> => {
    if (!syncManager) return false;
    
    try {
      const connectUrl = url || serverUrl;
      
      if (url) {
        setServerUrl(url);
      }
      
      return await syncManager.connect(connectUrl);
    } catch (error) {
      console.error('SyncContext: Connect error', error);
      return false;
    }
  };
  
  const handleDisconnect = () => {
    if (!syncManager) return;
    syncManager.disconnect();
  };
  
  const handleResetLSN = async () => {
    if (!syncManager) return;
    await syncManager.resetLSN();
  };
  
  const handleProcessQueuedChanges = async () => {
    if (!changeManager) return;
    await changeManager.processQueuedChanges();
  };
  
  const handleSetAutoConnect = (value: boolean) => {
    if (!syncManager) return;
    syncManager.setAutoConnect(value);
  };
  
  // Show a loading state if database or sync is still loading
  if (isDatabaseLoading || (isLoading && !syncManager)) {
    return (
      <SyncContext.Provider value={{
        ...state,
        connect: handleConnect,
        disconnect: handleDisconnect,
        resetLSN: handleResetLSN,
        serverUrl,
        setServerUrl,
        isLoading: true,
        processQueuedChanges: handleProcessQueuedChanges,
        setAutoConnect: handleSetAutoConnect
      }}>
        {children}
      </SyncContext.Provider>
    );
  }
  
  // Provide the context value with all state and handlers
  return (
    <SyncContext.Provider value={{
      ...state,
      connect: handleConnect,
      disconnect: handleDisconnect,
      resetLSN: handleResetLSN,
      serverUrl,
      setServerUrl,
      isLoading: isLoading || !syncManager,
      processQueuedChanges: handleProcessQueuedChanges,
      setAutoConnect: handleSetAutoConnect
    }}>
      {children}
    </SyncContext.Provider>
  );
};

// Custom hook for consuming the context
export const useSyncContext = () => useContext(SyncContext); 