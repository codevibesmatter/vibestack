import type { Context as HonoContext } from 'hono';
import type { Env, ExecutionContext } from './env';

/**
 * Type for Hono bindings that includes our environment
 */
export type AppBindings = {
  Bindings: Env;
};

/**
 * Type for Hono context with our environment
 */
export type AppContext = HonoContext<AppBindings>;

/**
 * Minimal context type for DurableObjects and other non-HTTP contexts
 * Contains only the essential properties needed for database operations and other core functionality
 */
export interface MinimalContext {
  env: Env;
  executionCtx: ExecutionContext;
}

/**
 * Create a minimal context for database operations and other core functionality
 * This is specifically for use in DurableObjects and other non-HTTP contexts
 * that need access to environment and execution context
 */
export function createMinimalContext(env: Env, executionCtx: ExecutionContext): MinimalContext {
  return {
    env,
    executionCtx
  };
}

/**
 * Type guard to check if a context is a minimal context
 */
export function isMinimalContext(context: unknown): context is MinimalContext {
  return (
    typeof context === 'object' &&
    context !== null &&
    'env' in context &&
    'executionCtx' in context
  );
} 