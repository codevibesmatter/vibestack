type SrvMessageType = 'srv_changes' | 'srv_changes_received' | 'srv_changes_applied' | 'srv_sync_init' | 'srv_heartbeat' | 'srv_error';
type CltMessageType = 'clt_sync_request' | 'clt_changes' | 'clt_changes_received' | 'clt_changes_applied' | 'clt_heartbeat' | 'clt_error';

/**
 * Core change type for replication
 * Represents a change to a table that needs to be replicated
 */
interface TableChange {
    table: string;
    operation: 'insert' | 'update' | 'delete';
    data: Record<string, unknown>;
    lsn: string;
    updated_at: string;
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

export { type ClientDeregistration, type ClientRegistration, type CltMessageType, type SrvMessageType, type TableChange, isTableChange };
