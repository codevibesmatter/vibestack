"use strict";
/// <reference types="@cloudflare/workers-types" />
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypedDurableObject = void 0;
/**
 * Base Durable Object class with type safety
 */
class TypedDurableObject {
    constructor(state, env) {
        this.state = state;
        this.env = env;
    }
    /**
     * Handle HTTP requests
     */
    async fetch(request) {
        try {
            // Check for WebSocket upgrade
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader?.toLowerCase() === 'websocket') {
                return this.handleWebSocket(request);
            }
            // Handle HTTP request
            return this.handleRequest(request);
        }
        catch (error) {
            console.error('Error in fetch:', error);
            return new Response('Internal Error', { status: 500 });
        }
    }
    /**
     * Handle WebSocket connections
     */
    async handleWebSocket(request) {
        const [client, server] = Object.values(new WebSocketPair());
        // Setup server handlers
        server.accept();
        server.addEventListener('message', async (event) => {
            try {
                await this.handleWebSocketMessage(server, event);
            }
            catch (error) {
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
     * Handle WebSocket close
     */
    handleWebSocketClose(ws, event) {
        // Optional override
    }
    /**
     * Handle WebSocket errors
     */
    handleWebSocketError(ws, event) {
        console.error('WebSocket error:', event);
    }
    /**
     * Helper to run code with concurrency control
     */
    async withConcurrencyControl(callback) {
        return this.state.blockConcurrencyWhile(async () => {
            return callback();
        });
    }
    /**
     * Helper to run code in a transaction
     */
    async withTransaction(callback) {
        return this.state.storage.transaction(callback);
    }
    /**
     * Helper to store data
     */
    async store(key, value) {
        await this.state.storage.put(key, value);
    }
    /**
     * Helper to retrieve data
     */
    async retrieve(key) {
        return this.state.storage.get(key);
    }
    /**
     * Helper to delete data
     */
    async remove(key) {
        return this.state.storage.delete(key);
    }
}
exports.TypedDurableObject = TypedDurableObject;
