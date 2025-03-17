import { z } from 'zod';
import { UserRole, ProjectStatus, TaskStatus, TaskPriority } from '../enums';
export declare const baseSchema: z.ZodObject<{
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
export type BaseSchema = z.infer<typeof baseSchema>;
export declare const projectSettingsSchema: z.ZodObject<{
    isPublic: z.ZodBoolean;
    allowGuests: z.ZodBoolean;
    defaultTaskStatus: z.ZodNativeEnum<typeof TaskStatus>;
    defaultTaskPriority: z.ZodNativeEnum<typeof TaskPriority>;
    customFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    isPublic: boolean;
    allowGuests: boolean;
    defaultTaskStatus: TaskStatus;
    defaultTaskPriority: TaskPriority;
    customFields?: Record<string, unknown> | undefined;
}, {
    isPublic: boolean;
    allowGuests: boolean;
    defaultTaskStatus: TaskStatus;
    defaultTaskPriority: TaskPriority;
    customFields?: Record<string, unknown> | undefined;
}>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export declare const userSyncableSchema: z.ZodObject<z.objectUtil.extendShape<{
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
export declare const userPostgresOnlySchema: z.ZodObject<{
    passwordHash: z.ZodString;
    failedLoginAttempts: z.ZodNumber;
    lastLoginIp: z.ZodOptional<z.ZodString>;
    verificationToken: z.ZodOptional<z.ZodString>;
    resetPasswordToken: z.ZodOptional<z.ZodString>;
    lastPasswordChange: z.ZodOptional<z.ZodNumber>;
    emailVerified: z.ZodBoolean;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    passwordHash: string;
    failedLoginAttempts: number;
    emailVerified: boolean;
    lastLoginIp?: string | undefined;
    verificationToken?: string | undefined;
    resetPasswordToken?: string | undefined;
    lastPasswordChange?: number | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    passwordHash: string;
    failedLoginAttempts: number;
    emailVerified: boolean;
    lastLoginIp?: string | undefined;
    verificationToken?: string | undefined;
    resetPasswordToken?: string | undefined;
    lastPasswordChange?: number | undefined;
    metadata?: Record<string, unknown> | undefined;
}>;
export declare const userCompleteSchema: z.ZodObject<z.objectUtil.extendShape<z.objectUtil.extendShape<{
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
}>, {
    passwordHash: z.ZodString;
    failedLoginAttempts: z.ZodNumber;
    lastLoginIp: z.ZodOptional<z.ZodString>;
    verificationToken: z.ZodOptional<z.ZodString>;
    resetPasswordToken: z.ZodOptional<z.ZodString>;
    lastPasswordChange: z.ZodOptional<z.ZodNumber>;
    emailVerified: z.ZodBoolean;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}>, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    email: string;
    name: string;
    role: UserRole;
    lastActive: number;
    passwordHash: string;
    failedLoginAttempts: number;
    emailVerified: boolean;
    avatar?: string | undefined;
    lastLoginIp?: string | undefined;
    verificationToken?: string | undefined;
    resetPasswordToken?: string | undefined;
    lastPasswordChange?: number | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    id: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    email: string;
    name: string;
    role: UserRole;
    lastActive: number;
    passwordHash: string;
    failedLoginAttempts: number;
    emailVerified: boolean;
    avatar?: string | undefined;
    lastLoginIp?: string | undefined;
    verificationToken?: string | undefined;
    resetPasswordToken?: string | undefined;
    lastPasswordChange?: number | undefined;
    metadata?: Record<string, unknown> | undefined;
}>;
export type UserSyncable = z.infer<typeof userSyncableSchema>;
export type UserPostgresOnly = z.infer<typeof userPostgresOnlySchema>;
export type UserComplete = z.infer<typeof userCompleteSchema>;
export declare const projectSyncableSchema: z.ZodObject<z.objectUtil.extendShape<{
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
        defaultTaskStatus: z.ZodNativeEnum<typeof TaskStatus>;
        defaultTaskPriority: z.ZodNativeEnum<typeof TaskPriority>;
        customFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        isPublic: boolean;
        allowGuests: boolean;
        defaultTaskStatus: TaskStatus;
        defaultTaskPriority: TaskPriority;
        customFields?: Record<string, unknown> | undefined;
    }, {
        isPublic: boolean;
        allowGuests: boolean;
        defaultTaskStatus: TaskStatus;
        defaultTaskPriority: TaskPriority;
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
        defaultTaskStatus: TaskStatus;
        defaultTaskPriority: TaskPriority;
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
        defaultTaskStatus: TaskStatus;
        defaultTaskPriority: TaskPriority;
        customFields?: Record<string, unknown> | undefined;
    };
}>;
export declare const projectPostgresOnlySchema: z.ZodObject<{
    deletedAt: z.ZodOptional<z.ZodNumber>;
    archivedReason: z.ZodOptional<z.ZodString>;
    lastBackupAt: z.ZodOptional<z.ZodNumber>;
    auditLog: z.ZodOptional<z.ZodArray<z.ZodObject<{
        action: z.ZodString;
        userId: z.ZodString;
        timestamp: z.ZodNumber;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        action: string;
        userId: string;
        timestamp: number;
        details: Record<string, unknown>;
    }, {
        action: string;
        userId: string;
        timestamp: number;
        details: Record<string, unknown>;
    }>, "many">>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    metadata?: Record<string, unknown> | undefined;
    deletedAt?: number | undefined;
    archivedReason?: string | undefined;
    lastBackupAt?: number | undefined;
    auditLog?: {
        action: string;
        userId: string;
        timestamp: number;
        details: Record<string, unknown>;
    }[] | undefined;
}, {
    metadata?: Record<string, unknown> | undefined;
    deletedAt?: number | undefined;
    archivedReason?: string | undefined;
    lastBackupAt?: number | undefined;
    auditLog?: {
        action: string;
        userId: string;
        timestamp: number;
        details: Record<string, unknown>;
    }[] | undefined;
}>;
export declare const projectCompleteSchema: z.ZodObject<z.objectUtil.extendShape<z.objectUtil.extendShape<{
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
        defaultTaskStatus: z.ZodNativeEnum<typeof TaskStatus>;
        defaultTaskPriority: z.ZodNativeEnum<typeof TaskPriority>;
        customFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        isPublic: boolean;
        allowGuests: boolean;
        defaultTaskStatus: TaskStatus;
        defaultTaskPriority: TaskPriority;
        customFields?: Record<string, unknown> | undefined;
    }, {
        isPublic: boolean;
        allowGuests: boolean;
        defaultTaskStatus: TaskStatus;
        defaultTaskPriority: TaskPriority;
        customFields?: Record<string, unknown> | undefined;
    }>;
}>, {
    deletedAt: z.ZodOptional<z.ZodNumber>;
    archivedReason: z.ZodOptional<z.ZodString>;
    lastBackupAt: z.ZodOptional<z.ZodNumber>;
    auditLog: z.ZodOptional<z.ZodArray<z.ZodObject<{
        action: z.ZodString;
        userId: z.ZodString;
        timestamp: z.ZodNumber;
        details: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        action: string;
        userId: string;
        timestamp: number;
        details: Record<string, unknown>;
    }, {
        action: string;
        userId: string;
        timestamp: number;
        details: Record<string, unknown>;
    }>, "many">>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
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
        defaultTaskStatus: TaskStatus;
        defaultTaskPriority: TaskPriority;
        customFields?: Record<string, unknown> | undefined;
    };
    metadata?: Record<string, unknown> | undefined;
    deletedAt?: number | undefined;
    archivedReason?: string | undefined;
    lastBackupAt?: number | undefined;
    auditLog?: {
        action: string;
        userId: string;
        timestamp: number;
        details: Record<string, unknown>;
    }[] | undefined;
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
        defaultTaskStatus: TaskStatus;
        defaultTaskPriority: TaskPriority;
        customFields?: Record<string, unknown> | undefined;
    };
    metadata?: Record<string, unknown> | undefined;
    deletedAt?: number | undefined;
    archivedReason?: string | undefined;
    lastBackupAt?: number | undefined;
    auditLog?: {
        action: string;
        userId: string;
        timestamp: number;
        details: Record<string, unknown>;
    }[] | undefined;
}>;
export type ProjectSyncable = z.infer<typeof projectSyncableSchema>;
export type ProjectPostgresOnly = z.infer<typeof projectPostgresOnlySchema>;
export type ProjectComplete = z.infer<typeof projectCompleteSchema>;
export declare const taskSyncableSchema: z.ZodObject<z.objectUtil.extendShape<{
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
    description: string;
    title: string;
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
    description: string;
    title: string;
    priority: TaskPriority;
    projectId: string;
    assigneeId: string;
    tags: string[];
    dueDate?: number | undefined;
    completedAt?: number | undefined;
}>;
export declare const taskPostgresOnlySchema: z.ZodObject<{
    timeTracking: z.ZodOptional<z.ZodArray<z.ZodObject<{
        startTime: z.ZodNumber;
        endTime: z.ZodOptional<z.ZodNumber>;
        userId: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        userId: string;
        startTime: number;
        endTime?: number | undefined;
    }, {
        userId: string;
        startTime: number;
        endTime?: number | undefined;
    }>, "many">>;
    comments: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        content: z.ZodString;
        userId: z.ZodString;
        createdAt: z.ZodNumber;
        editedAt: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        createdAt: number;
        userId: string;
        content: string;
        editedAt?: number | undefined;
    }, {
        id: string;
        createdAt: number;
        userId: string;
        content: string;
        editedAt?: number | undefined;
    }>, "many">>;
    history: z.ZodOptional<z.ZodArray<z.ZodObject<{
        field: z.ZodString;
        oldValue: z.ZodUnknown;
        newValue: z.ZodUnknown;
        userId: z.ZodString;
        timestamp: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        userId: string;
        timestamp: number;
        field: string;
        oldValue?: unknown;
        newValue?: unknown;
    }, {
        userId: string;
        timestamp: number;
        field: string;
        oldValue?: unknown;
        newValue?: unknown;
    }>, "many">>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    metadata?: Record<string, unknown> | undefined;
    timeTracking?: {
        userId: string;
        startTime: number;
        endTime?: number | undefined;
    }[] | undefined;
    comments?: {
        id: string;
        createdAt: number;
        userId: string;
        content: string;
        editedAt?: number | undefined;
    }[] | undefined;
    history?: {
        userId: string;
        timestamp: number;
        field: string;
        oldValue?: unknown;
        newValue?: unknown;
    }[] | undefined;
}, {
    metadata?: Record<string, unknown> | undefined;
    timeTracking?: {
        userId: string;
        startTime: number;
        endTime?: number | undefined;
    }[] | undefined;
    comments?: {
        id: string;
        createdAt: number;
        userId: string;
        content: string;
        editedAt?: number | undefined;
    }[] | undefined;
    history?: {
        userId: string;
        timestamp: number;
        field: string;
        oldValue?: unknown;
        newValue?: unknown;
    }[] | undefined;
}>;
export declare const taskCompleteSchema: z.ZodObject<z.objectUtil.extendShape<z.objectUtil.extendShape<{
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
}>, {
    timeTracking: z.ZodOptional<z.ZodArray<z.ZodObject<{
        startTime: z.ZodNumber;
        endTime: z.ZodOptional<z.ZodNumber>;
        userId: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        userId: string;
        startTime: number;
        endTime?: number | undefined;
    }, {
        userId: string;
        startTime: number;
        endTime?: number | undefined;
    }>, "many">>;
    comments: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        content: z.ZodString;
        userId: z.ZodString;
        createdAt: z.ZodNumber;
        editedAt: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        createdAt: number;
        userId: string;
        content: string;
        editedAt?: number | undefined;
    }, {
        id: string;
        createdAt: number;
        userId: string;
        content: string;
        editedAt?: number | undefined;
    }>, "many">>;
    history: z.ZodOptional<z.ZodArray<z.ZodObject<{
        field: z.ZodString;
        oldValue: z.ZodUnknown;
        newValue: z.ZodUnknown;
        userId: z.ZodString;
        timestamp: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        userId: string;
        timestamp: number;
        field: string;
        oldValue?: unknown;
        newValue?: unknown;
    }, {
        userId: string;
        timestamp: number;
        field: string;
        oldValue?: unknown;
        newValue?: unknown;
    }>, "many">>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}>, "strip", z.ZodTypeAny, {
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
    metadata?: Record<string, unknown> | undefined;
    dueDate?: number | undefined;
    completedAt?: number | undefined;
    timeTracking?: {
        userId: string;
        startTime: number;
        endTime?: number | undefined;
    }[] | undefined;
    comments?: {
        id: string;
        createdAt: number;
        userId: string;
        content: string;
        editedAt?: number | undefined;
    }[] | undefined;
    history?: {
        userId: string;
        timestamp: number;
        field: string;
        oldValue?: unknown;
        newValue?: unknown;
    }[] | undefined;
}, {
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
    metadata?: Record<string, unknown> | undefined;
    dueDate?: number | undefined;
    completedAt?: number | undefined;
    timeTracking?: {
        userId: string;
        startTime: number;
        endTime?: number | undefined;
    }[] | undefined;
    comments?: {
        id: string;
        createdAt: number;
        userId: string;
        content: string;
        editedAt?: number | undefined;
    }[] | undefined;
    history?: {
        userId: string;
        timestamp: number;
        field: string;
        oldValue?: unknown;
        newValue?: unknown;
    }[] | undefined;
}>;
export type TaskSyncable = z.infer<typeof taskSyncableSchema>;
export type TaskPostgresOnly = z.infer<typeof taskPostgresOnlySchema>;
export type TaskComplete = z.infer<typeof taskCompleteSchema>;
export { UserRole, ProjectStatus, TaskStatus, TaskPriority };
