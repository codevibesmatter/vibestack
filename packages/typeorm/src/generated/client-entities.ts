// Generated client entities - DO NOT EDIT

import { ChangeHistory } from '../entities/ChangeHistory.js';
import { ClientMigration } from '../entities/ClientMigration.js';
import { ClientMigrationStatus } from '../entities/ClientMigrationStatus.js';
import { Comment } from '../entities/Comment.js';
import { HealthCheckState } from '../entities/HealthCheckState.js';
import { LocalChanges } from '../entities/LocalChanges.js';
import { Project } from '../entities/Project.js';
import { Task } from '../entities/Task.js';
import { User } from '../entities/User.js';

export * from '../entities/ClientMigrationStatus.js';
export * from '../entities/Comment.js';
export * from '../entities/LocalChanges.js';
export * from '../entities/Project.js';
export * from '../entities/Task.js';
export * from '../entities/User.js';

// Direct entity exports for type access
export { ClientMigrationStatus };
export { Comment };
export { LocalChanges };
export { Project };
export { Task };
export { User };

// Export entity array for TypeORM
export const clientEntities = [
  ClientMigrationStatus,
  Comment,
  LocalChanges,
  Project,
  Task,
  User,
];

// domain tables for client context
export const CLIENT_DOMAIN_TABLES = [
  '"comments"',
  '"projects"',
  '"tasks"',
  '"users"',
] as const;

// system tables for client context
export const CLIENT_SYSTEM_TABLES = [
  '"client_migration_status"',
  '"local_changes"',
] as const;

