import type { Row } from 'tinybase';
import type { UserSchema } from '../../domain/user';
import type { ProjectSchema } from '../../domain/project';
import type { TaskSchema } from '../../domain/task';
/**
 * Domain-specific table definitions
 */
export interface DomainTables {
    users: Record<string, UserSchema>;
    projects: Record<string, ProjectSchema>;
    tasks: Record<string, TaskSchema>;
}
/**
 * Table names type
 */
export type TableName = keyof DomainTables;
/**
 * Generic table record type
 */
export type TableRecord<T extends TableName> = DomainTables[T] extends Record<string, infer R> ? R : never;
/**
 * TinyBase store tables
 */
export type Tables = {
    [K in TableName]: Record<string, Row>;
};
/**
 * TinyBase store configuration
 */
export interface TinybaseStoreConfig {
    initialData?: Partial<Tables>;
    pingInterval?: number;
    pingTimeout?: number;
}
