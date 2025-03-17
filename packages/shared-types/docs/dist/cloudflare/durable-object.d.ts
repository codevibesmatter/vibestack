import type { Env } from './types';
/**
 * Base Durable Object class with type safety
 */
export declare abstract class TypedDurableObject {
    protected readonly state: DurableObjectState;
    protected readonly env: Env;
    constructor(state: DurableObjectState, env: Env);
    /**
     * Handle HTTP requests
     */
    fetch(request: Request): Promise<Response>;
    /**
     * Handle WebSocket connections
     */
    protected handleWebSocket(request: Request): Promise<Response>;
    /**
     * Handle HTTP requests (to be implemented by subclasses)
     */
    protected abstract handleRequest(request: Request): Promise<Response>;
    /**
     * Handle WebSocket messages (to be implemented by subclasses)
     */
    protected abstract handleWebSocketMessage(ws: WebSocket, event: MessageEvent): Promise<void>;
    /**
     * Handle WebSocket close
     */
    protected handleWebSocketClose(ws: WebSocket, event: CloseEvent): void;
    /**
     * Handle WebSocket errors
     */
    protected handleWebSocketError(ws: WebSocket, event: Event): void;
    /**
     * Helper to run code with concurrency control
     */
    protected withConcurrencyControl<T>(callback: () => Promise<T>): Promise<T>;
    /**
     * Helper to run code in a transaction
     */
    protected withTransaction<T>(callback: (txn: DurableObjectTransaction) => Promise<T>): Promise<T>;
    /**
     * Helper to store data
     */
    protected store<T>(key: string, value: T): Promise<void>;
    /**
     * Helper to retrieve data
     */
    protected retrieve<T>(key: string): Promise<T | undefined>;
    /**
     * Helper to delete data
     */
    protected remove(key: string): Promise<boolean>;
}
