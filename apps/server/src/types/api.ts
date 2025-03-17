import type { Env } from './env';

/**
 * Service error types for API responses
 */
export enum ServiceErrorType {
  INTERNAL = 'INTERNAL',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION = 'VALIDATION',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN'
}

/**
 * Success response wrapper
 */
export interface SuccessResponse<T> {
  ok: true;
  data: T;
}

/**
 * Error response wrapper
 */
export interface ErrorResponse {
  ok: false;
  error: {
    type: ServiceErrorType;
    message: string;
  };
}

/**
 * Helper to create a success response
 */
export function createSuccessResponse<T>(data: T): SuccessResponse<T> {
  return {
    ok: true,
    data
  };
}

/**
 * Helper to create an error response
 */
export function createErrorResponse(type: ServiceErrorType, message: string): ErrorResponse {
  return {
    ok: false,
    error: {
      type,
      message
    }
  };
}

/**
 * API environment type for Hono routes
 */
export type ApiEnv = {
  Bindings: Env;
}; 