/**
 * Service configuration options
 */
export interface ServiceConfig {
  tableName?: string;
  strict?: boolean;
  enableMetrics?: boolean;
}

/**
 * Service metrics tracking
 */
export interface ServiceMetrics {
  operations: number;
  errors: number;
  lastOperation?: {
    name: string;
    timestamp: number;
    duration: number;
  };
}

/**
 * Service error types
 */
export enum ServiceErrorType {
  VALIDATION = 'VALIDATION',
  NOT_FOUND = 'NOT_FOUND',
  INTERNAL = 'INTERNAL',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  CONFLICT = 'CONFLICT',
  UNKNOWN = 'UNKNOWN'
}

/**
 * Service error with type information
 */
export class ServiceError extends Error {
  constructor(
    public readonly type: ServiceErrorType,
    message: string
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/**
 * Base success response type with literal true
 */
export type SuccessResponse<T> = {
  success: true;
  data: T;
};

/**
 * Base error response type with literal false
 */
export type ErrorResponse<T extends ServiceErrorType = ServiceErrorType> = {
  success: false;
  error: {
    type: T;
    message: string;
  };
};

/**
 * Service operation result type with specific error types
 */
export type ServiceResult<T, E extends ServiceErrorType = ServiceErrorType> = 
  | SuccessResponse<T>
  | ErrorResponse<E>;

/**
 * HTTP status codes mapped to error types
 */
export const ErrorTypeToStatus = {
  [ServiceErrorType.VALIDATION]: 400,
  [ServiceErrorType.UNAUTHORIZED]: 401,
  [ServiceErrorType.FORBIDDEN]: 403,
  [ServiceErrorType.NOT_FOUND]: 404,
  [ServiceErrorType.CONFLICT]: 409,
  [ServiceErrorType.INTERNAL]: 500,
  [ServiceErrorType.UNKNOWN]: 500
} as const;

/**
 * Query options for service operations
 */
export interface QueryOptions {
  limit?: number;
  offset?: number;
  sort?: {
    field: string;
    direction: 'asc' | 'desc';
  };
  filter?: Record<string, unknown>;
}

/**
 * Query result with pagination info
 */
export interface QueryResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Helper type for OpenAPI route responses
 */
export type RouteResponse<
  T,
  E extends ServiceErrorType = ServiceErrorType.INTERNAL
> = {
  200: SuccessResponse<T>;
} & {
  [K in (typeof ErrorTypeToStatus)[E]]: ErrorResponse<E>;
};

/**
 * Helper to create a success response with literal true
 */
export function createSuccessResponse<T>(data: T): SuccessResponse<T> {
  return {
    success: true as const,
    data
  };
}

/**
 * Helper to create an error response with literal false
 */
export function createErrorResponse<E extends ServiceErrorType>(
  type: E,
  message: string
): ErrorResponse<E> {
  return {
    success: false as const,
    error: {
      type,
      message
    }
  };
} 