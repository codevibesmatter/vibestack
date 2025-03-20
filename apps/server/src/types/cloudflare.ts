/**
 * Cloudflare Workers type definitions
 * This file provides local type definitions for Cloudflare Workers APIs
 * without relying on @cloudflare/workers-types
 */

// Durable Object related types
export interface DurableObjectId {
  toString: () => string;
  equals: (other: DurableObjectId) => boolean;
  name?: string;
}

export interface DurableObjectStorage {
  get<T = any>(key: string): Promise<T | undefined>;
  get<T = any>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  deleteAll(): Promise<void>;
  list<T = any>(options?: { prefix?: string; limit?: number; reverse?: boolean; start?: string; end?: string; }): Promise<Map<string, T>>;
  transaction<T>(callback: (txn: DurableObjectTransaction) => Promise<T>): Promise<T>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface DurableObjectTransaction {
  get<T = any>(key: string): Promise<T | undefined>;
  get<T = any>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<T = any>(options?: { prefix?: string; limit?: number; reverse?: boolean; start?: string; end?: string; }): Promise<Map<string, T>>;
  rollback(): void;
}

export interface DurableObjectState {
  waitUntil(promise: Promise<any>): void;
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  id: DurableObjectId;
  acceptWebSocket(webSocket: WebSocket): void;
  getWebSockets(): WebSocket[];
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

export interface DurableObjectNamespace<T = any> {
  newUniqueId: (options?: { jurisdiction?: string }) => DurableObjectId;
  idFromName: (name: string) => DurableObjectId;
  idFromString: (str: string) => DurableObjectId;
  get: (id: DurableObjectId) => DurableObjectStub;
}

export interface DurableObjectStub {
  fetch: (request: Request | string, init?: RequestInit) => Promise<Response>;
}

// WebSocket related types
export interface WebSocket {
  accept(): void;
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: 'message', handler: (event: { data: any }) => void): void;
  addEventListener(event: 'close', handler: (event: { code: number, reason: string }) => void): void;
  addEventListener(event: 'error', handler: (event: { error: any }) => void): void;
  readyState: number;
}

// KV related types
export interface KVNamespace {
  get: (key: string, options?: any) => Promise<string | null>;
  put: (key: string, value: string | ReadableStream | ArrayBuffer, options?: any) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: (options?: any) => Promise<any>;
} 