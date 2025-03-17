import { z } from 'zod';
import type { Result, SerializationError, SerializationOptions } from './types';

const dateSchema = z.date();
const objectSchema = z.record(z.unknown());

/**
 * Type guard for Date objects
 */
export function isDate(value: unknown): value is Date {
  return dateSchema.safeParse(value).success;
}

/**
 * Type guard for objects
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return objectSchema.safeParse(value).success;
}

/**
 * Safely stringify data to JSON
 */
export function safeStringify(data: unknown, options: SerializationOptions = {}): Result<string> {
  try {
    const serialized = JSON.stringify(data, (key, value) => {
      if (isDate(value)) {
        return { __type: 'Date', value: value.toISOString() };
      }
      return value;
    }, options.pretty ? 2 : undefined);

    return { success: true, data: serialized };
  } catch (error) {
    const serializationError: SerializationError = {
      type: 'serialization_error',
      message: error instanceof Error ? error.message : 'Unknown serialization error',
      details: { data }
    };
    return { success: false, error: serializationError };
  }
}

interface ParseSuccess<T> {
  success: true;
  data: T;
}

interface ParseError {
  success: false;
  error: Error;
}

type ParseResult<T> = ParseSuccess<T> | ParseError;

/**
 * Safely parse a JSON string with proper error handling and typing
 */
export function safeParse<T>(data: string, validate?: (parsed: unknown) => parsed is T): Result<T> {
  try {
    const parsed = JSON.parse(data, (key, value) => {
      if (isObject(value) && value.__type === 'Date') {
        const dateStr = value.value;
        if (typeof dateStr === 'string') {
          const date = new Date(dateStr);
          if (!isNaN(date.getTime())) {
            return date;
          }
        }
      }
      return value;
    });

    if (validate) {
      if (!validate(parsed)) {
        const validationError: SerializationError = {
          type: 'validation_error',
          message: 'Data validation failed',
          details: { data: parsed }
        };
        return { success: false, error: validationError };
      }
      return { success: true, data: parsed };
    }

    // If no validator is provided, we can only guarantee it's of type unknown
    const validationError: SerializationError = {
      type: 'validation_error',
      message: 'No validator provided for type checking',
      details: { data: parsed }
    };
    return { success: false, error: validationError };
  } catch (error) {
    const parseError: SerializationError = {
      type: 'parse_error',
      message: error instanceof Error ? error.message : 'Unknown parse error',
      details: { data }
    };
    return { success: false, error: parseError };
  }
}

/**
 * Validate data against a schema
 */
export function validateData<T>(data: unknown, schema: z.ZodType<T>): Result<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const validationError: SerializationError = {
      type: 'validation_error',
      message: 'Schema validation failed',
      details: { errors: result.error.errors }
    };
    return { success: false, error: validationError };
  }
  return { success: true, data: result.data };
}

/**
 * Type guard for schema-validated data
 */
export function isValidData<T>(data: unknown, schema: z.ZodType<T>): data is T {
  return schema.safeParse(data).success;
} 