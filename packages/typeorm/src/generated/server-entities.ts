// Generated server entities - DO NOT EDIT

import { ChangeHistory } from '../entities/ChangeHistory.js';
import { ClientMigration } from '../entities/ClientMigration.js';
import { ClientMigrationStatus } from '../entities/ClientMigrationStatus.js';
import { Comment } from '../entities/Comment.js';
import { HealthCheckState } from '../entities/HealthCheckState.js';
import { LocalChanges } from '../entities/LocalChanges.js';
import { Project } from '../entities/Project.js';
import { Task } from '../entities/Task.js';
import { User } from '../entities/User.js';

export * from '../entities/ChangeHistory.js';
export * from '../entities/ClientMigration.js';
export * from '../entities/Comment.js';
export * from '../entities/HealthCheckState.js';
export * from '../entities/Project.js';
export * from '../entities/Task.js';
export * from '../entities/User.js';

// Direct entity exports for type access
export { ChangeHistory };
export { ClientMigration };
export { Comment };
export { HealthCheckState };
export { Project };
export { Task };
export { User };

// Export entity array for TypeORM
export const serverEntities = [
  ChangeHistory,
  ClientMigration,
  Comment,
  HealthCheckState,
  Project,
  Task,
  User,
];

// domain tables for server context
export const SERVER_DOMAIN_TABLES = [
  '"comments"',
  '"projects"',
  '"tasks"',
  '"users"',
] as const;

// system tables for server context
export const SERVER_SYSTEM_TABLES = [
  '"change_history"',
  '"client_migration"',
  '"health_check_state"',
] as const;

