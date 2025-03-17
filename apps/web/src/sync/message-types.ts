/**
 * Shared Message Types
 * 
 * Type definitions shared between main thread and worker thread.
 */

import type { TableChange } from '@repo/sync-types';

/**
 * Shared message types for communication between main thread and worker
 */

// Connection state
export interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  clientId: string | null;
  wsUrl: string | null;
  lastLSN: string;
}

// Re-export TableChange for use in the client
export type { TableChange };

// Server change types
export interface ServerChange {
  table: string;
  operation: 'insert' | 'update' | 'delete';
  data: any;
  old_data: any;
}

// Message types for worker -> main thread communication
export type WorkerToMainMessage = 
  | 'message'    // Server message received
  | 'status'     // Connection status update
  | 'error'      // Error occurred
  | 'changes'    // Changes received from server
  | 'changes_processed' // Changes processed acknowledgment
  | 'lsn_update';  // LSN update notification

// Message types for main thread -> worker communication  
export type MainToWorkerMessage = 
  | 'connect'       // Connect to server
  | 'disconnect'    // Disconnect from server
  | 'send_message'  // Send message to server
  | 'get_status'    // Get connection status
  | 'set_latest_lsn' // Update latest LSN
  | 'update_lsn'    // Update LSN after processing changes
  | 'changes_processed' // Acknowledge changes processed
  | 'sync'
  | 'client_change'; // New type for client changes

// Command payloads
export interface ConnectCommand {
  wsUrl: string;
}

export interface DisconnectCommand {
  reason?: string;
}

export interface SendMessageCommand {
  type: string;
  payload: any;
}

export interface ChangesMessage {
  changes: ServerChange[];
  lsn?: string;
}

// Generic message payload type
export interface MessagePayload {
  type: WorkerToMainMessage | MainToWorkerMessage;
  payload?: any;
}

// Sync message type
export interface SyncMessage {
  type: 'sync';
  clientId: string;
  lastLSN: string;
  forceSync?: boolean;
  resetSync?: boolean;
}

// Event types
export type SyncEvent = 
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'sync_started'
  | 'sync_completed'
  | 'reconnecting'
  | 'changes'
  | 'lsn_update'
  | 'status_changed'
  | 'network_lost'
  | 'network_restored';

// Error message type
export interface ErrorMessage {
  message: string;
  details?: any;
}

// Changes processed message type
export interface ChangesProcessedMessage {
  type: 'changes_processed';
  payload: {
    lsn?: string;
    error?: string;
  };
}

// Sync ack message type
export interface SyncAckMessage {
  type: 'sync_ack';
  clientId: string;
  lsn: string;
  error?: {
    message: string;
    details?: any;
  };
  timestamp: number;
}

// Client change message type
export interface ClientChangeMessage {
  type: 'client_change';
  clientId: string;
  change: TableChange;
  metadata?: {
    local_id?: string;
  };
}

// Client change response type
export interface ClientChangeResponse {
  type: 'client_change_ack';
  clientId: string;
  success: boolean;
  lsn?: string;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  metadata?: {
    local_id?: string;
  };
} 