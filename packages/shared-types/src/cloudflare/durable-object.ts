/// <reference types="@cloudflare/workers-types" />

import type { Env } from './env';
import type { ErrorHandler } from '../error/tracking';
import type { Hono } from 'hono';

/**
 * Base Durable Object class with type safety
 */
export abstract class TypedDurableObject {
  constructor(
    protected readonly state: DurableObjectState,
    protected readonly env: Env
  ) {}

  /**
   * Handle HTTP requests
   */
  async fetch(request: Request): Promise<Response> {
    try {
      // Check for WebSocket upgrade
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        return this.handleWebSocket(request);
      }

      // Handle HTTP request
      return this.handleRequest(request);
    } catch (error) {
      console.error('Error in fetch:', error);
      return new Response('Internal Error', { status: 500 });
    }
  }

  /**
   * Handle WebSocket connections
   */
  protected async handleWebSocket(request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());

    // Setup server handlers
    server.accept();
    
    server.addEventListener('message', async (event) => {
      try {
        await this.handleWebSocketMessage(server, event);
      } catch (error) {
        console.error('Error in WebSocket message:', error);
        server.close(1011, 'Internal Error');
      }
    });

    server.addEventListener('close', (event) => {
      this.handleWebSocketClose(server, event);
    });

    server.addEventListener('error', (event) => {
      this.handleWebSocketError(server, event);
    });

    // Return the client socket
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handle HTTP requests (to be implemented by subclasses)
   */
  protected abstract handleRequest(request: Request): Promise<Response>;

  /**
   * Handle WebSocket messages (to be implemented by subclasses)
   */
  protected abstract handleWebSocketMessage(
    ws: WebSocket,
    event: MessageEvent
  ): Promise<void>;

  /**
   * Handle WebSocket close
   */
  protected handleWebSocketClose(ws: WebSocket, event: CloseEvent): void {
    // Optional override
  }

  /**
   * Handle WebSocket errors
   */
  protected handleWebSocketError(ws: WebSocket, event: Event): void {
    console.error('WebSocket error:', event);
  }

  /**
   * Helper to run code with concurrency control
   */
  protected async withConcurrencyControl<T>(
    callback: () => Promise<T>
  ): Promise<T> {
    return this.state.blockConcurrencyWhile(async () => {
      return callback();
    });
  }

  /**
   * Helper to run code in a transaction
   */
  protected async withTransaction<T>(
    callback: (txn: DurableObjectTransaction) => Promise<T>
  ): Promise<T> {
    return this.state.storage.transaction(callback);
  }

  /**
   * Helper to store data
   */
  protected async store<T>(key: string, value: T): Promise<void> {
    await this.state.storage.put(key, value);
  }

  /**
   * Helper to retrieve data
   */
  protected async retrieve<T>(key: string): Promise<T | undefined> {
    return this.state.storage.get<T>(key);
  }

  /**
   * Helper to delete data
   */
  protected async remove(key: string): Promise<boolean> {
    return this.state.storage.delete(key);
  }
} 