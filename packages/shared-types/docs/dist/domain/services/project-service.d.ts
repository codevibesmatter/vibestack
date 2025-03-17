import { ProjectSchema } from '../project';
import { BaseSchema } from '../schemas/base';
/**
 * Project creation operation data
 */
export interface ProjectCreationOperation extends Omit<ProjectSchema, keyof BaseSchema> {
    members?: string[];
}
/**
 * Project update operation data
 */
export interface ProjectUpdateOperation extends Partial<Omit<ProjectSchema, keyof BaseSchema>> {
    members?: string[];
}
/**
 * Project membership operation
 */
export interface ProjectMembershipOperation {
    add?: string[];
    remove?: string[];
    role?: string;
}
/**
 * Project archive operation
 */
export interface ProjectArchiveOperation {
    reason?: string;
    retentionPeriod?: number;
}
/**
 * Project restore operation
 */
export interface ProjectRestoreOperation {
    preserveHistory?: boolean;
}
