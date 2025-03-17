/**
 * Core Cloudflare Types
 * Type definitions for Workers and Durable Objects
 */
export interface Env {
    STORE: DurableObjectNamespace;
    WAL_TRACKER: DurableObjectNamespace;
    KV_STORE: KVNamespace;
    STORAGE: R2Bucket;
    DB: D1Database;
    ENVIRONMENT: string;
    DEBUG: string;
    API_VERSION: string;
}
export interface WorkerExecutionContext {
    waitUntil(promise: Promise<any>): void;
    passThroughOnException(): void;
}
export interface ScheduledController {
    scheduledTime: number;
    cron: string;
    noRetry(): void;
}
export interface MessageBatch {
    queue: string;
    messages: Message[];
}
export interface Message {
    id: string;
    timestamp: number;
    body: unknown;
}
export interface DurableObjectState {
    blockConcurrencyWhile(callback: () => Promise<void>): Promise<void>;
    storage: DurableObjectStorage;
    id: DurableObjectId;
    waitUntil(promise: Promise<any>): void;
}
export interface DurableObjectStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
    list<T = unknown>(options?: {
        start?: string;
        startAfter?: string;
        end?: string;
        prefix?: string;
        reverse?: boolean;
        limit?: number;
    }): Promise<Map<string, T>>;
    put<T>(key: string, value: T): Promise<void>;
    put<T>(entries: Record<string, T>): Promise<void>;
    delete(key: string): Promise<boolean>;
    delete(keys: string[]): Promise<number>;
    deleteAll(): Promise<void>;
    transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T>;
}
export interface DurableObjectTransaction {
    get<T = unknown>(key: string): Promise<T | undefined>;
    get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
    list<T = unknown>(options?: {
        start?: string;
        startAfter?: string;
        end?: string;
        prefix?: string;
        reverse?: boolean;
        limit?: number;
    }): Promise<Map<string, T>>;
    put<T>(key: string, value: T): Promise<void>;
    put<T>(entries: Record<string, T>): Promise<void>;
    delete(key: string): Promise<void>;
    delete(keys: string[]): Promise<void>;
    rollback(): void;
}
export interface WebSocketMessage {
    type: 'binary' | 'text';
    data: ArrayBuffer | string;
}
export interface WebSocketEventMap {
    message: WebSocketMessage;
    close: {
        code: number;
        reason: string;
        wasClean: boolean;
    };
    error: Error;
}
export interface FetchEventInfo {
    request: Request;
    waitUntil(promise: Promise<any>): void;
    passThroughOnException(): void;
}
export interface ApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
        details?: unknown;
    };
}
export type DurableObjectNamespaceId = string | DurableObjectId;
export type StorageValue = string | number | boolean | null | undefined | StorageValue[] | {
    [key: string]: StorageValue;
};
