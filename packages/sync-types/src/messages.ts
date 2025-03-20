import type { TableChange } from './table-changes';

export type SrvMessageType = 
  | 'srv_send_changes'      // Server sends changes from WAL
  | 'srv_init_start'       // Server starts initial sync
  | 'srv_init_changes'     // Server sends initial sync table data
  | 'srv_init_complete'    // Server signals initial sync is complete
  | 'srv_heartbeat'        // Server heartbeat
  | 'srv_error'           // Server error
  | 'srv_state_change'    // Server state change notification
  | 'srv_changes_received' // Server acknowledges receipt of changes
  | 'srv_changes_applied';  // Server signals changes were applied

export type CltMessageType =
  | 'clt_sync_request'      // Client requests sync
  | 'clt_send_changes'      // Client sends changes
  | 'clt_heartbeat'         // Client heartbeat
  | 'clt_error'            // Client error
  | 'clt_changes_received'  // Client acknowledges receipt of changes
  | 'clt_changes_applied'   // Client signals changes were applied
  | 'clt_init_received'    // Client acknowledges receipt of initial sync data
  | 'clt_init_processed';  // Client signals initial sync data was processed

// Base message interface for all messages
export interface BaseMessage {
  messageId: string;
  timestamp: number;
  clientId: string;
}

// Server message interfaces
export interface ServerMessage extends BaseMessage {
  type: SrvMessageType;
}

export interface ServerChangesMessage extends ServerMessage {
  type: 'srv_send_changes';
  changes: TableChange[];
  lastLSN: string;
  sequence?: {
    chunk: number;
    total: number;
  };
}

export interface ServerInitChangesMessage extends ServerMessage {
  type: 'srv_init_changes';
  changes: TableChange[];
  sequence: {
    table: string;
    chunk: number;
    total: number;
  };
}

export interface ServerInitStartMessage extends ServerMessage {
  type: 'srv_init_start';
  serverLSN: string;  // Server's current LSN at start of initial sync
}

export interface ServerInitCompleteMessage extends ServerMessage {
  type: 'srv_init_complete';
  serverLSN: string;  // Server's current LSN at end of initial sync
}

export interface ServerStateChangeMessage extends ServerMessage {
  type: 'srv_state_change';
  state: 'initial' | 'catchup' | 'live';
  lsn: string;
}

export interface ServerReceivedMessage extends ServerMessage {
  type: 'srv_changes_received';
  changeIds: string[];
}

export interface ServerAppliedMessage extends ServerMessage {
  type: 'srv_changes_applied';
  appliedChanges: string[];
  success: boolean;
  error?: string;
}

// Client message interfaces
export interface ClientMessage extends BaseMessage {
  type: CltMessageType;
}

export interface ClientChangesMessage extends ClientMessage {
  type: 'clt_send_changes';
  changes: TableChange[];
}

export interface ClientHeartbeatMessage extends ClientMessage {
  type: 'clt_heartbeat';
  state?: string;
  lsn: string;
  active: boolean;
}

export interface ClientReceivedMessage extends ClientMessage {
  type: 'clt_changes_received';
  changeIds: string[];
  lastLSN: string;
}

export interface ClientAppliedMessage extends ClientMessage {
  type: 'clt_changes_applied';
  changeIds: string[];
  lastLSN: string;
}

export interface ClientInitReceivedMessage extends ClientMessage {
  type: 'clt_init_received';
  table: string;
  chunk: number;
}

export interface ClientInitProcessedMessage extends ClientMessage {
  type: 'clt_init_processed';
}

// Union types for all messages
export type Message = ServerMessage | ClientMessage;