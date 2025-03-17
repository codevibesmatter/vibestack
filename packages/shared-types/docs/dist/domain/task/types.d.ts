import { TaskStatus, TaskPriority } from '../enums';
import { BaseSchema } from '../schemas/base';
/**
 * Task schema interface
 */
export interface TaskSchema extends BaseSchema {
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    projectId: string;
    assigneeId: string;
    dueDate?: number;
    completedAt?: number;
    tags: string[];
}
/**
 * Task time tracking entry
 */
export interface TaskTimeEntry {
    id: string;
    taskId: string;
    userId: string;
    startTime: number;
    endTime?: number;
    duration?: number;
    description?: string;
    metadata?: Record<string, unknown>;
}
/**
 * Task comment
 */
export interface TaskComment {
    id: string;
    taskId: string;
    userId: string;
    content: string;
    createdAt: number;
    editedAt?: number;
    mentions?: string[];
    attachments?: TaskAttachment[];
}
/**
 * Task attachment
 */
export interface TaskAttachment {
    id: string;
    name: string;
    type: string;
    size: number;
    url: string;
    uploadedBy: string;
    uploadedAt: number;
    metadata?: Record<string, unknown>;
}
/**
 * Task history entry
 */
export interface TaskHistory {
    id: string;
    taskId: string;
    userId: string;
    field: string;
    oldValue: unknown;
    newValue: unknown;
    timestamp: number;
    comment?: string;
}
/**
 * Task checklist item
 */
export interface TaskChecklistItem {
    id: string;
    content: string;
    completed: boolean;
    completedBy?: string;
    completedAt?: number;
    order: number;
}
/**
 * Task dependencies
 */
export interface TaskDependency {
    id: string;
    taskId: string;
    dependsOnTaskId: string;
    type: 'blocks' | 'blocked-by' | 'relates-to';
    metadata?: Record<string, unknown>;
}
