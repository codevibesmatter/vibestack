import { z } from 'zod';
import { type UserSyncable, type ProjectSyncable, type TaskSyncable } from '../domain/schemas';
export declare class ValidationError extends Error {
    readonly zodError: z.ZodError;
    constructor(zodError: z.ZodError, message?: string);
    getFormattedErrors(): Record<string, string[]>;
}
export interface ValidationResult<T> {
    ok: boolean;
    data?: T;
    error?: ValidationError;
}
/**
 * Validates unknown data against a Zod schema
 * @param schema Zod schema to validate against
 * @param data Data to validate
 * @returns Validation result with typed data or error
 */
export declare function validateWithSchema<T>(schema: z.ZodType<T>, data: unknown): ValidationResult<T>;
/**
 * Validates user data
 * @param data Unknown data to validate as user
 * @returns Validation result with UserSyncable or error
 */
export declare function validateUser(data: unknown): ValidationResult<UserSyncable>;
/**
 * Validates project data
 * @param data Unknown data to validate as project
 * @returns Validation result with ProjectSyncable or error
 */
export declare function validateProject(data: unknown): ValidationResult<ProjectSyncable>;
/**
 * Validates task data
 * @param data Unknown data to validate as task
 * @returns Validation result with TaskSyncable or error
 */
export declare function validateTask(data: unknown): ValidationResult<TaskSyncable>;
export declare const createValidator: <T>(schema: z.ZodType<T>) => (data: unknown) => ValidationResult<T>;
export declare const createUserValidator: () => (data: unknown) => ValidationResult<{
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    email: string;
    name: string;
    role: import("../domain/schemas").UserRole;
    lastActive: number;
    avatar?: string | undefined;
}>;
export declare const createProjectValidator: () => (data: unknown) => ValidationResult<{
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    status: import("../domain/schemas").ProjectStatus;
    name: string;
    description: string;
    ownerId: string;
    settings: {
        isPublic: boolean;
        allowGuests: boolean;
        defaultTaskStatus: import("../domain/schemas").TaskStatus;
        defaultTaskPriority: import("../domain/schemas").TaskPriority;
        customFields?: Record<string, unknown> | undefined;
    };
}>;
export declare const createTaskValidator: () => (data: unknown) => ValidationResult<{
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    status: import("../domain/schemas").TaskStatus;
    description: string;
    title: string;
    priority: import("../domain/schemas").TaskPriority;
    projectId: string;
    assigneeId: string;
    tags: string[];
    dueDate?: number | undefined;
    completedAt?: number | undefined;
}>;
