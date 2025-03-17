import { ProjectStatus } from '../enums';
import { BaseSchema } from '../schemas/base';
/**
 * Project schema interface
 */
export interface ProjectSchema extends BaseSchema {
    name: string;
    description: string;
    status: ProjectStatus;
    ownerId: string;
    settings: ProjectSettings;
}
/**
 * Project settings
 */
export interface ProjectSettings {
    isPublic: boolean;
    allowGuests: boolean;
    defaultTaskStatus?: string;
    defaultTaskPriority?: string;
    customFields?: Record<string, unknown>;
}
/**
 * Project member
 */
export interface ProjectMember {
    userId: string;
    role: 'owner' | 'admin' | 'member' | 'guest';
    joinedAt: number;
    invitedBy?: string;
    permissions?: string[];
}
/**
 * Project audit log entry
 */
export interface ProjectAuditLog {
    id: string;
    projectId: string;
    userId: string;
    action: string;
    timestamp: number;
    details: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
/**
 * Project statistics
 */
export interface ProjectStats {
    totalTasks: number;
    completedTasks: number;
    overdueTasks: number;
    activeMembers: number;
    lastActivity: number;
    tasksByStatus: Record<string, number>;
    tasksByPriority: Record<string, number>;
}
/**
 * Project integration settings
 */
export interface ProjectIntegration {
    type: string;
    config: Record<string, unknown>;
    enabled: boolean;
    lastSync?: number;
    error?: string;
}
