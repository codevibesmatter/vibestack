import { BaseSchema } from '../schemas/base';
import { UserSchema } from '../user';
import { ProjectSchema, ProjectSettings } from '../project';
import { TaskSchema } from '../task';
import { TaskStatus, TaskPriority } from '../enums';
/**
 * Base service interface for all entity services
 */
export interface IBaseService<T extends BaseSchema> {
    create(data: Omit<T, keyof BaseSchema>): Promise<T>;
    get(id: string): Promise<T>;
    update(id: string, data: Partial<T>): Promise<T>;
    delete(id: string): Promise<void>;
    list(options?: ListOptions): Promise<T[]>;
}
/**
 * Common options for list operations
 */
export interface ListOptions {
    limit?: number;
    offset?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    filter?: Record<string, unknown>;
}
/**
 * User service interface
 */
export interface IUserService extends IBaseService<UserSchema> {
    getByEmail(email: string): Promise<UserSchema>;
    updateLastActive(id: string): Promise<void>;
    validateCredentials(email: string, password: string): Promise<boolean>;
    requestPasswordReset(email: string): Promise<void>;
    resetPassword(token: string, newPassword: string): Promise<void>;
    verifyEmail(token: string): Promise<void>;
}
/**
 * Project service interface
 */
export interface IProjectService extends IBaseService<ProjectSchema> {
    getProjectSettings(id: string): Promise<ProjectSettings>;
    updateProjectSettings(id: string, settings: ProjectSettings): Promise<void>;
    getMembers(id: string): Promise<UserSchema[]>;
    addMember(id: string, userId: string): Promise<void>;
    removeMember(id: string, userId: string): Promise<void>;
    archive(id: string, reason?: string): Promise<void>;
    restore(id: string): Promise<void>;
}
/**
 * Task service interface
 */
export interface ITaskService extends IBaseService<TaskSchema> {
    updateStatus(id: string, status: TaskStatus): Promise<void>;
    updatePriority(id: string, priority: TaskPriority): Promise<void>;
    updateAssignee(id: string, assigneeId: string): Promise<void>;
    addTags(id: string, tags: string[]): Promise<void>;
    removeTags(id: string, tags: string[]): Promise<void>;
    getByProject(projectId: string): Promise<TaskSchema[]>;
    getByAssignee(assigneeId: string): Promise<TaskSchema[]>;
    track(id: string, userId: string): Promise<void>;
    stopTracking(id: string, userId: string): Promise<void>;
    addComment(id: string, userId: string, content: string): Promise<void>;
}
/**
 * Service factory interface
 */
export interface IServiceFactory {
    createUserService(): IUserService;
    createProjectService(): IProjectService;
    createTaskService(): ITaskService;
}
