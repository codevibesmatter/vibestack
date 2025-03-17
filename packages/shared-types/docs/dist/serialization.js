"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toTinyBase = toTinyBase;
exports.fromTinyBase = fromTinyBase;
exports.isValidData = isValidData;
exports.validateData = validateData;
exports.toPostgres = toPostgres;
exports.fromPostgres = fromPostgres;
const zod_1 = require("zod");
/**
 * Type guards for special types
 */
function isDate(value) {
    return value instanceof Date && !isNaN(value.getTime());
}
/**
 * Convert complex types to TinyBase-compatible format
 * TinyBase only supports string, number, boolean, and null
 */
function toTinyBase(data, options = {}) {
    try {
        return Object.entries(data).reduce((acc, [key, value]) => {
            // Handle arrays and objects by converting to JSON strings
            if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
                acc[key] = JSON.stringify(value);
            }
            else {
                acc[key] = value;
            }
            return acc;
        }, {});
    }
    catch (error) {
        const validationError = {
            path: [],
            message: error instanceof Error ? error.message : 'Serialization failed',
            code: 'invalid_type'
        };
        options.onError?.(validationError);
        if (options.strict) {
            throw error;
        }
        return {};
    }
}
/**
 * Convert TinyBase data back to typed objects
 */
function fromTinyBase(data, schema, options = {}) {
    try {
        // First pass: parse JSON strings back to objects
        const parsed = Object.entries(data).reduce((acc, [key, value]) => {
            if (typeof value === 'string') {
                try {
                    acc[key] = JSON.parse(value);
                }
                catch {
                    acc[key] = value; // Not JSON, keep as string
                }
            }
            else {
                acc[key] = value;
            }
            return acc;
        }, {});
        // Second pass: validate with Zod schema
        return schema.parse(parsed);
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            error.errors.forEach(err => {
                const validationError = {
                    path: err.path,
                    message: err.message,
                    code: 'invalid_value'
                };
                options.onError?.(validationError);
            });
        }
        if (options.strict) {
            throw error;
        }
        return {};
    }
}
/**
 * Type guard to check if data matches schema
 */
function isValidData(data, schema) {
    try {
        schema.parse(data);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Development-only deep validation
 * This is more expensive but provides better error messages
 */
function validateData(data, schema, options = {}) {
    try {
        schema.parse(data);
        return { valid: true, errors: [] };
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            const errors = error.errors.map(err => ({
                path: err.path,
                message: err.message,
                code: 'invalid_value'
            }));
            errors.forEach(err => options.onError?.(err));
            return { valid: false, errors };
        }
        return {
            valid: false,
            errors: [{
                    path: [],
                    message: error instanceof Error ? error.message : 'Unknown validation error',
                    code: 'invalid_type'
                }]
        };
    }
}
/**
 * Convert application types to PostgreSQL-compatible format
 * Handles JSON/JSONB fields and proper type mapping
 */
function toPostgres(data, options = {}) {
    try {
        return Object.entries(data).reduce((acc, [key, value]) => {
            // Handle Date objects
            if (isDate(value)) {
                acc[key] = value.toISOString();
            }
            // Handle arrays and objects that need to be stored as JSONB
            else if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
                // Ensure the object is JSON-compatible
                const jsonValue = JSON.parse(JSON.stringify(value));
                acc[key] = jsonValue;
            }
            // Handle primitive values
            else {
                acc[key] = value;
            }
            return acc;
        }, {});
    }
    catch (error) {
        const validationError = {
            path: [],
            message: error instanceof Error ? error.message : 'PostgreSQL serialization failed',
            code: 'invalid_type'
        };
        options.onError?.(validationError);
        if (options.strict) {
            throw error;
        }
        return {};
    }
}
/**
 * Convert PostgreSQL data back to application types
 * Handles JSON/JSONB fields and proper type mapping
 */
function fromPostgres(data, schema, options = {}) {
    try {
        // First pass: handle special PostgreSQL types
        const parsed = Object.entries(data).reduce((acc, [key, value]) => {
            // Handle PostgreSQL timestamp strings
            if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
                acc[key] = new Date(value);
            }
            // Handle JSONB fields that are already parsed by pg
            else if (typeof value === 'object' && value !== null) {
                acc[key] = value;
            }
            // Keep other values as is
            else {
                acc[key] = value;
            }
            return acc;
        }, {});
        // Second pass: validate with Zod schema
        return schema.parse(parsed);
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            error.errors.forEach(err => {
                const validationError = {
                    path: err.path,
                    message: err.message,
                    code: 'invalid_value'
                };
                options.onError?.(validationError);
            });
        }
        if (options.strict) {
            throw error;
        }
        return {};
    }
}
