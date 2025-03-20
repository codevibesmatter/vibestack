import type { Context } from 'hono';
import type { StatusCode } from 'hono/utils/http-status';

// Define error types locally
export enum ServiceErrorType {
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION = 'VALIDATION',
  INTERNAL = 'INTERNAL',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN'
}

// Response type definitions
export interface SuccessResponse<T> {
  success: true;
  data: T;
}

export interface ErrorResponse {
  success: false;
  error: {
    type: ServiceErrorType;
    message: string;
  };
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

// Response creation helpers
export function createSuccessResponse<T>(data: T): SuccessResponse<T> {
  return {
    success: true,
    data
  };
}

export function createErrorResponse(type: ServiceErrorType, message: string): ErrorResponse {
  return {
    success: false,
    error: {
      type,
      message
    }
  };
}

// Convenience functions for common responses
export function success<T>(data: T): SuccessResponse<T> {
  return createSuccessResponse(data);
}

export function error(type: ServiceErrorType, message: string): ErrorResponse {
  return createErrorResponse(type, message);
}

export function notFound(resource: string, id: string): ErrorResponse {
  return error(ServiceErrorType.NOT_FOUND, `${resource} with id ${id} not found`);
}

export function validationError(message: string): ErrorResponse {
  return error(ServiceErrorType.VALIDATION, message);
}

export function databaseError(err: unknown): ErrorResponse {
  const message = err instanceof Error ? err.message : 'Database error';
  return error(ServiceErrorType.INTERNAL, message);
}

// Hono response helper
export function json<T>(c: Context, response: ApiResponse<T>, status?: StatusCode) {
  return c.json(response, status || (response.success ? 200 : 500));
} 