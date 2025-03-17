"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.taskCommentValidation = exports.taskTimeEntryValidation = exports.taskValidation = exports.projectValidation = exports.projectSettingsValidation = exports.userAuthValidation = exports.userValidation = exports.baseValidation = void 0;
const zod_1 = require("zod");
const enums_1 = require("../domain/enums");
/**
 * Base validation schema
 */
exports.baseValidation = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    createdAt: zod_1.z.number().positive(),
    updatedAt: zod_1.z.number().positive(),
    version: zod_1.z.number().min(0)
});
/**
 * User validation schemas
 */
exports.userValidation = exports.baseValidation.extend({
    email: zod_1.z.string().email(),
    name: zod_1.z.string().min(1),
    role: zod_1.z.nativeEnum(enums_1.UserRole),
    avatar: zod_1.z.string().url().optional(),
    lastActive: zod_1.z.number()
});
exports.userAuthValidation = zod_1.z.object({
    email: zod_1.z.string().email(),
    passwordHash: zod_1.z.string().min(60), // bcrypt hash length
    failedLoginAttempts: zod_1.z.number().min(0),
    lastLoginIp: zod_1.z.string().ip().optional(),
    verificationToken: zod_1.z.string().optional(),
    resetPasswordToken: zod_1.z.string().optional(),
    lastPasswordChange: zod_1.z.number().optional(),
    emailVerified: zod_1.z.boolean()
});
/**
 * Project validation schemas
 */
exports.projectSettingsValidation = zod_1.z.object({
    isPublic: zod_1.z.boolean(),
    allowGuests: zod_1.z.boolean(),
    defaultTaskStatus: zod_1.z.nativeEnum(enums_1.TaskStatus).optional(),
    defaultTaskPriority: zod_1.z.nativeEnum(enums_1.TaskPriority).optional(),
    customFields: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional()
});
exports.projectValidation = exports.baseValidation.extend({
    name: zod_1.z.string().min(1),
    description: zod_1.z.string(),
    status: zod_1.z.nativeEnum(enums_1.ProjectStatus),
    ownerId: zod_1.z.string().uuid(),
    settings: exports.projectSettingsValidation
});
/**
 * Task validation schemas
 */
exports.taskValidation = exports.baseValidation.extend({
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
exports.taskTimeEntryValidation = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    taskId: zod_1.z.string().uuid(),
    userId: zod_1.z.string().uuid(),
    startTime: zod_1.z.number(),
    endTime: zod_1.z.number().optional(),
    duration: zod_1.z.number().optional(),
    description: zod_1.z.string().optional(),
    metadata: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional()
});
exports.taskCommentValidation = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    taskId: zod_1.z.string().uuid(),
    userId: zod_1.z.string().uuid(),
    content: zod_1.z.string().min(1),
    createdAt: zod_1.z.number(),
    editedAt: zod_1.z.number().optional(),
    mentions: zod_1.z.array(zod_1.z.string().uuid()).optional(),
    attachments: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string().uuid(),
        name: zod_1.z.string(),
        type: zod_1.z.string(),
        size: zod_1.z.number(),
        url: zod_1.z.string().url()
    })).optional()
});
