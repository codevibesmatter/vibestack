/**
 * Environment-specific configuration
 */
export interface EnvConfig {
    ENVIRONMENT: 'development' | 'staging' | 'production';
    DEBUG: 'true' | 'false';
    API_VERSION: string;
    LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
}
/**
 * Durable Object bindings
 */
export interface DurableObjectBindings {
    STORE: DurableObjectNamespace;
    WAL_TRACKER: DurableObjectNamespace;
    METRICS_DO: DurableObjectNamespace;
    AUTH_DO: DurableObjectNamespace;
    SYNC_DO: DurableObjectNamespace;
    BACKUP_DO: DurableObjectNamespace;
}
/**
 * KV namespace bindings
 */
export interface KVBindings {
    KV_STORE: KVNamespace;
    KV_CACHE: KVNamespace;
    KV_CONFIG: KVNamespace;
    KV_SESSIONS: KVNamespace;
}
/**
 * R2 bucket bindings
 */
export interface R2Bindings {
    STORAGE: R2Bucket;
    BACKUPS: R2Bucket;
    MEDIA: R2Bucket;
    UPLOADS: R2Bucket;
}
/**
 * D1 database bindings
 */
export interface D1Bindings {
    DB: D1Database;
    ANALYTICS_DB: D1Database;
}
/**
 * Service bindings
 */
export interface ServiceBindings {
    AUTH_SERVICE: Fetcher;
    ANALYTICS_SERVICE: Fetcher;
    METRICS_SERVICE: Fetcher;
}
/**
 * Queue bindings
 */
export interface QueueBindings {
    TASK_QUEUE: Queue;
    BACKUP_QUEUE: Queue;
    SYNC_QUEUE: Queue;
}
/**
 * Complete environment interface
 */
export interface Environment extends EnvConfig, DurableObjectBindings, KVBindings, R2Bindings, D1Bindings, ServiceBindings, QueueBindings {
}
/**
 * Required environment bindings
 */
export declare const REQUIRED_BINDINGS: readonly ["ENVIRONMENT", "API_VERSION", "STORE", "WAL_TRACKER", "KV_STORE", "KV_CONFIG", "STORAGE", "DB"];
/**
 * Environment validation
 */
export declare function validateEnvironment(env: unknown): asserts env is Environment;
/**
 * Development environment type
 */
export type RequiredBindings = typeof REQUIRED_BINDINGS[number];
export type DevEnvironment = Required<Pick<Environment, RequiredBindings>> & Partial<Omit<Environment, RequiredBindings>>;
/**
 * Helper to create a typed development environment
 */
export declare function createDevEnvironment(config?: Partial<Environment>): DevEnvironment;
