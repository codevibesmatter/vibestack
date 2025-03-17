import { z } from 'zod';
import { UserRole, ProjectStatus, TaskStatus, TaskPriority } from '../domain/enums';
/**
 * Base validation schema
 */
export declare const baseValidation: z.ZodObject<{
    id: z.ZodString;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    version: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
}, {
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
}>;
/**
 * User validation schemas
 */
export declare const userValidation: z.ZodObject<z.objectUtil.extendShape<{
    id: z.ZodString;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    version: z.ZodNumber;
}, {
    email: z.ZodString;
    name: z.ZodString;
    role: z.ZodNativeEnum<typeof UserRole>;
    avatar: z.ZodOptional<z.ZodString>;
    lastActive: z.ZodNumber;
}>, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    email: string;
    name: string;
    role: UserRole;
    lastActive: number;
    avatar?: string | undefined;
}, {
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    email: string;
    name: string;
    role: UserRole;
    lastActive: number;
    avatar?: string | undefined;
}>;
export declare const userAuthValidation: z.ZodObject<{
    email: z.ZodString;
    passwordHash: z.ZodString;
    failedLoginAttempts: z.ZodNumber;
    lastLoginIp: z.ZodOptional<z.ZodString>;
    verificationToken: z.ZodOptional<z.ZodString>;
    resetPasswordToken: z.ZodOptional<z.ZodString>;
    lastPasswordChange: z.ZodOptional<z.ZodNumber>;
    emailVerified: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    email: string;
    passwordHash: string;
    failedLoginAttempts: number;
    emailVerified: boolean;
    lastLoginIp?: string | undefined;
    verificationToken?: string | undefined;
    resetPasswordToken?: string | undefined;
    lastPasswordChange?: number | undefined;
}, {
    email: string;
    passwordHash: string;
    failedLoginAttempts: number;
    emailVerified: boolean;
    lastLoginIp?: string | undefined;
    verificationToken?: string | undefined;
    resetPasswordToken?: string | undefined;
    lastPasswordChange?: number | undefined;
}>;
/**
 * Project validation schemas
 */
export declare const projectSettingsValidation: z.ZodObject<{
    isPublic: z.ZodBoolean;
    allowGuests: z.ZodBoolean;
    defaultTaskStatus: z.ZodOptional<z.ZodNativeEnum<typeof TaskStatus>>;
    defaultTaskPriority: z.ZodOptional<z.ZodNativeEnum<typeof TaskPriority>>;
    customFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    isPublic: boolean;
    allowGuests: boolean;
    defaultTaskStatus?: TaskStatus | undefined;
    defaultTaskPriority?: TaskPriority | undefined;
    customFields?: Record<string, unknown> | undefined;
}, {
    isPublic: boolean;
    allowGuests: boolean;
    defaultTaskStatus?: TaskStatus | undefined;
    defaultTaskPriority?: TaskPriority | undefined;
    customFields?: Record<string, unknown> | undefined;
}>;
export declare const projectValidation: z.ZodObject<z.objectUtil.extendShape<{
    id: z.ZodString;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    version: z.ZodNumber;
}, {
    name: z.ZodString;
    description: z.ZodString;
    status: z.ZodNativeEnum<typeof ProjectStatus>;
    ownerId: z.ZodString;
    settings: z.ZodObject<{
        isPublic: z.ZodBoolean;
        allowGuests: z.ZodBoolean;
        defaultTaskStatus: z.ZodOptional<z.ZodNativeEnum<typeof TaskStatus>>;
        defaultTaskPriority: z.ZodOptional<z.ZodNativeEnum<typeof TaskPriority>>;
        customFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        isPublic: boolean;
        allowGuests: boolean;
        defaultTaskStatus?: TaskStatus | undefined;
        defaultTaskPriority?: TaskPriority | undefined;
        customFields?: Record<string, unknown> | undefined;
    }, {
        isPublic: boolean;
        allowGuests: boolean;
        defaultTaskStatus?: TaskStatus | undefined;
        defaultTaskPriority?: TaskPriority | undefined;
        customFields?: Record<string, unknown> | undefined;
    }>;
}>, "strip", z.ZodTypeAny, {
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
        defaultTaskStatus?: TaskStatus | undefined;
        defaultTaskPriority?: TaskPriority | undefined;
        customFields?: Record<string, unknown> | undefined;
    };
}, {
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
        defaultTaskStatus?: TaskStatus | undefined;
        defaultTaskPriority?: TaskPriority | undefined;
        customFields?: Record<string, unknown> | undefined;
    };
}>;
/**
 * Task validation schemas
 */
