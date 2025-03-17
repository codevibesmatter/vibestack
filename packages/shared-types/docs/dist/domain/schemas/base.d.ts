import { z } from 'zod';
/**
 * Base schema for all entities
 */
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
/**
 * Project settings schema
 */
export declare const projectSettingsSchema: z.ZodObject<{
    isPublic: z.ZodBoolean;
    allowGuests: z.ZodBoolean;
    defaultTaskStatus: z.ZodString;
    defaultTaskPriority: z.ZodString;
    customFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    isPublic: boolean;
    allowGuests: boolean;
    defaultTaskStatus: string;
    defaultTaskPriority: string;
    customFields?: Record<string, unknown> | undefined;
}, {
    isPublic: boolean;
    allowGuests: boolean;
    defaultTaskStatus: string;
    defaultTaskPriority: string;
    customFields?: Record<string, unknown> | undefined;
}>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
