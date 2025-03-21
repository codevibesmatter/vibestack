import type { MinimalContext } from '../types/hono';
import type { Env } from '../types/env';
import type { SyncStateManager } from './state-manager';
import type { SrvMessageType, ServerMessage, ClientMessage, CltMessageType } from '@repo/sync-types';

/**
 * Extend WebSocket to include client data
 */
declare global {
  interface WebSocket {
    clientData?: WebSocketClientData;
  }
}

/**
 * Initial sync state tracking
 */
export interface InitialSyncState {
  table: string;
  lastChunk: number;
  totalChunks: number;
  completedTables: string[];
  status: 'in_progress' | 'processing' | 'complete';
  startLSN: string;  // LSN at start of sync process
  startTimeMs?: number; // Timestamp when sync started
}

/**
 * Context for WebSocket handlers
 */
export interface WebSocketContext {
  context: MinimalContext;
  env: Env;
  init: () => Promise<void>;
  stateManager: SyncStateManager;
}

/**
 * Client data stored on WebSocket object
 */
export interface WebSocketClientData {
  clientId: string;
  lastLSN?: string;
  lastMessageId?: string;
  lastMessageTimestamp?: number;
  connected: boolean;
  lastActivity?: number;
}

/**
 * WebSocket message handler interface compatible with SyncDO's handler
 */
export interface WebSocketHandler {
  send(message: ServerMessage): Promise<void>;
  onMessage<T extends CltMessageType>(type: T, handler: (message: ClientMessage) => Promise<void>): void;
  removeHandler(type: CltMessageType): void;
  clearHandlers(): void;
  isConnected(): boolean;
  waitForMessage(
    type: CltMessageType, 
    filter?: (msg: any) => boolean, 
    timeoutMs?: number
  ): Promise<any>;
}

/**
 * Message sender interface
 */
export interface MessageSender {
  send(message: { type: SrvMessageType; [key: string]: any }): Promise<void>;
  isConnected(): boolean;
}

/**
 * Metrics for sync monitoring
 */
export interface SyncMetrics {
  errors: Map<string, {
    count: number;
    lastError: string;
    timestamp: number;
  }>;
  connections: {
    total: number;
    active: number;
    hibernated: number;
  };
}

/**
 * Stored state for persistence
 */
export interface StoredState {
  lastProcessedLSN: string;
  metrics?: {
    errors: Array<[string, { count: number; lastError: string; timestamp: number }]>;
    connections: {
      total: number;
      active: number;
      hibernated: number;
    };
  };
} 