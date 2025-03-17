import { ServiceError, ServiceErrorType, type ServiceResult } from '@repo/shared-types'

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