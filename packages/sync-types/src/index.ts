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
  ServerReceivedMessage,
  ServerAppliedMessage,
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
  ServerReceivedMessage,
  ServerAppliedMessage,
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