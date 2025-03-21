// Define local error types to replace @repo/shared-types dependency
export enum ServiceErrorType {
  VALIDATION = 'validation',
  NOT_FOUND = 'not_found',
  UNAUTHORIZED = 'unauthorized',
  FORBIDDEN = 'forbidden',
  INTERNAL = 'internal',
  CONFLICT = 'conflict',
  BAD_REQUEST = 'bad_request'
}

export interface ServiceError {
  type: ServiceErrorType;
  message: string;
  details?: Record<string, any>;
}

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: ServiceError;
}

export const errorUtils = {
  handleApiError(error: unknown): ServiceResult<never> {
    if (error instanceof Error) {
      return {
        success: false,
        error: {
          type: ServiceErrorType.INTERNAL,
          message: error.message
        }
      }
    }

    // Handle other error types
    console.error('Unhandled API error:', error)
    return {
      success: false,
      error: {
        type: ServiceErrorType.INTERNAL,
        message: 'Internal server error'
      }
    }
  }
}

export function handleValidationError(message: string): ServiceResult<never> {
  return {
    success: false,
    error: {
      type: ServiceErrorType.VALIDATION,
      message
    }
  };
}

export function handleDatabaseError(err: unknown): ServiceResult<never> {
  return {
    success: false,
    error: {
      type: ServiceErrorType.INTERNAL,
      message: err instanceof Error ? err.message : 'Database error'
    }
  };
} 