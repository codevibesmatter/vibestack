import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';

/**
 * Base environment configuration interface
 */
export type RuntimeEnv = 'development' | 'production' | 'test';
export type LogLevel = 'error' | 'debug' | 'info' | 'warn';

export interface EnvBindings {
  NODE_ENV: RuntimeEnv;
  LOG_LEVEL: LogLevel;
  API_VERSION: string;
  DATABASE_URL: string;
  CORS_ORIGINS: string[];
  JWT_SECRET: string;
  DEBUG?: boolean;
  API_URL: string;
  // Durable Object bindings
  SYNC: DurableObjectNamespace;
  REPLICATION: DurableObjectNamespace;
  // KV namespace bindings
  CLIENT_REGISTRY: KVNamespace;
  // Queue bindings
  WAL_QUEUE: Queue<WALQueueMessage>;
  WAL_DLQ: Queue<WALQueueMessage>;
}

// For direct env access (like in index.ts)
export type Env = EnvBindings;

// For API routes where env is accessed via c.env
export interface ApiEnv {
  Bindings: EnvBindings;
}

export interface EnvConfig extends Env {
  MAX_CONCURRENT_REQUESTS?: number;
  REQUEST_TIMEOUT_MS?: number;
  MAX_PAYLOAD_SIZE?: number;
  RATE_LIMIT_REQUESTS?: number;
  RATE_LIMIT_WINDOW_MS?: number;
  ENABLE_WEBSOCKETS?: boolean;
  ENABLE_METRICS?: boolean;
  ENABLE_TRACING?: boolean;
}

// Re-export BaseEnvConfig for backward compatibility
export type BaseEnvConfig = EnvConfig;

// Queue message types
export interface WALQueueMessage {
  changes: any[]
  timestamp: number
}

export interface WALMessage {
  lsn: string;
  changes: WALChange[];
  schema_version: string;
  transaction_id: string;
  metadata: {
    timestamp: string;
    source: string;
    client_id?: string;
  };
}

export interface WALChange {
  table: string;
  operation: 'insert' | 'update' | 'delete' | 'unknown';
  data: Record<string, any>;
  old_data?: Record<string, any>;
}

export interface Change {
  table: string;
  operation: string;
  data: any;
  old_data: any;
}

interface Queue<T> {
  send: (message: T) => Promise<void>
  receive: () => Promise<T | null>
} 