"use strict";
/**
 * Core serialization types
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SerializationError = void 0;
/**
 * Serialization error
 */
class SerializationError extends Error {
    constructor(message, code = 'parse_error', cause) {
        super(message);
        this.code = code;
        this.cause = cause;
        this.name = 'SerializationError';
    }
}
exports.SerializationError = SerializationError;
