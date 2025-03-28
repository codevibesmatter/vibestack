/**
 * Core change type for replication
 * Represents a change to a table that needs to be replicated
 */
interface TableChange$1 {
    table: string;
    operation: 'insert' | 'update' | 'delete';
    data: Record<string, unknown>;
    updated_at: string;
}

type SrvMessageType = 'srv_send_changes' | 'srv_catchup_changes' | 'srv_live_changes' | 'srv_init_start' | 'srv_init_changes' | 'srv_init_complete' | 'srv_heartbeat' | 'srv_error' | 'srv_state_change' | 'srv_lsn_update' | 'srv_changes_received' | 'srv_changes_applied' | 'srv_sync_completed' | 'srv_catchup_completed';
type CltMessageType = 'clt_sync_request' | 'clt_send_changes' | 'clt_heartbeat' | 'clt_error' | 'clt_changes_received' | 'clt_changes_applied' | 'clt_init_received' | 'clt_init_processed' | 'clt_catchup_received';
interface BaseMessage {
    messageId: string;
    timestamp: number;
    clientId: string;
}
interface ServerMessage extends BaseMessage {
    type: SrvMessageType;
}
interface ServerChangesMessage extends ServerMessage {
    type: 'srv_send_changes' | 'srv_catchup_changes' | 'srv_live_changes';
    changes: TableChange$1[];
    lastLSN: string;
    sequence?: {
        chunk: number;
        total: number;
    };
}
interface ServerInitChangesMessage extends ServerMessage {
    type: 'srv_init_changes';
    changes: TableChange$1[];
    sequence: {
        table: string;
        chunk: number;
        total: number;
    };
}
interface ServerInitStartMessage extends ServerMessage {
    type: 'srv_init_start';
    serverLSN: string;
}
interface ServerInitCompleteMessage extends ServerMessage {
    type: 'srv_init_complete';
    serverLSN: string;
}
interface ServerStateChangeMessage extends ServerMessage {
    type: 'srv_state_change';
    state: 'initial' | 'catchup' | 'live';
    lsn: string;
}
interface ServerLSNUpdateMessage extends ServerMessage {
    type: 'srv_lsn_update';
    lsn: string;
}
interface ServerReceivedMessage extends ServerMessage {
    type: 'srv_changes_received';
    changeIds: string[];
}
interface ServerAppliedMessage extends ServerMessage {
    type: 'srv_changes_applied';
    appliedChanges: string[];
    success: boolean;
    error?: string;
}
interface ServerSyncCompletedMessage extends ServerMessage {
    type: 'srv_sync_completed';
    startLSN: string;
    finalLSN: string;
    changeCount: number;
    success: boolean;
    error?: string;
}
interface ServerCatchupCompletedMessage extends ServerMessage {
    type: 'srv_catchup_completed';
    startLSN: string;
    finalLSN: string;
    changeCount: number;
    success: boolean;
    error?: string;
}
interface ClientMessage extends BaseMessage {
    type: CltMessageType;
}
interface ClientChangesMessage extends ClientMessage {
    type: 'clt_send_changes';
    changes: TableChange$1[];
}
interface ClientHeartbeatMessage extends ClientMessage {
    type: 'clt_heartbeat';
    state?: string;
    lsn: string;
    active: boolean;
}
interface ClientReceivedMessage extends ClientMessage {
    type: 'clt_changes_received';
    changeIds: string[];
    lastLSN: string;
}
interface ClientAppliedMessage extends ClientMessage {
    type: 'clt_changes_applied';
    changeIds: string[];
    lastLSN: string;
}
interface ClientInitReceivedMessage extends ClientMessage {
    type: 'clt_init_received';
    table: string;
    chunk: number;
}
interface ClientInitProcessedMessage extends ClientMessage {
    type: 'clt_init_processed';
}
type Message = ServerMessage | ServerCatchupCompletedMessage | ClientMessage;

/**
 * Core change type for replication
 * Represents a change to a table that needs to be replicated
 */
interface TableChange {
    table: string;
    operation: 'insert' | 'update' | 'delete';
    data: Record<string, unknown>;
    lsn?: string;
    updated_at: string;
}
/**
 * Strongly typed record data for sync operations
 * Represents the common fields expected in all records
 */
interface RecordData {
    id: string;
    client_id: string;
    updated_at: string;
    [key: string]: unknown;
}
/**
 * Result of executing a client change
 */
interface ExecutionResult {
    success: boolean;
    error?: {
        code: string;
        message: string;
        details?: any;
    };
    data?: any;
    isConflict?: boolean;
    skipped?: boolean;
}

/**
 * Client registration types for managing sync clients
 */
interface ClientRegistration {
    clientId: string;
    timestamp: string;
}
interface ClientDeregistration {
    clientId: string;
}
declare function isTableChange(payload: unknown): payload is TableChange;
declare function isClientMessageType(type: string): type is CltMessageType;

export { type BaseMessage, type ClientAppliedMessage, type ClientChangesMessage, type ClientDeregistration, type ClientHeartbeatMessage, type ClientInitProcessedMessage, type ClientInitReceivedMessage, type ClientMessage, type ClientReceivedMessage, type ClientRegistration, type CltMessageType, type ExecutionResult, type Message, type RecordData, type ServerAppliedMessage, type ServerCatchupCompletedMessage, type ServerChangesMessage, type ServerInitChangesMessage, type ServerInitCompleteMessage, type ServerInitStartMessage, type ServerLSNUpdateMessage, type ServerMessage, type ServerReceivedMessage, type ServerStateChangeMessage, type ServerSyncCompletedMessage, type SrvMessageType, type TableChange, isClientMessageType, isTableChange };
