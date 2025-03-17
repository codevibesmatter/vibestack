"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypeSafetyTracker = exports.TypeErrorCategory = void 0;
/**
 * Categories of type safety errors
 */
var TypeErrorCategory;
(function (TypeErrorCategory) {
    TypeErrorCategory["SCHEMA_VALIDATION"] = "schema_validation";
    TypeErrorCategory["SERIALIZATION"] = "serialization";
    TypeErrorCategory["TYPE_CONVERSION"] = "type_conversion";
    TypeErrorCategory["RUNTIME_MISMATCH"] = "runtime_mismatch";
})(TypeErrorCategory || (exports.TypeErrorCategory = TypeErrorCategory = {}));
/**
 * Type safety error tracker
 */
class TypeSafetyTracker {
    constructor(config) {
        this.errors = [];
        this.startTime = Date.now();
        this.validationTimes = [];
        this.config = {
            sampleRate: 1,
            maxErrors: 1000,
            ...config
        };
    }
    /**
     * Track a type safety error
     */
    trackError(category, operation, details = {}) {
        if (!this.config.enabled || Math.random() > (this.config.sampleRate || 1)) {
            return;
        }
        const context = {
            category,
            operation,
            timestamp: Date.now(),
            ...details
        };
        this.errors.push(context);
        if (this.errors.length > (this.config.maxErrors || 1000)) {
            this.errors.shift();
        }
        this.config.onError?.(context);
    }
    /**
     * Track validation performance
     */
    trackValidation(duration) {
        this.validationTimes.push(duration);
        if (this.validationTimes.length > 1000) {
            this.validationTimes.shift();
        }
    }
    /**
     * Get current metrics
     */
    getMetrics() {
        const totalErrors = this.errors.length;
        const errorsByCategory = Object.values(TypeErrorCategory).reduce((acc, category) => {
            acc[category] = this.errors.filter(e => e.category === category).length;
            return acc;
        }, {});
        const avgValidationTime = this.validationTimes.length
            ? this.validationTimes.reduce((a, b) => a + b, 0) / this.validationTimes.length
            : 0;
        const timespan = Date.now() - this.startTime;
        const errorRate = totalErrors / (timespan / (1000 * 60 * 60)); // Errors per hour
        return {
            totalErrors,
            errorsByCategory,
            averageValidationTime: avgValidationTime,
            errorRate,
            lastError: this.errors[this.errors.length - 1]
        };
    }
    /**
     * Get error history
     */
    getErrorHistory(options = {}) {
        let filtered = this.errors;
        if (options.category) {
            filtered = filtered.filter(e => e.category === options.category);
        }
        if (options.table) {
            filtered = filtered.filter(e => e.table === options.table);
        }
        filtered = filtered.filter(e => e.timestamp >= (options.since ?? 0));
        return filtered.slice(-(options.limit || 100));
    }
    /**
     * Clear error history
     */
    clearHistory() {
        this.errors = [];
        this.validationTimes = [];
        this.startTime = Date.now();
    }
}
exports.TypeSafetyTracker = TypeSafetyTracker;
