/**
 * Error categories for type validation
 */
export declare enum TypeErrorCategory {
    INVALID_TYPE = "invalid_type",
    MISSING_FIELD = "missing_field",
    INVALID_VALUE = "invalid_value",
    VALIDATION_FAILED = "validation_failed"
}
/**
 * Error metrics for tracking validation and runtime errors
 */
export interface ErrorMetrics {
    validationErrors: number;
    runtimeErrors: number;
    lastError?: {
        message: string;
        context: string;
        timestamp: number;
    };
}
/**
 * Error context for tracking where errors occur
 */
export declare enum ErrorContext {
    STORE_VALIDATION = "store_validation",
    STORE_INITIALIZATION = "store_initialization",
    WEBSOCKET_CONNECTION = "websocket_connection",
    WEBSOCKET_MESSAGE = "websocket_message",
    WEBSOCKET_BROADCAST = "websocket_broadcast",
    WEBSOCKET_ERROR = "websocket_error",
    WEBSOCKET_CLOSE = "websocket_close"
}
