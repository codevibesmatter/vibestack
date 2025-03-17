import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';

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

  // Environment variables
  DATABASE_URL: string;
  API_URL: string;

  // Durable Object bindings (from wrangler.toml)
  SYNC: DurableObjectNamespace;
  REPLICATION: DurableObjectNamespace;

  // KV namespace bindings (from wrangler.toml)
  CLIENT_REGISTRY: KVNamespace;

  // Required for Hono compatibility
  [key: string]: unknown;
} 