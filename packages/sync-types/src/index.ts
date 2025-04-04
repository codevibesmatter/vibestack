import type { 
  CltMessageType, 
  SrvMessageType,
  BaseMessage,
  ServerMessage,
  ServerChangesMessage,
  ServerInitChangesMessage,
  ServerInitStartMessage,
  ServerInitCompleteMessage,
  ServerStateChangeMessage,
  ServerLSNUpdateMessage,
  ServerReceivedMessage,
  ServerAppliedMessage,
  ServerSyncCompletedMessage,
  ServerCatchupCompletedMessage,
  ServerSyncStatsMessage,
  ClientMessage,
  ClientChangesMessage,
  ClientHeartbeatMessage,
  ClientReceivedMessage,
  ClientAppliedMessage,
  ClientInitReceivedMessage,
  ClientInitProcessedMessage,
  Message
} from './messages';

/**
 * Core change type for replication
 * Represents a change to a table that needs to be replicated
 */
export interface TableChange {
  table: string;
  operation: 'insert' | 'update' | 'delete';
  data: Record<string, unknown>;
  lsn?: string;  // Optional LSN since it's only needed for WAL-based changes
  updated_at: string;  // ISO timestamp of when the record was updated
}

/**
 * Strongly typed record data for sync operations
 * Represents the common fields expected in all records
 */
export interface RecordData {
  id: string;
  client_id: string;
  updated_at: string;
  [key: string]: unknown;  // Additional fields specific to each record type
}

/**
 * Result of executing a client change
 */
export interface ExecutionResult {
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

// Export message types and interfaces
export type {
  CltMessageType,
  SrvMessageType,
  BaseMessage,
  ServerMessage,
  ServerChangesMessage,
  ServerInitChangesMessage,
  ServerInitStartMessage,
  ServerInitCompleteMessage,
  ServerStateChangeMessage,
  ServerLSNUpdateMessage,
  ServerReceivedMessage,
  ServerAppliedMessage,
  ServerSyncCompletedMessage,
  ServerCatchupCompletedMessage,
  ServerSyncStatsMessage,
  ClientMessage,
  ClientChangesMessage,
  ClientHeartbeatMessage,
  ClientReceivedMessage,
  ClientAppliedMessage,
  ClientInitReceivedMessage,
  ClientInitProcessedMessage,
  Message
} from './messages';

/**
 * Client registration types for managing sync clients
 */
export interface ClientRegistration {
  clientId: string;
  timestamp: string;
}

export interface ClientDeregistration {
  clientId: string;
}

// Type guards
export function isTableChange(payload: unknown): payload is TableChange {
  const p = payload as TableChange;
  return p 
    && typeof p.table === 'string'
    && ['insert', 'update', 'delete'].includes(p.operation)
    && typeof p.data === 'object'
    && p.data !== null
    && (!p.lsn || typeof p.lsn === 'string')  // LSN is optional
    && typeof p.updated_at === 'string';
}

export function isClientMessageType(type: string): type is CltMessageType {
  return type.startsWith('clt_');
} 