export declare const taskValidation: z.ZodObject<z.objectUtil.extendShape<{
    id: z.ZodString;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    version: z.ZodNumber;
}, {
    title: z.ZodString;
    description: z.ZodString;
    status: z.ZodNativeEnum<typeof TaskStatus>;
    priority: z.ZodNativeEnum<typeof TaskPriority>;
    projectId: z.ZodString;
    assigneeId: z.ZodString;
    dueDate: z.ZodOptional<z.ZodNumber>;
    completedAt: z.ZodOptional<z.ZodNumber>;
    tags: z.ZodArray<z.ZodString, "many">;
}>, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    status: TaskStatus;
    title: string;
    description: string;
    priority: TaskPriority;
    projectId: string;
    assigneeId: string;
    tags: string[];
    dueDate?: number | undefined;
    completedAt?: number | undefined;
}, {
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    status: TaskStatus;
    title: string;
    description: string;
    priority: TaskPriority;
    projectId: string;
    assigneeId: string;
    tags: string[];
    dueDate?: number | undefined;
    completedAt?: number | undefined;
}>;
export declare const taskTimeEntryValidation: z.ZodObject<{
    id: z.ZodString;
    taskId: z.ZodString;
    userId: z.ZodString;
    startTime: z.ZodNumber;
    endTime: z.ZodOptional<z.ZodNumber>;
    duration: z.ZodOptional<z.ZodNumber>;
    description: z.ZodOptional<z.ZodString>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    taskId: string;
    userId: string;
    startTime: number;
    description?: string | undefined;
    endTime?: number | undefined;
    duration?: number | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    id: string;
    taskId: string;
    userId: string;
    startTime: number;
    description?: string | undefined;
    endTime?: number | undefined;
    duration?: number | undefined;
    metadata?: Record<string, unknown> | undefined;
}>;
export declare const taskCommentValidation: z.ZodObject<{
    id: z.ZodString;
    taskId: z.ZodString;
    userId: z.ZodString;
    content: z.ZodString;
    createdAt: z.ZodNumber;
    editedAt: z.ZodOptional<z.ZodNumber>;
    mentions: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    attachments: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        type: z.ZodString;
        size: z.ZodNumber;
        url: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: string;
        name: string;
        size: number;
        url: string;
    }, {
        id: string;
        type: string;
        name: string;
        size: number;
        url: string;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: number;
    taskId: string;
    userId: string;
    content: string;
    editedAt?: number | undefined;
    mentions?: string[] | undefined;
    attachments?: {
        id: string;
        type: string;
        name: string;
        size: number;
        url: string;
    }[] | undefined;
}, {
    id: string;
    createdAt: number;
    taskId: string;
    userId: string;
    content: string;
    editedAt?: number | undefined;
    mentions?: string[] | undefined;
    attachments?: {
        id: string;
        type: string;
        name: string;
        size: number;
        url: string;
    }[] | undefined;
}>;
export type ValidatedBase = z.infer<typeof baseValidation>;
export type ValidatedUser = z.infer<typeof userValidation>;
export type ValidatedUserAuth = z.infer<typeof userAuthValidation>;
export type ValidatedProject = z.infer<typeof projectValidation>;
export type ValidatedProjectSettings = z.infer<typeof projectSettingsValidation>;
export type ValidatedTask = z.infer<typeof taskValidation>;
export type ValidatedTaskTimeEntry = z.infer<typeof taskTimeEntryValidation>;
export type ValidatedTaskComment = z.infer<typeof taskCommentValidation>;
