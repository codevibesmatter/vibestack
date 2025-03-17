import { TaskSchema } from '../task';
import { BaseSchema } from '../schemas/base';
import { TaskStatus, TaskPriority } from '../enums';
/**
 * Task creation operation data
 */
export interface TaskCreationOperation extends Omit<TaskSchema, keyof BaseSchema> {
    watchers?: string[];
}
/**
 * Task update operation data
 */
export interface TaskUpdateOperation extends Partial<Omit<TaskSchema, keyof BaseSchema>> {
    watchers?: string[];
}
/**
 * Task status update operation
 */
export interface TaskStatusOperation {
    status: TaskStatus;
    comment?: string;
}
/**
 * Task priority update operation
 */
export interface TaskPriorityOperation {
    priority: TaskPriority;
    reason?: string;
}
/**
 * Task assignee update operation
 */
export interface TaskAssigneeOperation {
    assigneeId: string;
    notifyAssignee?: boolean;
}
/**
 * Task time tracking operation
 */
export interface TaskTimeTrackingOperation {
    action: 'start' | 'stop' | 'pause' | 'resume';
    description?: string;
}
/**
 * Task comment operation
 */
export interface TaskCommentOperation {
    content: string;
    mentions?: string[];
    attachments?: string[];
}
/**
 * Task filter operation
 */
export interface TaskFilterOperation {
    status?: TaskStatus[];
    priority?: TaskPriority[];
    assignee?: string;
    project?: string;
    dueDate?: {
        start?: number;
        end?: number;
    };
    tags?: string[];
    watchers?: string[];
}
