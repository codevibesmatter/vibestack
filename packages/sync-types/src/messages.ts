import type { TableChange } from './table-changes';

export type SrvMessageType = 
  | 'srv_send_changes'      // Server sends changes from WAL
  | 'srv_catchup_changes'   // Server sends changes during catchup sync
  | 'srv_live_changes'      // Server sends changes during live sync
  | 'srv_init_start'       // Server starts initial sync
  | 'srv_init_changes'     // Server sends initial sync table data
  | 'srv_init_complete'    // Server signals initial sync is complete
  | 'srv_heartbeat'        // Server heartbeat
  | 'srv_error'           // Server error
  | 'srv_state_change'    // Server state change notification (deprecated)
  | 'srv_lsn_update'      // Server LSN update notification
  | 'srv_changes_received' // Server acknowledges receipt of changes
  | 'srv_changes_applied'  // Server signals changes were applied
  | 'srv_sync_completed';  // Server signals catchup sync completed with summary

export type CltMessageType =
  | 'clt_sync_request'      // Client requests sync
  | 'clt_send_changes'      // Client sends changes
  | 'clt_heartbeat'         // Client heartbeat
  | 'clt_error'            // Client error
  | 'clt_changes_received'  // Client acknowledges receipt of changes
  | 'clt_changes_applied'   // Client signals changes were applied
  | 'clt_init_received'    // Client acknowledges receipt of initial sync data
  | 'clt_init_processed'   // Client signals initial sync data was processed
  | 'clt_catchup_received'; // Client acknowledges receipt of catchup sync chunk

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
  type: 'srv_send_changes' | 'srv_catchup_changes' | 'srv_live_changes';
  changes: TableChange[];
  lastLSN: string;
  sequence?: {
    chunk: number;
    total: number;
  };
}

export interface ServerCatchupChangesMessage extends ServerChangesMessage {
  type: 'srv_catchup_changes';
}

export interface ServerLiveChangesMessage extends ServerChangesMessage {
  type: 'srv_live_changes';
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

export interface ServerLSNUpdateMessage extends ServerMessage {
  type: 'srv_lsn_update';
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

export interface ServerSyncCompletedMessage extends ServerMessage {
  type: 'srv_sync_completed';
  startLSN: string;       // Starting LSN for the sync
  finalLSN: string;       // Final LSN after sync
  changeCount: number;    // Total number of changes sent
  success: boolean;       // Whether sync completed successfully
  error?: string;         // Error message if any
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

export interface ClientCatchupReceivedMessage extends ClientMessage {
  type: 'clt_catchup_received';
  chunk: number;
  lsn: string;  // The last LSN processed in this chunk
}

// Union types for all messages
export type Message = ServerMessage | ClientMessage;

// No need for named exports since these are already exported at declaration