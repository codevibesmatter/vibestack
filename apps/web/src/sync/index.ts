/**
 * Worker-based Sync Module
 * 
 * This module provides a simplified, worker-based implementation of the sync functionality.
 * It uses Web Workers to handle WebSocket connections and sync message processing
 * in a separate thread, improving performance and reliability.
 */

import { workerManager } from './worker-manager';
import { ChangesInterface } from './changes/changes-interface';
import { SyncInterface } from './main-interface';
import { 
  ConnectionState, 
  ServerChange, 
  SyncEvent 
} from './message-types';
import { 
  initSync,
  getSyncServiceStatus,
  cleanupSyncService,
  isSyncInitialized,
  isSyncConnected,
  isSyncConnecting,
  getSyncConnectionError,
  resetSyncLSN
} from './service';

// Export types
export type { 
  ConnectionState,
  ServerChange,
  SyncEvent
};

// Export service functions
export {
  initSync,
  getSyncServiceStatus,
  cleanupSyncService,
  isSyncInitialized,
  isSyncConnected,
  isSyncConnecting,
  getSyncConnectionError,
  resetSyncLSN
};

// Initialize the sync system
export function initializeSync(): boolean {
  return workerManager.initialize();
}

// Connect to the sync server
export async function connectToSyncServer(wsUrl: string): Promise<boolean> {
  return workerManager.connect(wsUrl);
}

// Disconnect from the sync server
export function disconnectFromSyncServer(reason?: string): boolean {
  return workerManager.disconnect(reason);
}

// Clean up sync resources
export function cleanupSync(): void {
  workerManager.terminate();
}

// Reset LSN and trigger fresh sync
export async function resetLSN(): Promise<void> {
  const syncInterface = SyncInterface.getInstance();
  return syncInterface.resetLSN();
}

// Subscribe to changes
export function onChanges(callback: (data: { changes: ServerChange[]; lsn?: string }) => void): void {
  const changesInterface = ChangesInterface.getInstance();
  changesInterface.onChanges(callback);
}

// Unsubscribe from changes
export function offChanges(callback: (data: { changes: ServerChange[]; lsn?: string }) => void): void {
  const changesInterface = ChangesInterface.getInstance();
  changesInterface.offChanges(callback);
}

// Subscribe to sync events
export function onSyncEvent(event: SyncEvent, callback: (data: any) => void): void {
  workerManager.on(event, callback);
}

// Unsubscribe from sync events
export function offSyncEvent(event: SyncEvent, callback: (data: any) => void): void {
  workerManager.off(event, callback);
}

// Send a message to the sync server
export function sendMessage(type: string, payload: any): void {
  workerManager.sendMessage('send_message', { type, payload });
} 