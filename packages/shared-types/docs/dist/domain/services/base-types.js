"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceError = exports.ServiceErrorType = void 0;
/**
 * Service error types
 */
var ServiceErrorType;
(function (ServiceErrorType) {
    ServiceErrorType["NOT_FOUND"] = "NOT_FOUND";
    ServiceErrorType["VALIDATION"] = "VALIDATION";
    ServiceErrorType["PERMISSION"] = "PERMISSION";
    ServiceErrorType["CONFLICT"] = "CONFLICT";
    ServiceErrorType["INTERNAL"] = "INTERNAL";
})(ServiceErrorType || (exports.ServiceErrorType = ServiceErrorType = {}));
/**
 * Service error
 */
class ServiceError extends Error {
    constructor(type, message, details) {
        super(message);
        this.type = type;
        this.details = details;
        this.name = 'ServiceError';
    }
}
exports.ServiceError = ServiceError;
