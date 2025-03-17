import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { 
  ServiceErrorType,
  type SuccessResponse,
  type ErrorResponse,
  createSuccessResponse,
  createErrorResponse
} from '@repo/shared-types';

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

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

export function json<T>(c: Context, response: ApiResponse<T>, status?: ContentfulStatusCode) {
  return c.json(response, status || (response.success ? 200 : 500));
} 