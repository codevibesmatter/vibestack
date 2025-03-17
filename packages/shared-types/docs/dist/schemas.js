"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.taskCompleteSchema = exports.taskPostgresOnlySchema = exports.taskSyncableSchema = exports.projectCompleteSchema = exports.projectPostgresOnlySchema = exports.projectSyncableSchema = exports.userCompleteSchema = exports.userPostgresOnlySchema = exports.userSyncableSchema = exports.baseSchema = void 0;
const zod_1 = require("zod");
const enums_1 = require("./enums");
// Base schema for all entities
exports.baseSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    createdAt: zod_1.z.number(),
    updatedAt: zod_1.z.number(),
    version: zod_1.z.number().min(0)
});
// User schemas
exports.userSyncableSchema = exports.baseSchema.extend({
    email: zod_1.z.string().email(),
    name: zod_1.z.string().min(1),
    role: zod_1.z.nativeEnum(enums_1.UserRole),
    avatar: zod_1.z.string().url().optional(),
    lastActive: zod_1.z.number()
});
exports.userPostgresOnlySchema = zod_1.z.object({
    passwordHash: zod_1.z.string(),
    failedLoginAttempts: zod_1.z.number(),
    lastLoginIp: zod_1.z.string().optional(),
    verificationToken: zod_1.z.string().optional(),
    resetPasswordToken: zod_1.z.string().optional(),
    lastPasswordChange: zod_1.z.number().optional(),
    emailVerified: zod_1.z.boolean(),
    metadata: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional()
});
exports.userCompleteSchema = exports.userSyncableSchema.merge(exports.userPostgresOnlySchema);
// Project schemas
exports.projectSyncableSchema = exports.baseSchema.extend({
    name: zod_1.z.string().min(1),
    description: zod_1.z.string(),
    status: zod_1.z.nativeEnum(enums_1.ProjectStatus),
    ownerId: zod_1.z.string().uuid(),
    settings: zod_1.z.object({
        isPublic: zod_1.z.boolean(),
        allowGuests: zod_1.z.boolean()
    })
});
exports.projectPostgresOnlySchema = zod_1.z.object({
    deletedAt: zod_1.z.number().optional(),
    archivedReason: zod_1.z.string().optional(),
    lastBackupAt: zod_1.z.number().optional(),
    auditLog: zod_1.z.array(zod_1.z.object({
        action: zod_1.z.string(),
        userId: zod_1.z.string(),
        timestamp: zod_1.z.number(),
        details: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown())
    })).optional(),
    metadata: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional()
});
exports.projectCompleteSchema = exports.projectSyncableSchema.merge(exports.projectPostgresOnlySchema);
// Task schemas
exports.taskSyncableSchema = exports.baseSchema.extend({
    title: zod_1.z.string().min(1),
    description: zod_1.z.string(),
    status: zod_1.z.nativeEnum(enums_1.TaskStatus),
    priority: zod_1.z.nativeEnum(enums_1.TaskPriority),
    projectId: zod_1.z.string().uuid(),
    assigneeId: zod_1.z.string().uuid(),
    dueDate: zod_1.z.number().optional(),
    completedAt: zod_1.z.number().optional(),
    tags: zod_1.z.array(zod_1.z.string())
});
exports.taskPostgresOnlySchema = zod_1.z.object({
    timeTracking: zod_1.z.array(zod_1.z.object({
        startTime: zod_1.z.number(),
        endTime: zod_1.z.number().optional(),
        userId: zod_1.z.string()
    })).optional(),
    comments: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string(),
        content: zod_1.z.string(),
        userId: zod_1.z.string(),
        createdAt: zod_1.z.number(),
        editedAt: zod_1.z.number().optional()
    })).optional(),
    history: zod_1.z.array(zod_1.z.object({
        field: zod_1.z.string(),
        oldValue: zod_1.z.unknown(),
        newValue: zod_1.z.unknown(),
        userId: zod_1.z.string(),
        timestamp: zod_1.z.number()
    })).optional(),
    metadata: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional()
});
exports.taskCompleteSchema = exports.taskSyncableSchema.merge(exports.taskPostgresOnlySchema);
