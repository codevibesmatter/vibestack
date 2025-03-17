/**
 * Error categories for type validation
 */
export enum TypeErrorCategory {
  VALIDATION = 'validation',
  SERIALIZATION = 'serialization',
  TYPE_SAFETY = 'type_safety'
}

/**
 * Error context for tracking where errors occur
 */
export enum ErrorContext {
  STORE_VALIDATION = 'store_validation',
  STORE_INITIALIZATION = 'store_initialization',
  WEBSOCKET_CONNECTION = 'websocket_connection',
  WEBSOCKET_MESSAGE = 'websocket_message',
  WEBSOCKET_BROADCAST = 'websocket_broadcast',
  WEBSOCKET_ERROR = 'websocket_error',
  WEBSOCKET_CLOSE = 'websocket_close'
}

/**
 * Base error interface
 */
export interface BaseError {
  category: TypeErrorCategory;
  message: string;
  path?: string[];
  value?: unknown;
  timestamp?: number;
  context?: ErrorContext;
}

/**
 * Validation error interface
 */
export interface ValidationError extends BaseError {
  category: TypeErrorCategory.VALIDATION;
}

/**
 * Serialization error interface
 */
export interface SerializationError extends BaseError {
  category: TypeErrorCategory.SERIALIZATION;
}

/**
 * Type safety error interface
 */
export interface TypeSafetyError extends BaseError {
  category: TypeErrorCategory.TYPE_SAFETY;
}

/**
 * Error metrics for tracking validation and runtime errors
 */
export interface ErrorMetrics {
  validationErrors: number;
  runtimeErrors: number;
  lastError?: BaseError;
} 