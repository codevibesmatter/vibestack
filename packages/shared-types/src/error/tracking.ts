import { z } from 'zod';
import { TypeErrorCategory } from './types';
import type { ValidationError } from '../serialization/core/types';
import type { ErrorContext, BaseError } from './types';

/**
 * Detailed error context
 */
export interface TypeErrorContext {
  category: TypeErrorCategory;
  operation: string;
  table?: string;
  data?: unknown;
  path?: (string | number)[];
  timestamp: number;
  duration?: number;
  context?: ErrorContext;
}

/**
 * Error tracking metrics
 */
export interface TypeSafetyMetrics {
  totalErrors: number;
  errorsByCategory: Record<TypeErrorCategory, number>;
  averageValidationTime: number;
  errorRate: number;
  lastError?: TypeErrorContext;
}

/**
 * Error tracking configuration
 */
export interface ErrorTrackingConfig {
  enabled: boolean;
  sampleRate?: number;
  maxErrors?: number;
  onError?: (context: TypeErrorContext) => void;
}

/**
 * Error handler interface
 */
export interface ErrorHandler {
  trackError(error: Error, operation: string, context?: Record<string, unknown>): void;
  getMetrics(): TypeSafetyMetrics;
  resetMetrics(): void;
}

/**
 * Validate error details schema
 */
const errorDetailsSchema = z.object({
  category: z.nativeEnum(TypeErrorCategory).optional(),
  operation: z.string().optional(),
  table: z.string().optional(),
  data: z.unknown().optional(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  timestamp: z.number().optional(),
  duration: z.number().optional()
});

/**
 * Type guard for error context details
 */
function isValidErrorDetails(details: unknown): details is Partial<TypeErrorContext> {
  return errorDetailsSchema.safeParse(details).success;
}

/**
 * Validate error tracking configuration
 */
const errorTrackingConfigSchema = z.object({
  enabled: z.boolean(),
  sampleRate: z.number().min(0).max(1).optional(),
  maxErrors: z.number().int().positive().optional(),
  onError: z.function().args(z.custom<TypeErrorContext>()).returns(z.void()).optional()
});

/**
 * Initialize error category counters
 */
function initializeErrorCounters(): Record<TypeErrorCategory, number> {
  return Object.values(TypeErrorCategory).reduce((acc, category) => {
    acc[category] = 0;
    return acc;
  }, Object.create(null));
}

/**
 * Type safety error tracker
 */
export class TypeSafetyTracker {
  private errors: TypeErrorContext[] = [];
  private startTime: number = Date.now();
  private validationTimes: number[] = [];
  private config: ErrorTrackingConfig;

  constructor(config: ErrorTrackingConfig) {
    // Validate config
    const validatedConfig = errorTrackingConfigSchema.parse(config);
    
    // Create config with type safety
    this.config = {
      enabled: validatedConfig.enabled,
      sampleRate: validatedConfig.sampleRate !== undefined ? validatedConfig.sampleRate : 1,
      maxErrors: validatedConfig.maxErrors !== undefined ? validatedConfig.maxErrors : 1000,
      onError: validatedConfig.onError
    } satisfies ErrorTrackingConfig;
  }

  /**
   * Track a type safety error
   */
  trackError(
    category: TypeErrorCategory,
    operation: string,
    details: unknown = {}
  ): void {
    if (!this.config.enabled || Math.random() > (this.config.sampleRate || 1)) {
      return;
    }

    // Create base context with required fields
    const baseContext = {
      category,
      operation,
      timestamp: Date.now()
    };

    // Validate and merge additional details
    const validatedDetails = errorDetailsSchema.safeParse(details);
    const context: TypeErrorContext = {
      ...baseContext,
      ...(validatedDetails.success ? validatedDetails.data : {})
    };

    this.errors.push(context);
    if (this.errors.length > (this.config.maxErrors || 1000)) {
      this.errors.shift();
    }

    if (this.config.onError) {
      try {
        this.config.onError(context);
      } catch (error) {
        console.error('Error in onError callback:', error);
      }
    }
  }

  /**
   * Track validation performance
   */
  trackValidation(duration: number): void {
    if (typeof duration !== 'number' || isNaN(duration) || duration < 0) {
      console.warn('Invalid validation duration:', duration);
      return;
    }

    this.validationTimes.push(duration);
    if (this.validationTimes.length > 1000) {
      this.validationTimes.shift();
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): TypeSafetyMetrics {
    const totalErrors = this.errors.length;
    const errorsByCategory = Object.values(TypeErrorCategory).reduce<Record<TypeErrorCategory, number>>(
      (acc, category) => {
        acc[category] = this.errors.filter(e => e.category === category).length;
        return acc;
      },
      initializeErrorCounters()
    );

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
   * Get error history with type-safe filtering
   */
  getErrorHistory(
    options: {
      category?: TypeErrorCategory;
      table?: string;
      limit?: number;
      since?: number;
    } = {}
  ): TypeErrorContext[] {
    // Validate options
    const validatedOptions = {
      category: options.category,
      table: typeof options.table === 'string' ? options.table : undefined,
      limit: typeof options.limit === 'number' && options.limit > 0 ? options.limit : 100,
      since: typeof options.since === 'number' ? options.since : 0
    };

    let filtered = this.errors;

    if (validatedOptions.category) {
      filtered = filtered.filter(e => e.category === validatedOptions.category);
    }
    if (validatedOptions.table) {
      filtered = filtered.filter(e => e.table === validatedOptions.table);
    }
    filtered = filtered.filter(e => e.timestamp >= validatedOptions.since);

    return filtered.slice(-validatedOptions.limit);
  }

  /**
   * Clear error history
   */
  clearHistory(): void {
    this.errors = [];
    this.validationTimes = [];
    this.startTime = Date.now();
  }
} 