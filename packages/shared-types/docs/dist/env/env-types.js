"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ENV_CONFIG = void 0;
/**
 * Default environment configuration
 */
exports.DEFAULT_ENV_CONFIG = {
    nodeEnv: 'development',
    logLevel: 'info',
    maxConcurrentRequests: 100,
    requestTimeoutMs: 30000,
    maxPayloadSize: 1024 * 1024, // 1MB
    jwtSecret: 'development-secret',
    corsOrigins: ['*'],
    rateLimitRequests: 100,
    rateLimitWindowMs: 60000, // 1 minute
    enableWebsockets: true,
    enableMetrics: true,
    enableTracing: false
};
