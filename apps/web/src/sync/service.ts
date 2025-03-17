/**
 * Sync Service
 * 
 * This module provides a standalone service for initializing and managing the sync worker
 * without requiring a React context provider.
 */

import { syncLogger, changesLogger } from '../utils/logger';
import { 
  initializeSync, 
  cleanupSync,
  onSyncEvent,
  offSyncEvent,
  disconnectFromSyncServer,
  resetLSN
} from './index';

// Track initialization state
let isInitialized = false;
let isConnected = false;
let isConnecting = false;
let connectionError: Error | null = null;

// Set up sync event listeners
onSyncEvent('status_changed', (state) => {
  isConnected = state.isConnected;
  isConnecting = state.isConnecting;
});

onSyncEvent('error', (error) => {
  connectionError = error;
});

/**
 * Initialize the sync service
 * @returns Whether initialization was successful
 */
export function initSync(): boolean {
  if (isInitialized) {
    syncLogger.warn('Sync service already initialized');
    return true;
  }
  
  changesLogger.logServiceEvent('Initializing sync service');
  
  try {
    // Initialize the sync service
    const syncInitialized = initializeSync();
    
    if (syncInitialized) {
      isInitialized = true;
      changesLogger.logServiceEvent('✅ Sync service ready - changes will be processed in sync worker');
      
      // Store initialization status in localStorage for other components
      localStorage.setItem('sync_initialized', 'true');
      
      return true;
    } else {
      syncLogger.error('❌ Failed to initialize sync service');
      return false;
    }
  } catch (error) {
    syncLogger.error('❌ Error initializing sync service', error);
    return false;
  }
}

/**
 * Get the current sync status
 * @returns The current sync status
 */
export function getSyncServiceStatus(): {
  isInitialized: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  connectionError: string | null;
} {
  return {
    isInitialized,
    isConnected,
    isConnecting,
    connectionError: connectionError?.message || null
  };
}

/**
 * Clean up sync resources
 */
export function cleanupSyncService(): void {
  try {
    syncLogger.info('Cleaning up sync service');
    
    disconnectFromSyncServer('Service cleanup');
    cleanupSync();
    isInitialized = false;
    isConnected = false;
    isConnecting = false;
    connectionError = null;
    
    // Clear initialization status from localStorage
    localStorage.removeItem('sync_initialized');
    
    syncLogger.info('✅ Sync service cleaned up successfully');
  } catch (error) {
    syncLogger.error('❌ Error cleaning up sync service', error);
  }
}

/**
 * Check if the sync service is initialized
 */
export function isSyncInitialized(): boolean {
  return isInitialized;
}

/**
 * Check if the sync service is connected
 */
export function isSyncConnected(): boolean {
  return isConnected;
}

/**
 * Check if the sync service is connecting
 */
export function isSyncConnecting(): boolean {
  return isConnecting;
}

/**
 * Get the current connection error, if any
 */
export function getSyncConnectionError(): Error | null {
  return connectionError;
}

/**
 * Reset the LSN and reconnect
 */
export async function resetSyncLSN(): Promise<boolean> {
  try {
    syncLogger.info('Resetting sync LSN');
    await resetLSN();
    syncLogger.info('✅ Sync LSN reset successfully');
    return true;
  } catch (error) {
    syncLogger.error('❌ Error resetting sync LSN', error);
    return false;
  }
} 