export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface Message {
  type: string;
  payload?: any;
  timestamp?: number;
  messageId?: string;
  clientId?: string;
}

export interface SyncMessage extends Message {
  type: 'change' | 'catchup' | 'sync' | 'ack';
}

export interface CatchupMessage {
  changes: EntityChange[];
}

export type EntityType = 'user' | 'post' | 'comment' | 'project' | 'task';
export type Operation = 'create' | 'update' | 'delete';

export interface EntityChange {
  id: string;
  type: EntityType;
  operation: Operation;
  data?: Record<string, any>;
  timestamp: number;
}

export interface MessageStats {
  total: number;
  byType: Record<string, number>;
  errors: number;
  lastError?: Error;
}

export interface ChangeStats {
  total: number;
  byType: Record<EntityType, number>;
  byOperation: Record<'create' | 'update' | 'delete', number>;
  errors: number;
  lastError?: Error;
}

export interface ReplicationStatus {
  isActive: boolean;
  currentLSN: string;
  lastError?: Error;
  lastUpdate?: Date;
}

export interface TestValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    totalChanges: number;
    processedChanges: number;
    missingChanges: number;
    duplicateChanges: number;
  };
}

export interface MissingChangeReport {
  change: EntityChange;
  reason: string;
  timestamp: number;
}

export interface DuplicateChangeReport {
  change: EntityChange;
  originalChange: EntityChange;
  timestamp: number;
}

export interface BatchConfig {
  types: EntityType[];
  counts: Record<EntityType, number>;
  operations: ('create' | 'update' | 'delete')[];
}

export interface BatchResult {
  ids: string[];
  changes: EntityChange[];
  errors: Error[];
}

export interface Config {
  wsUrl: string;
  baseUrl: string;
  connectTimeout: number;
  syncWaitTime: number;
  changeWaitTime: number;
  chunkTimeout: number;
}

export interface TestConfig {
  changeCount: number;
  timeout: number;
  customProperties?: Record<string, any>;
}

/**
 * Database record type for query results
 */
export interface DbRecord {
  [key: string]: any;
}

/**
 * LSN state storage interface
 */
export interface LSNState {
  lsn: string;
  clientId?: string;
  timestamp?: number;
}

/**
 * Test mode types
 */
export type TestMode = 'single' | 'batch' | 'custom';

/**
 * Change tracking interface
 */
export interface ChangeTracker {
  pendingChanges: {
    [entityType: string]: {
      created: string[];
      updated: string[];
      deleted: string[];
    }
  };
  receivedChanges: {
    [changeId: string]: boolean;
  };
  batchSize: number;
  batchesCreated: number;
  changeDistribution: {[key: string]: number};
  totalChangesCreated: number;
  totalChangesReceived: number;
  allChangesReceived: boolean;
  testMode: TestMode;
}

/**
 * Test statistics interface
 */
export interface TestStats {
  totalMessages: number;
  changesMessages: number;
  catchupMessages: number;
  catchupChunksReceived: number;
  catchupChunksAcknowledged: number;
  lsnUpdateMessages: number;
  syncCompletedMessages: number;
  totalChangesReceived: number;
  finalLSN: string;
  clientId?: string;
  testCompletedSuccessfully: boolean;
  changeTracker: ChangeTracker;
  errors?: Error[];
}

/**
 * WebSocket message type
 */
export interface WebSocketMessage {
  type: string;
  id?: string;
  messageId?: string;
  clientId?: string;
  timestamp?: number;
  payload?: any;
  [key: string]: any;
}

/**
 * Client message types
 */
export enum ClientMessageType {
  HEARTBEAT = 'clt_heartbeat',
  CHANGES = 'clt_changes',
  RECEIVED = 'clt_received',
  APPLIED = 'clt_applied',
  CATCHUP_RECEIVED = 'clt_catchup_received',
}

/**
 * Server message types
 */
export enum ServerMessageType {
  STATE_CHANGE = 'srv_state_change',
  LSN_UPDATE = 'srv_lsn_update',
  CHANGES = 'srv_live_changes',
  CATCHUP_CHANGES = 'srv_catchup_changes',
  RECEIVED = 'srv_received',
  APPLIED = 'srv_applied',
  SYNC_COMPLETED = 'srv_sync_completed',
  CATCHUP_COMPLETED = 'srv_catchup_completed',
  ERROR = 'srv_error',
}

/**
 * Sequence information for chunked messages
 */
export interface MessageSequence {
  chunk: number;
  total: number;
}

/**
 * Server changes message interface
 */
export interface ServerChangesMessage extends WebSocketMessage {
  type: ServerMessageType.CHANGES;
  changes: any[];
  sequence?: MessageSequence;
  lastLSN?: string;
}

/**
 * Server catchup changes message interface
 */
export interface ServerCatchupChangesMessage extends WebSocketMessage {
  type: ServerMessageType.CATCHUP_CHANGES;
  changes: any[];
  sequence?: MessageSequence;
  lastLSN?: string;
}

/**
 * Server LSN update message interface
 */
export interface ServerLSNUpdateMessage extends WebSocketMessage {
  type: ServerMessageType.LSN_UPDATE;
  lsn: string;
}

/**
 * Server sync completed message interface
 */
export interface ServerSyncCompletedMessage extends WebSocketMessage {
  type: ServerMessageType.SYNC_COMPLETED;
  success: boolean;
  changeCount: number;
  startLSN?: string;
  finalLSN: string;
}

/**
 * Server catchup completed message interface
 */
export interface ServerCatchupCompletedMessage extends WebSocketMessage {
  type: ServerMessageType.CATCHUP_COMPLETED;
  success: boolean;
  changeCount: number;
  startLSN?: string;
  finalLSN: string;
}

/**
 * Client heartbeat message interface
 */
export interface ClientHeartbeatMessage extends WebSocketMessage {
  type: ClientMessageType.HEARTBEAT;
  clientId: string;
}

/**
 * Client catchup received message interface
 */
export interface ClientCatchupReceivedMessage extends WebSocketMessage {
  type: ClientMessageType.CATCHUP_RECEIVED;
  clientId: string;
  chunk: number;
  lsn: string;
} 