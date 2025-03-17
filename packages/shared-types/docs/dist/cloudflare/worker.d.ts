import type { Env, WorkerExecutionContext, ScheduledController, MessageBatch } from './types';
/**
 * Base Worker class with type safety
 */
export declare abstract class TypedWorker {
    protected readonly env: Env;
    constructor(env: Env);
    /**
     * Handle fetch events
     */
    fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response>;
    /**
     * Handle scheduled events
     */
    scheduled(controller: ScheduledController, env: Env, ctx: WorkerExecutionContext): Promise<void>;
    /**
     * Handle queue messages
     */
    queue(batch: MessageBatch, env: Env, ctx: WorkerExecutionContext): Promise<void>;
    /**
     * Handle HTTP requests (to be implemented by subclasses)
     */
    protected abstract handleRequest(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response>;
    /**
     * Handle scheduled events (optional override)
     */
    protected handleScheduled(controller: ScheduledController, env: Env, ctx: WorkerExecutionContext): Promise<void>;
    /**
     * Handle queue messages (optional override)
     */
    protected handleQueue(batch: MessageBatch, env: Env, ctx: WorkerExecutionContext): Promise<void>;
    /**
     * Handle errors
     */
    protected handleError(error: unknown): Response;
    /**
     * Determine if errors should be passed through
     */
    protected shouldPassThroughErrors(request: Request): boolean;
    /**
     * Helper to wait for async tasks
     */
    protected waitUntil(ctx: WorkerExecutionContext, promise: Promise<unknown>): void;
    /**
     * Helper to create JSON responses
     */
    protected json(data: unknown, init?: ResponseInit): Response;
    /**
     * Helper to parse JSON requests
     */
    protected parseJson<T = unknown>(request: Request): Promise<T>;
    /**
     * Helper to validate request method
     */
    protected validateMethod(request: Request, allowedMethods: string[]): void;
}
