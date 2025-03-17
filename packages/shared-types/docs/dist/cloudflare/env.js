"use strict";
/// <reference types="@cloudflare/workers-types" />
Object.defineProperty(exports, "__esModule", { value: true });
exports.REQUIRED_BINDINGS = void 0;
exports.validateEnvironment = validateEnvironment;
exports.createDevEnvironment = createDevEnvironment;
/**
 * Required environment bindings
 */
exports.REQUIRED_BINDINGS = [
    // Config
    'ENVIRONMENT',
    'API_VERSION',
    // DOs
    'STORE',
    'WAL_TRACKER',
    // KV
    'KV_STORE',
    'KV_CONFIG',
    // R2
    'STORAGE',
    // D1
    'DB'
];
/**
 * Environment validation
 */
function validateEnvironment(env) {
    if (!env || typeof env !== 'object') {
        throw new Error('Invalid environment configuration');
    }
    for (const key of exports.REQUIRED_BINDINGS) {
        if (!(key in env)) {
            throw new Error(`Missing required environment binding: ${key}`);
        }
    }
}
/**
 * Helper to create a typed development environment
 */
function createDevEnvironment(config = {}) {
    const env = {
        // Required config
        ENVIRONMENT: 'development',
        DEBUG: 'true',
        API_VERSION: '1.0.0',
        LOG_LEVEL: 'debug',
        // Required bindings with mock implementations
        STORE: createMockDurableObjectNamespace(),
        WAL_TRACKER: createMockDurableObjectNamespace(),
        KV_STORE: createMockKVNamespace(),
        KV_CONFIG: createMockKVNamespace(),
        STORAGE: createMockR2Bucket(),
        DB: createMockD1Database(),
        // Override with provided config
        ...config
    };
    return env;
}
// Mock implementation helpers
function createMockDurableObjectNamespace() {
    throw new Error('Mock DO namespace not implemented');
}
function createMockKVNamespace() {
    throw new Error('Mock KV namespace not implemented');
}
function createMockR2Bucket() {
    throw new Error('Mock R2 bucket not implemented');
}
function createMockD1Database() {
    throw new Error('Mock D1 database not implemented');
}
