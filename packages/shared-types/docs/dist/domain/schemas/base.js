"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectSettingsSchema = exports.baseSchema = void 0;
const zod_1 = require("zod");
/**
 * Base schema for all entities
 */
exports.baseSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    createdAt: zod_1.z.number(),
    updatedAt: zod_1.z.number(),
    version: zod_1.z.number().min(0)
});
/**
 * Project settings schema
 */
exports.projectSettingsSchema = zod_1.z.object({
    isPublic: zod_1.z.boolean(),
    allowGuests: zod_1.z.boolean(),
    defaultTaskStatus: zod_1.z.string(),
    defaultTaskPriority: zod_1.z.string(),
    customFields: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional()
});
