import { validate, ValidationError } from 'class-validator';
import { plainToInstance } from 'class-transformer';

/**
 * ValidationResult interface
 * Contains validation errors and a flag indicating if validation passed
 */
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationErrorInfo[];
}

/**
 * ValidationErrorInfo interface
 * Contains information about a validation error
 */
export interface ValidationErrorInfo {
  property: string;
  constraints: Record<string, string>;
  children?: ValidationErrorInfo[];
}

/**
 * Formats validation errors from class-validator into a more usable format
 * @param errors The validation errors from class-validator
 * @returns An array of formatted validation errors
 */
function formatValidationErrors(errors: ValidationError[]): ValidationErrorInfo[] {
  return errors.map(error => {
    const formattedError: ValidationErrorInfo = {
      property: error.property,
      constraints: error.constraints || {},
    };

    if (error.children && error.children.length > 0) {
      formattedError.children = formatValidationErrors(error.children);
    }

    return formattedError;
  });
}

/**
 * Validates an entity using class-validator
 * @param entity The entity to validate
 * @param entityClass The entity class
 * @returns A promise that resolves to a ValidationResult
 */
export async function validateEntity<T extends object>(
  entity: Partial<T>, 
  entityClass: new () => T
): Promise<ValidationResult> {
  // Convert plain object to class instance
  const entityInstance = plainToInstance(entityClass, entity);
  
  // Validate the entity
  const errors = await validate(entityInstance, {
    skipMissingProperties: true, // Skip properties that don't exist in the entity
    whitelist: true, // Remove properties that don't exist in the entity
    forbidNonWhitelisted: true, // Throw an error if a property doesn't exist in the entity
  });
  
  // Format the errors
  const formattedErrors = formatValidationErrors(errors);
  
  return {
    isValid: errors.length === 0,
    errors: formattedErrors,
  };
}

/**
 * Validates an entity and throws an error if validation fails
 * @param entity The entity to validate
 * @param entityClass The entity class
 * @throws Error if validation fails
 */
export async function validateEntityOrThrow<T extends object>(
  entity: Partial<T>, 
  entityClass: new () => T
): Promise<void> {
  const result = await validateEntity(entity, entityClass);
  
  if (!result.isValid) {
    // Create a detailed error message
    const errorMessages = result.errors.map(error => {
      const constraints = Object.values(error.constraints).join(', ');
      return `${error.property}: ${constraints}`;
    }).join('\n');
    
    throw new Error(`Validation failed:\n${errorMessages}`);
  }
} 