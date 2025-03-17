/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare platform types
 */

// Remove Env re-export since it's handled in env.ts
export type CloudflareBindings = {
  /** Durable Object bindings */
  durableObjects: Record<string, DurableObjectNamespace>;
  /** KV namespace bindings */
  kvNamespaces: Record<string, KVNamespace>;
  /** R2 bucket bindings */
  r2Buckets: Record<string, R2Bucket>;
  /** D1 database bindings */
  d1Databases: Record<string, D1Database>;
  /** Queue bindings */
  queues: Record<string, Queue>;
  /** Service bindings */
  services: Record<string, Fetcher>;
};

/**
 * Extended execution context for workers
 */
export interface WorkerExecutionContext extends ExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

/**
 * Controller for scheduled events
 */
export interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

/**
 * Message batch for queue consumers
 */
export interface MessageBatch {
  queue: string;
  messages: Array<{
    id: string;
    timestamp: number;
    body: string;
  }>;
} 