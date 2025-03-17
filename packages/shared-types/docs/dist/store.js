"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypedStore = void 0;
const zod_1 = require("zod");
const tinybase_1 = require("tinybase");
const serialization_1 = require("./serialization");
const error_tracking_1 = require("./error-tracking");
/**
 * Type-safe wrapper around TinyBase store
 */
class TypedStore {
    constructor(schema, options = {}, errorTracking = { enabled: true }, config = {}) {
        this.store = (0, tinybase_1.createStore)();
        this.schema = schema;
        this.options = options;
        this.errorTracker = new error_tracking_1.TypeSafetyTracker(errorTracking);
        this.config = {
            strict: true,
            ...config
        };
    }
    /**
     * Set data with type validation
     */
    set(tableId, rowId, data) {
        const start = performance.now();
        try {
            const serialized = (0, serialization_1.toTinyBase)(data, {
                ...this.options,
                onError: (error) => {
                    this.options.onError?.(error);
                    this.errorTracker.trackError(error_tracking_1.TypeErrorCategory.SERIALIZATION, 'set', {
                        table: tableId,
                        data,
                        path: error.path
                    });
                }
            });
            // Convert to TinyBase Row type (exclude null values)
            const row = Object.entries(serialized).reduce((acc, [key, value]) => {
                if (value !== null) {
                    acc[key] = value;
                }
                return acc;
            }, {});
            this.store.setRow(tableId, rowId, row);
            this.errorTracker.trackValidation(performance.now() - start);
        }
        catch (error) {
            this.errorTracker.trackError(error_tracking_1.TypeErrorCategory.RUNTIME_MISMATCH, 'set', {
                table: tableId,
                data,
                duration: performance.now() - start
            });
            throw error;
        }
    }
    /**
     * Get data with type validation
     */
    get(tableId, rowId) {
        const start = performance.now();
        try {
            const data = this.store.getRow(tableId, rowId);
            if (!data)
                return null;
            const result = (0, serialization_1.fromTinyBase)(data, this.schema, {
                ...this.options,
                onError: (error) => {
                    this.options.onError?.(error);
                    this.errorTracker.trackError(error_tracking_1.TypeErrorCategory.TYPE_CONVERSION, 'get', {
                        table: tableId,
                        data,
                        path: error.path
                    });
                }
            });
            this.errorTracker.trackValidation(performance.now() - start);
            return result;
        }
        catch (error) {
            this.errorTracker.trackError(error_tracking_1.TypeErrorCategory.RUNTIME_MISMATCH, 'get', {
                table: tableId,
                duration: performance.now() - start
            });
            throw error;
        }
    }
    /**
     * Get all rows from a table
     */
    getAll(tableId) {
        const start = performance.now();
        try {
            const table = this.store.getTable(tableId);
            const result = Object.entries(table).reduce((acc, [rowId, data]) => {
                acc[rowId] = (0, serialization_1.fromTinyBase)(data, this.schema, {
                    ...this.options,
                    onError: (error) => {
                        this.options.onError?.(error);
                        this.errorTracker.trackError(error_tracking_1.TypeErrorCategory.TYPE_CONVERSION, 'getAll', {
                            table: tableId,
                            data,
                            path: error.path
                        });
                    }
                });
                return acc;
            }, {});
            this.errorTracker.trackValidation(performance.now() - start);
            return result;
        }
        catch (error) {
            this.errorTracker.trackError(error_tracking_1.TypeErrorCategory.RUNTIME_MISMATCH, 'getAll', {
                table: tableId,
                duration: performance.now() - start
            });
            throw error;
        }
    }
    /**
     * Delete a row
     */
    delete(tableId, rowId) {
        this.store.delRow(tableId, rowId);
    }
    /**
     * Add a listener for changes to a table
     * @returns A function that removes the listener when called
     */
    addListener(tableId, callback) {
        const listener = () => {
            const data = this.getAll(tableId);
            callback(data);
        };
        const listenerId = this.store.addTableListener(tableId, listener);
        return () => {
            this.store.delListener(listenerId);
        };
    }
    /**
     * Get the underlying TinyBase store
     */
    getStore() {
        return this.store;
    }
    /**
     * Validate all data in a table
     */
    validateTable(tableId) {
        const start = performance.now();
        const errors = [];
        try {
            const table = this.store.getTable(tableId);
            Object.entries(table).forEach(([rowId, data]) => {
                try {
                    (0, serialization_1.fromTinyBase)(data, this.schema, {
                        ...this.options,
                        onError: (error) => {
                            errors.push(error);
                            this.errorTracker.trackError(error_tracking_1.TypeErrorCategory.SCHEMA_VALIDATION, 'validateTable', {
                                table: tableId,
                                data,
                                path: error.path
                            });
                        }
                    });
                }
                catch (error) {
                    // Handle individual row validation errors
                    this.errorTracker.trackError(error_tracking_1.TypeErrorCategory.SCHEMA_VALIDATION, 'validateTable', {
                        table: tableId,
                        data
                    });
                }
            });
            this.errorTracker.trackValidation(performance.now() - start);
            return errors;
        }
        catch (error) {
            this.errorTracker.trackError(error_tracking_1.TypeErrorCategory.RUNTIME_MISMATCH, 'validateTable', {
                table: tableId,
                duration: performance.now() - start
            });
            throw error;
        }
    }
    /**
     * Get error tracking metrics
     */
    getErrorMetrics() {
        return this.errorTracker.getMetrics();
    }
    /**
     * Get error history
     */
    getErrorHistory(options = {}) {
        return this.errorTracker.getErrorHistory(options);
    }
    validate(data) {
        try {
            return this.schema.parse(data);
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                const validationError = {
                    message: error.errors[0]?.message || 'Validation failed',
                    path: error.errors[0]?.path || [],
                    code: 'invalid_value'
                };
                this.config.onError?.(validationError);
            }
            if (this.config.strict) {
                throw error;
            }
            return undefined;
        }
    }
}
exports.TypedStore = TypedStore;
