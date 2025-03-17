"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationHandler = void 0;
const zod_1 = require("zod");
const tracking_1 = require("../../error/tracking");
class ValidationHandler {
    constructor(schema, errorTracker, options = {}) {
        this.schema = schema;
        this.errorTracker = errorTracker;
        this.options = options;
    }
    validateData(data, context) {
        try {
            const result = this.schema.parse(data);
            this.errorTracker.trackValidation(performance.now() - context.start);
            return result;
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                const validationError = this.createValidationError(error);
                this.handleValidationError(validationError, {
                    ...context,
                    data
                });
            }
            throw error;
        }
    }
    createValidationError(error) {
        return {
            message: error.errors[0]?.message || 'Validation failed',
            path: error.errors[0]?.path || [],
            code: 'invalid_value'
        };
    }
    handleValidationError(error, context) {
        this.options.onError?.(error);
        this.errorTracker.trackError(tracking_1.TypeErrorCategory.SCHEMA_VALIDATION, context.operation, {
            table: context.table,
            data: context.data,
            path: error.path,
            duration: performance.now() - context.start
        });
    }
    handleRuntimeError(error, context) {
        this.errorTracker.trackError(tracking_1.TypeErrorCategory.RUNTIME_MISMATCH, context.operation, {
            table: context.table,
            data: context.data,
            duration: performance.now() - context.start
        });
        throw error;
    }
}
exports.ValidationHandler = ValidationHandler;
