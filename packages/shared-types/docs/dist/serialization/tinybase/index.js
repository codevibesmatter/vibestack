"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.toTinyBase = toTinyBase;
exports.fromTinyBase = fromTinyBase;
/**
 * Convert a domain object to TinyBase store format
 */
function toTinyBase(data) {
    return Object.entries(data).reduce((acc, [key, value]) => {
        // Handle arrays and objects by JSON stringifying
        if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
            acc[key] = JSON.stringify(value);
        }
        else {
            acc[key] = value;
        }
        return acc;
    }, {});
}
/**
 * Convert TinyBase store data back to domain object
 */
function fromTinyBase(data) {
    return Object.entries(data).reduce((acc, [key, value]) => {
        if (typeof value === 'string') {
            try {
                // Try to parse JSON strings back to objects/arrays
                const parsed = JSON.parse(value);
                Object.assign(acc, { [key]: parsed });
            }
            catch {
                // If not valid JSON, use the string value as is
                Object.assign(acc, { [key]: value });
            }
        }
        else {
            Object.assign(acc, { [key]: value });
        }
        return acc;
    }, {});
}
__exportStar(require("./types"), exports);
