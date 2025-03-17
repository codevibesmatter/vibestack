import { UserSyncable, ProjectSyncable, TaskSyncable } from '../schemas';
/**
 * Base service event type
 */
export interface ServiceEvent<T = unknown> {
    type: string;
    payload: T;
    timestamp: number;
    userId?: string;
}
/**
 * User events
 */
export interface UserEvent extends ServiceEvent {
    type: 'USER_CREATED' | 'USER_UPDATED' | 'USER_DELETED' | 'USER_LOGIN' | 'USER_LOGOUT';
    payload: UserSyncable;
}
/**
 * Project events
 */
export interface ProjectEvent extends ServiceEvent {
    type: 'PROJECT_CREATED' | 'PROJECT_UPDATED' | 'PROJECT_DELETED' | 'PROJECT_ARCHIVED' | 'PROJECT_RESTORED';
    payload: ProjectSyncable;
}
/**
 * Task events
 */
export interface TaskEvent extends ServiceEvent {
    type: 'TASK_CREATED' | 'TASK_UPDATED' | 'TASK_DELETED' | 'TASK_STATUS_CHANGED' | 'TASK_ASSIGNED';
    payload: TaskSyncable;
}
/**
 * Event handler type
 */
export type EventHandler<T extends ServiceEvent> = (event: T) => Promise<void> | void;
