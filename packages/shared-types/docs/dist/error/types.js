"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorContext = exports.TypeErrorCategory = void 0;
/**
 * Error categories for type validation
 */
var TypeErrorCategory;
(function (TypeErrorCategory) {
    TypeErrorCategory["INVALID_TYPE"] = "invalid_type";
    TypeErrorCategory["MISSING_FIELD"] = "missing_field";
    TypeErrorCategory["INVALID_VALUE"] = "invalid_value";
    TypeErrorCategory["VALIDATION_FAILED"] = "validation_failed";
})(TypeErrorCategory || (exports.TypeErrorCategory = TypeErrorCategory = {}));
/**
 * Error context for tracking where errors occur
 */
var ErrorContext;
(function (ErrorContext) {
    ErrorContext["STORE_VALIDATION"] = "store_validation";
    ErrorContext["STORE_INITIALIZATION"] = "store_initialization";
    ErrorContext["WEBSOCKET_CONNECTION"] = "websocket_connection";
    ErrorContext["WEBSOCKET_MESSAGE"] = "websocket_message";
    ErrorContext["WEBSOCKET_BROADCAST"] = "websocket_broadcast";
    ErrorContext["WEBSOCKET_ERROR"] = "websocket_error";
    ErrorContext["WEBSOCKET_CLOSE"] = "websocket_close";
})(ErrorContext || (exports.ErrorContext = ErrorContext = {}));
