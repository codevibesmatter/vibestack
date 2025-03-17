/**
 * Service operation result
 */
export interface ServiceResult<T> {
    ok: boolean;
    data?: T;
    error?: ServiceError;
}
/**
 * Service error types
 */
export declare enum ServiceErrorType {
    NOT_FOUND = "NOT_FOUND",
    VALIDATION = "VALIDATION",
    PERMISSION = "PERMISSION",
    CONFLICT = "CONFLICT",
    INTERNAL = "INTERNAL"
}
/**
 * Service error
 */
export declare class ServiceError extends Error {
    readonly type: ServiceErrorType;
    readonly details?: unknown;
    constructor(type: ServiceErrorType, message: string, details?: unknown);
}
