import { z } from 'zod';
import type { ServiceErrorType } from './services';
import type { SuccessResponse, ErrorResponse } from './services';
import { ErrorTypeToStatus } from './services';

/**
 * OpenAPI content type mapping
 */
export type OpenAPIContent<T> = {
  'application/json': {
    schema: z.ZodType<T>;
  };
};

/**
 * OpenAPI response with status code
 */
export type OpenAPIResponse<T, Status extends number> = {
  description: string;
  content: OpenAPIContent<T>;
};

/**
 * Maps error types to their OpenAPI response definitions
 */
export type ErrorResponseMapping<E extends ServiceErrorType> = {
  [Status in (typeof ErrorTypeToStatus)[E]]: OpenAPIResponse<ErrorResponse<E>, Status>;
};

/**
 * OpenAPI route success response
 */
export type SuccessResponseMapping<T, Status extends number = 200> = {
  [S in Status]: OpenAPIResponse<SuccessResponse<T>, S>;
};

/**
 * Complete OpenAPI route response mapping
 */
export type OpenAPIRouteResponse<
  T,
  E extends ServiceErrorType = ServiceErrorType.INTERNAL
> = SuccessResponseMapping<T> & ErrorResponseMapping<E>;

/**
 * Helper to create a success response schema
 */
export function createSuccessSchema<T>(schema: z.ZodType<T>) {
  return z.object({
    success: z.literal(true),
    data: schema
  }) as z.ZodType<SuccessResponse<T>>;
}

/**
 * Helper to create an error response schema
 */
export function createErrorSchema<E extends ServiceErrorType>(type: E) {
  return z.object({
    success: z.literal(false),
    error: z.object({
      type: z.literal(type),
      message: z.string()
    })
  }) as z.ZodType<ErrorResponse<E>>;
}

/**
 * Helper to create a complete route response schema
 */
export function createRouteResponse<T, E extends ServiceErrorType = ServiceErrorType.INTERNAL>(
  successSchema: z.ZodType<T>,
  errorType: E,
  options: {
    successStatus?: 200 | 201;
    successDescription?: string;
    errorDescription?: string;
  } = {}
) {
  const {
    successStatus = 200,
    successDescription = 'Successful response',
    errorDescription = 'Error response'
  } = options;

  const responses = {
    [successStatus]: {
      description: successDescription,
      content: {
        'application/json': {
          schema: createSuccessSchema(successSchema)
        }
      }
    },
    [ErrorTypeToStatus[errorType]]: {
      description: errorDescription,
      content: {
        'application/json': {
          schema: createErrorSchema(errorType)
        }
      }
    }
  } as const;

  return responses;
} 