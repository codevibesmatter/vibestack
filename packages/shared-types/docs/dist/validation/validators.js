"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTaskValidator = exports.createProjectValidator = exports.createUserValidator = exports.createValidator = exports.ValidationError = void 0;
exports.validateWithSchema = validateWithSchema;
exports.validateUser = validateUser;
exports.validateProject = validateProject;
exports.validateTask = validateTask;
const schemas_1 = require("../domain/schemas");
class ValidationError extends Error {
    constructor(zodError, message = 'Validation failed') {
        super(message);
        this.zodError = zodError;
        this.name = 'ValidationError';
    }
    getFormattedErrors() {
        const errors = this.zodError.flatten().fieldErrors;
        return Object.fromEntries(Object.entries(errors).map(([key, value]) => [key, value || []]));
    }
}
exports.ValidationError = ValidationError;
/**
 * Validates unknown data against a Zod schema
 * @param schema Zod schema to validate against
 * @param data Data to validate
 * @returns Validation result with typed data or error
 */
function validateWithSchema(schema, data) {
    const result = schema.safeParse(data);
    if (result.success) {
        return {
            ok: true,
            data: result.data
        };
    }
    return {
        ok: false,
        error: new ValidationError(result.error)
    };
}
/**
 * Validates user data
 * @param data Unknown data to validate as user
 * @returns Validation result with UserSyncable or error
 */
function validateUser(data) {
    return validateWithSchema(schemas_1.userSyncableSchema, data);
}
/**
 * Validates project data
 * @param data Unknown data to validate as project
 * @returns Validation result with ProjectSyncable or error
 */
function validateProject(data) {
    return validateWithSchema(schemas_1.projectSyncableSchema, data);
}
/**
 * Validates task data
 * @param data Unknown data to validate as task
 * @returns Validation result with TaskSyncable or error
 */
function validateTask(data) {
    return validateWithSchema(schemas_1.taskSyncableSchema, data);
}
// Export validator creators for reuse
const createValidator = (schema) => {
    return (data) => validateWithSchema(schema, data);
};
exports.createValidator = createValidator;
const createUserValidator = () => (0, exports.createValidator)(schemas_1.userSyncableSchema);
exports.createUserValidator = createUserValidator;
const createProjectValidator = () => (0, exports.createValidator)(schemas_1.projectSyncableSchema);
exports.createProjectValidator = createProjectValidator;
const createTaskValidator = () => (0, exports.createValidator)(schemas_1.taskSyncableSchema);
exports.createTaskValidator = createTaskValidator;
