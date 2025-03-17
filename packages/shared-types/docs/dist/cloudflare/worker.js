"use strict";
/// <reference types="@cloudflare/workers-types" />
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypedWorker = void 0;
/**
 * Base Worker class with type safety
 */
class TypedWorker {
    constructor(env) {
        this.env = env;
    }
    /**
     * Handle fetch events
     */
    async fetch(request, env, ctx) {
        try {
            // Setup error handling
            if (this.shouldPassThroughErrors(request)) {
                ctx.passThroughOnException();
            }
            // Handle the request
            return await this.handleRequest(request, env, ctx);
        }
        catch (error) {
            return this.handleError(error);
        }
    }
    /**
     * Handle scheduled events
     */
    async scheduled(controller, env, ctx) {
        try {
            await this.handleScheduled(controller, env, ctx);
        }
        catch (error) {
            console.error('Error in scheduled event:', error);
            throw error; // Let the platform handle retries
        }
    }
    /**
     * Handle queue messages
     */
    async queue(batch, env, ctx) {
        try {
            await this.handleQueue(batch, env, ctx);
        }
        catch (error) {
            console.error('Error processing queue:', error);
            throw error; // Let the platform handle retries
        }
    }
    /**
     * Handle scheduled events (optional override)
     */
    async handleScheduled(controller, env, ctx) {
        // Optional override
    }
    /**
     * Handle queue messages (optional override)
     */
    async handleQueue(batch, env, ctx) {
        // Optional override
    }
    /**
     * Handle errors
     */
    handleError(error) {
        console.error('Worker error:', error);
        return new Response('Internal Error', { status: 500 });
    }
    /**
     * Determine if errors should be passed through
     */
    shouldPassThroughErrors(request) {
        return false; // Override to enable pass-through
    }
    /**
     * Helper to wait for async tasks
     */
    waitUntil(ctx, promise) {
        ctx.waitUntil(promise.catch(error => {
            console.error('Background task error:', error);
        }));
    }
    /**
     * Helper to create JSON responses
     */
    json(data, init) {
        return new Response(JSON.stringify(data), {
            headers: {
                'Content-Type': 'application/json',
                ...(init?.headers || {})
            },
            ...init
        });
    }
    /**
     * Helper to parse JSON requests
     */
    async parseJson(request) {
        const contentType = request.headers.get('Content-Type');
        if (!contentType?.includes('application/json')) {
            throw new Error('Expected JSON content type');
        }
        return request.json();
    }
    /**
     * Helper to validate request method
     */
    validateMethod(request, allowedMethods) {
        if (!allowedMethods.includes(request.method)) {
            throw new Error(`Method ${request.method} not allowed`);
        }
    }
}
exports.TypedWorker = TypedWorker;
