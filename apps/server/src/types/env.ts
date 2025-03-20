import type { DurableObjectNamespace, KVNamespace } from './cloudflare';

/**
 * Environment types for Cloudflare Workers
 */

// ExecutionContext for waitUntil operations
export interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
  props: any;
}

export type DeploymentEnv = 'development' | 'staging' | 'production';
export type LogLevel = 'error' | 'debug' | 'info' | 'warn';

/**
 * Environment configuration and bindings
 * Used directly for Workers and wrapped in { Bindings: Env } for Hono routes
 * 
 * Note: The index signature [key: string]: unknown is required for compatibility with Hono's Env type
 */
export interface Env {
  // Deployment environment (set by Cloudflare Workers)
  ENVIRONMENT: DeploymentEnv;

  // Database connection info
  DATABASE_URL: string;
  API_URL: string;
  NEON_API_KEY: string;
  TYPEORM_LOGGING: boolean;
  NODE_ENV: string;
  
  // Durable Object bindings (from wrangler.toml)
  SYNC: DurableObjectNamespace; 
  REPLICATION: DurableObjectNamespace;
  
  // KV namespace bindings (from wrangler.toml)
  CLIENT_REGISTRY: KVNamespace;

  // Required for Hono compatibility
  [key: string]: unknown;
} 