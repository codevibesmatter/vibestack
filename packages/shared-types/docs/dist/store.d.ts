import { z } from 'zod';
import { Store } from 'tinybase';
import type { BaseSchema } from './schemas';
import { type ValidationError, type SerializationOptions } from './serialization';
import { type ErrorTrackingConfig } from './error-tracking';
export interface TypedStoreConfig {
    strict?: boolean;
    onError?: (error: ValidationError) => void;
}
/**
 * Type-safe wrapper around TinyBase store
 */
export declare class TypedStore<T extends BaseSchema> {
    private store;
    private schema;
    private options;
    private errorTracker;
    private config;
    constructor(schema: z.ZodSchema<T>, options?: SerializationOptions, errorTracking?: ErrorTrackingConfig, config?: TypedStoreConfig);
    /**
     * Set data with type validation
     */
    set(tableId: string, rowId: string, data: T): void;
    /**
     * Get data with type validation
     */
    get(tableId: string, rowId: string): T | null;
    /**
     * Get all rows from a table
     */
    getAll(tableId: string): Record<string, T>;
    /**
     * Delete a row
     */
    delete(tableId: string, rowId: string): void;
    /**
     * Add a listener for changes to a table
     * @returns A function that removes the listener when called
     */
    addListener(tableId: string, callback: (data: Record<string, T>) => void): () => void;
    /**
     * Get the underlying TinyBase store
     */
    getStore(): Store;
    /**
     * Validate all data in a table
     */
    validateTable(tableId: string): ValidationError[];
    /**
     * Get error tracking metrics
     */
    getErrorMetrics(): import("./error-tracking").TypeSafetyMetrics;
    /**
     * Get error history
     */
    getErrorHistory(options?: {}): import("./error-tracking").TypeErrorContext[];
    validate(data: unknown): T | undefined;
}
