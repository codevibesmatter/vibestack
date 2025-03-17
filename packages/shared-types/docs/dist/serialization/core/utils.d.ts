import { z } from 'zod';
import { SerializationError } from './types';
import type { Result, SerializationOptions, ValidationError } from './types';
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
export declare function safeStringify<T>(data: T, options?: SerializationOptions): Result<string, SerializationError>;
/**
 * Safely parse JSON data with schema validation
 */
export declare function safeParse<T>(input: string, schema: z.ZodSchema<T>, options?: SerializationOptions): Result<T, SerializationError>;
/**
 * Validate data against a schema
 */
export declare function validateData<T>(data: unknown, schema: z.ZodSchema<T>, options?: SerializationOptions): Result<T, ValidationError[]>;
/**
 * Type guard for schema-validated data
 */
export declare function isValidData<T>(data: unknown, schema: z.ZodSchema<T>): data is T;
