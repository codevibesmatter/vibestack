import type { EnvConfig, DurableObjectBindings } from './env';
/**
 * Combined environment type with all bindings
 */
export interface Env extends EnvConfig, DurableObjectBindings {
    STORE: DurableObjectNamespace;
    WAL_TRACKER: DurableObjectNamespace;
    METRICS_DO: DurableObjectNamespace;
    KV_STORE: KVNamespace;
    STORAGE: R2Bucket;
    DB: D1Database;
}
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
