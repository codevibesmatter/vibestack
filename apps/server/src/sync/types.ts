import type { 
  TableChange,
  MessageFields,
  SyncMessageType
} from '@repo/sync-types';
import type { MinimalContext } from '../types/hono';
import type { Env } from '../types/env';
import type { SyncStateManager } from './state-manager';

/**
 * Extend WebSocket to include client data
 */
declare global {
  interface WebSocket {
    clientData?: WebSocketClientData;
  }
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
 * Message sender interface
 */
export interface MessageSender {
  send(message: MessageFields & { type: SyncMessageType }): Promise<void>;
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