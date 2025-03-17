import { z } from 'zod';
import { UserRole, ProjectStatus, TaskStatus, TaskPriority } from '../domain/enums';
import { type UserSyncable, type ProjectSyncable, type TaskSyncable } from '../domain/schemas';
/**
 * Type guard for UserSyncable
 * @param data Unknown data to check
 * @returns Type predicate indicating if data is UserSyncable
 */
export declare function isUserData(data: unknown): data is UserSyncable;
/**
 * Type guard for ProjectSyncable
 * @param data Unknown data to check
 * @returns Type predicate indicating if data is ProjectSyncable
 */
export declare function isProjectData(data: unknown): data is ProjectSyncable;
/**
 * Type guard for TaskSyncable
 * @param data Unknown data to check
 * @returns Type predicate indicating if data is TaskSyncable
 */
export declare function isTaskData(data: unknown): data is TaskSyncable;
/**
 * Generic type guard for Zod schema
 * @param schema Zod schema to validate against
 * @returns Type guard function for the schema type
 */
export declare function createTypeGuard<T>(schema: z.ZodType<T>): (data: unknown) => data is T;
export declare const createUserGuard: () => (data: unknown) => data is {
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    email: string;
    name: string;
    role: UserRole;
    lastActive: number;
    avatar?: string | undefined;
};
export declare const createProjectGuard: () => (data: unknown) => data is {
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    status: ProjectStatus;
    name: string;
    description: string;
    ownerId: string;
    settings: {
        isPublic: boolean;
        allowGuests: boolean;
        defaultTaskStatus: TaskStatus;
        defaultTaskPriority: TaskPriority;
        customFields?: Record<string, unknown> | undefined;
    };
};
export declare const createTaskGuard: () => (data: unknown) => data is {
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    status: TaskStatus;
    description: string;
    title: string;
    priority: TaskPriority;
    projectId: string;
    assigneeId: string;
    tags: string[];
    dueDate?: number | undefined;
    completedAt?: number | undefined;
};
