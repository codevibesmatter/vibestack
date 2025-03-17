/// <reference types="@cloudflare/workers-types" />

import type { CloudflareEnv as Env } from './env';
import type { WorkerExecutionContext, ScheduledController, MessageBatch } from './types';
import { isJsonContentType, validateRequestData, isResponseInit } from '../validation/request-validation';
import { isError } from '../validation/type-guards';
import { ValidationResult } from '../validation/validators';
import { z } from 'zod';

export type { Env, WorkerExecutionContext, ScheduledController, MessageBatch };

/**
 * Base Worker class with type safety
 */
export abstract class TypedWorker {
  constructor(protected readonly env: Env) {}

  /**
   * Handle fetch events
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext
  ): Promise<Response> {
    try {
      // Setup error handling
      if (this.shouldPassThroughErrors(request)) {
        ctx.passThroughOnException();
      }

      // Handle the request
      return await this.handleRequest(request, env, ctx);
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Handle scheduled events
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: WorkerExecutionContext
  ): Promise<void> {
    try {
      await this.handleScheduled(controller, env, ctx);
    } catch (error) {
      console.error('Error in scheduled event:', error);
      throw error; // Let the platform handle retries
    }
  }

  /**
   * Handle queue messages
   */
  async queue(
    batch: MessageBatch,
    env: Env,
    ctx: WorkerExecutionContext
  ): Promise<void> {
    try {
      await this.handleQueue(batch, env, ctx);
    } catch (error) {
      console.error('Error processing queue:', error);
      throw error; // Let the platform handle retries
    }
  }

  /**
   * Handle HTTP requests (to be implemented by subclasses)
   */
  protected abstract handleRequest(
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext
  ): Promise<Response>;

  /**
   * Handle scheduled events (optional override)
   */
  protected async handleScheduled(
    controller: ScheduledController,
    env: Env,
    ctx: WorkerExecutionContext
  ): Promise<void> {
    // Optional override
  }

  /**
   * Handle queue messages (optional override)
   */
  protected async handleQueue(
    batch: MessageBatch,
    env: Env,
    ctx: WorkerExecutionContext
  ): Promise<void> {
    // Optional override
  }

  /**
   * Handle errors with proper type checking
   */
  protected handleError(error: unknown): Response {
    console.error('Worker error:', error);
    
    if (isError(error)) {
      return new Response(error.message, { status: 500 });
    }
    
    return new Response('Internal Error', { status: 500 });
  }

  /**
   * Determine if errors should be passed through
   */
  protected shouldPassThroughErrors(request: Request): boolean {
    return false; // Override to enable pass-through
  }

  /**
   * Helper to wait for async tasks
   */
  protected waitUntil(
    ctx: WorkerExecutionContext,
    promise: Promise<unknown>
  ): void {
    ctx.waitUntil(promise.catch(error => {
      console.error('Background task error:', error);
    }));
  }

  /**
   * Helper to create JSON responses with type checking
   */
  protected json(data: unknown, init?: ResponseInit): Response {
    const headers = new Headers({
      'Content-Type': 'application/json'
    });

    if (init?.headers) {
      const initHeaders = init.headers;
      if (initHeaders instanceof Headers) {
        for (const [key, value] of initHeaders.entries()) {
          headers.set(key, value);
        }
      } else if (Array.isArray(initHeaders)) {
        for (const [key, value] of initHeaders) {
          headers.set(key, value);
        }
      } else if (typeof initHeaders === 'object') {
        for (const [key, value] of Object.entries(initHeaders)) {
          if (value !== undefined) {
            headers.set(key, value);
          }
        }
      }
    }

    return new Response(JSON.stringify(data), {
      ...init,
      headers
    });
  }

  /**
   * Helper to parse JSON requests with runtime validation
   */
  protected async parseJson<T>(request: Request, schema: z.ZodSchema<T>): Promise<ValidationResult<T>>;
  protected async parseJson(request: Request): Promise<ValidationResult<unknown>>;
  protected async parseJson<T>(request: Request, schema?: z.ZodSchema<T>): Promise<ValidationResult<T> | ValidationResult<unknown>> {
    const contentType = request.headers.get('Content-Type');
    if (!isJsonContentType(contentType)) {
      throw new Error('Expected JSON content type');
    }

    const data = await request.json();
    
    // Validate against schema if provided
    if (schema) {
      return validateRequestData(schema, data);
    }

    // If no schema provided but validateJsonData is implemented
    if (this.validateJsonData) {
      const customSchema = z.unknown().transform(val => this.validateJsonData!(val));
      return validateRequestData(customSchema, data);
    }

    // No validation, return success with data
    return {
      success: true,
      data
    };
  }

  /**
   * Optional method for subclasses to implement JSON validation
   */
  protected validateJsonData?(data: unknown): unknown;

  /**
   * Helper to validate request method
   */
  protected validateMethod(
    request: Request,
    allowedMethods: string[]
  ): void {
    if (!allowedMethods.includes(request.method)) {
      throw new Error(`Method ${request.method} not allowed`);
    }
  }
} 