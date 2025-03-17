/**
 * Environment variables and bindings for the application
 */
export interface Env {
    TINYBASE_STORE: DurableObjectNamespace;
    NODE_ENV: 'development' | 'production' | 'test';
    LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
    MAX_CONCURRENT_REQUESTS?: number;
    REQUEST_TIMEOUT_MS?: number;
    MAX_PAYLOAD_SIZE?: number;
    JWT_SECRET: string;
    CORS_ORIGINS: string[];
    RATE_LIMIT_REQUESTS?: number;
    RATE_LIMIT_WINDOW_MS?: number;
    ENABLE_WEBSOCKETS?: boolean;
    ENABLE_METRICS?: boolean;
    ENABLE_TRACING?: boolean;
}
/**
 * Runtime environment type
 */
export type RuntimeEnv = 'development' | 'production' | 'test';
/**
 * Log level type
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/**
 * Environment configuration options
 */
export interface EnvConfig {
    nodeEnv: RuntimeEnv;
    logLevel: LogLevel;
    maxConcurrentRequests: number;
    requestTimeoutMs: number;
    maxPayloadSize: number;
    jwtSecret: string;
    corsOrigins: string[];
    rateLimitRequests: number;
    rateLimitWindowMs: number;
    enableWebsockets: boolean;
    enableMetrics: boolean;
    enableTracing: boolean;
}
/**
 * Default environment configuration
 */
export declare const DEFAULT_ENV_CONFIG: EnvConfig;
