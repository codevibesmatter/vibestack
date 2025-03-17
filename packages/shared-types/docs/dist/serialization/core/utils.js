"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDate = isDate;
exports.isObject = isObject;
exports.safeStringify = safeStringify;
exports.safeParse = safeParse;
exports.validateData = validateData;
exports.isValidData = isValidData;
const types_1 = require("./types");
/**
 * Type guard for Date objects
 */
function isDate(value) {
    return value instanceof Date && !isNaN(value.getTime());
}
/**
 * Type guard for objects
 */
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !isDate(value);
}
/**
 * Safely stringify data to JSON
 */
function safeStringify(data, options = {}) {
    try {
        return { success: true, data: JSON.stringify(data) };
    }
    catch (error) {
        return {
            success: false,
            error: new types_1.SerializationError('Failed to stringify data', 'parse_error', error)
        };
    }
}
/**
 * Safely parse JSON data with schema validation
 */
function safeParse(input, schema, options = {}) {
    try {
        const parsed = JSON.parse(input);
        const result = schema.safeParse(parsed);
        if (!result.success) {
            return {
                success: false,
                error: new types_1.SerializationError('Data validation failed', 'validation_error', result.error)
            };
        }
        return { success: true, data: result.data };
    }
    catch (error) {
        return {
            success: false,
            error: new types_1.SerializationError('Failed to parse JSON', 'parse_error', error)
        };
    }
}
/**
 * Validate data against a schema
 */
function validateData(data, schema, options = {}) {
    const result = schema.safeParse(data);
    if (!result.success) {
        const errors = result.error.errors.map(err => ({
            path: err.path,
            message: err.message,
            code: 'validation_error'
        }));
        if (options.onError) {
            errors.forEach(options.onError);
        }
        return { success: false, error: errors };
    }
    return { success: true, data: result.data };
}
/**
 * Type guard for schema-validated data
 */
function isValidData(data, schema) {
    const result = schema.safeParse(data);
    return result.success;
}
