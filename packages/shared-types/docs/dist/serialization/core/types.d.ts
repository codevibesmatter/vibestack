/**
 * Core serialization types
 */
/**
 * Result type for operations that can fail
 */
export type Result<T, E = Error> = {
    success: true;
    data: T;
} | {
    success: false;
    error: E;
};
/**
 * Validation error details
 */
export interface ValidationError {
    path: (string | number)[];
    message: string;
    code: 'invalid_type' | 'invalid_value' | 'missing_field' | 'parse_error' | 'validation_error' | 'type_error';
}
/**
 * Serialization error
 */
export declare class SerializationError extends Error {
    code: 'parse_error' | 'validation_error' | 'type_error';
    cause?: unknown;
    constructor(message: string, code?: 'parse_error' | 'validation_error' | 'type_error', cause?: unknown);
}
/**
 * Serialization options
 */
export interface SerializationOptions {
    strict?: boolean;
    onError?: (error: ValidationError) => void;
}
