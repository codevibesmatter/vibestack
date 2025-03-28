import type { 
  CltMessageType, 
  SrvMessageType, 
  TableChange,
  ServerMessage as BaseServerMessage,
  ClientMessage as BaseClientMessage,
  ServerChangesMessage as BaseServerChangesMessage,
  ServerReceivedMessage as BaseServerReceivedMessage,
  ServerAppliedMessage as BaseServerAppliedMessage,
  ServerStateChangeMessage as BaseServerStateChangeMessage
} from '@repo/sync-types';

export interface Config {
  wsUrl: string;
  baseUrl: string;
  connectTimeout: number;
  syncWaitTime: number;
  changeWaitTime: number;
  chunkTimeout?: number;
}

// Re-export message types from sync-types
export type { 
  BaseServerMessage as ServerMessage,
  BaseClientMessage as ClientMessage,
  BaseServerChangesMessage as ServerChangesMessage,
  BaseServerReceivedMessage as ServerReceivedMessage,
  BaseServerAppliedMessage as ServerAppliedMessage,
  BaseServerStateChangeMessage as ServerStateChangeMessage
};

export interface InitResponse {
  lsn: string;
  data: Record<string, TableChange[]>;
}

export interface CatchupResponse {
  changes: TableChange[];
  lastLSN: string;
  hasMore: boolean;
}

export interface TableField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date';
  nullable?: boolean;
}

export interface TableSchema {
  name: string;
  fields: TableField[];
  primaryKey: string[];
}