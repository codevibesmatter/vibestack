import { z } from 'zod';
import type { Result, SerializationOptions } from './types';
/**
 * Type guard for Date objects
 */
export declare function isDate(value: unknown): value is Date;
/**
 * Type guard for objects
 */
export declare function isObject(value: unknown): value is Record<string, unknown>;
/**
 * Safely stringify data to JSON
 */
export declare function safeStringify(data: unknown, options?: SerializationOptions): Result<string>;
/**
 * Safely parse a JSON string with proper error handling and typing
 */
export declare function safeParse<T>(data: string, validate?: (parsed: unknown) => parsed is T): Result<T>;
/**
 * Validate data against a schema
 */
export declare function validateData<T>(data: unknown, schema: z.ZodType<T>): Result<T>;
/**
 * Type guard for schema-validated data
 */
export declare function isValidData<T>(data: unknown, schema: z.ZodType<T>): data is T;
//# sourceMappingURL=utils.d.ts.map