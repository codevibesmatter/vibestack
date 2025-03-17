/**
 * Categories of type safety errors
 */
export declare enum TypeErrorCategory {
    SCHEMA_VALIDATION = "schema_validation",
    SERIALIZATION = "serialization",
    TYPE_CONVERSION = "type_conversion",
    RUNTIME_MISMATCH = "runtime_mismatch"
}
/**
 * Detailed error context
 */
export interface TypeErrorContext {
    category: TypeErrorCategory;
    operation: string;
    table?: string;
    data?: unknown;
    path?: (string | number)[];
    timestamp: number;
    duration?: number;
}
/**
 * Error tracking metrics
 */
export interface TypeSafetyMetrics {
    totalErrors: number;
    errorsByCategory: Record<TypeErrorCategory, number>;
    averageValidationTime: number;
    errorRate: number;
    lastError?: TypeErrorContext;
}
/**
 * Error tracking configuration
 */
export interface ErrorTrackingConfig {
    enabled: boolean;
    sampleRate?: number;
    maxErrors?: number;
    onError?: (context: TypeErrorContext) => void;
}
/**
 * Type safety error tracker
 */
export declare class TypeSafetyTracker {
    private errors;
    private startTime;
    private validationTimes;
    private config;
    constructor(config: ErrorTrackingConfig);
    /**
     * Track a type safety error
     */
    trackError(category: TypeErrorCategory, operation: string, details?: Partial<TypeErrorContext>): void;
    /**
     * Track validation performance
     */
    trackValidation(duration: number): void;
    /**
     * Get current metrics
     */
    getMetrics(): TypeSafetyMetrics;
    /**
     * Get error history
     */
    getErrorHistory(options?: {
        category?: TypeErrorCategory;
        table?: string;
        limit?: number;
        since?: number;
    }): TypeErrorContext[];
    /**
     * Clear error history
     */
    clearHistory(): void;
}
