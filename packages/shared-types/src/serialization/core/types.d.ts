/**
 * Core serialization types
 */
/**
 * Result type for operations that can fail
 */
export interface Result<T> {
    success: boolean;
    data?: T;
    error?: SerializationError;
}
/**
 * Serialization error types
 */
export type SerializationErrorType = 'parse_error' | 'validation_error' | 'serialization_error';
/**
 * Serialization error interface
 */
export interface SerializationError {
    type: SerializationErrorType;
    message: string;
    details?: Record<string, unknown>;
}
/**
 * Validation error details
 */
export interface ValidationError {
    path: (string | number)[];
    message: string;
    code: 'invalid_type' | 'invalid_value' | 'missing_field' | 'parse_error' | 'validation_error' | 'type_error';
}
/**
 * Serialization options
 */
export interface SerializationOptions {
    pretty?: boolean;
    onError?: (error: SerializationError) => void;
}
//# sourceMappingURL=types.d.ts.map