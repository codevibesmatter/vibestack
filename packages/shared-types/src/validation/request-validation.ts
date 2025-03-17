import { z } from 'zod';
import { ValidationResult, validateWithSchema } from './validators';
import { isPlainObject } from './type-guards';

// Schema for headers validation
const headersSchema = z.union([
  z.instanceof(Headers),
  z.array(z.tuple([z.string(), z.string()])),
  z.record(z.string())
]);

// Schema for HTTP status code
const statusSchema = z.number()
  .int()
  .min(100)
  .max(599);

// Response init schema with improved validation
const responseInitSchema = z.object({
  status: statusSchema.optional(),
  statusText: z.string().optional(),
  headers: headersSchema.optional()
}).strict();

type ValidatedResponseInit = z.infer<typeof responseInitSchema>;

// Helper function to check content type
const hasJsonContentType = (contentType: string): boolean => 
  contentType.includes('application/json');

/**
 * Type guard for checking if a value is a valid JSON content type
 */
export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return hasJsonContentType(contentType);
}

/**
 * Type guard for Response initialization using schema validation
 */
export function isResponseInit(value: unknown): value is ResponseInit {
  return responseInitSchema.safeParse(value).success;
}

/**
 * Validates request data against a schema
 */
export function validateRequestData<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): ValidationResult<T> {
  return validateWithSchema(schema, data);
}

/**
 * Creates a request data validator for a specific schema
 */
export function createRequestValidator<T>(schema: z.ZodSchema<T>) {
  return (data: unknown): ValidationResult<T> => validateRequestData(schema, data);
}

/**
 * Validate response init options
 */
export function validateResponseInit(value: unknown): value is ResponseInit {
  return responseInitSchema.safeParse(value).success;
}

// Helper function to format validation errors
const formatValidationErrors = (errors: z.ZodError): string => 
  errors.errors
    .map(err => `${err.path.join('.')}: ${err.message}`)
    .join(', ');

/**
 * Validate and transform response init options with detailed error messages
 */
export function getValidatedResponseInit(value: unknown): ResponseInit {
  const validation = responseInitSchema.safeParse(value);
  
  if (!validation.success) {
    const errors = formatValidationErrors(validation.error);
    throw new Error(`Invalid response init options: ${errors}`);
  }
  
  return validation.data;
} 