// Generated client entities - DO NOT EDIT

export * from '../entities/ClientMigrationStatus.js';
export * from '../entities/Comment.js';
export * from '../entities/LocalChanges.js';
export * from '../entities/Project.js';
export * from '../entities/Task.js';
export * from '../entities/User.js';

import { ClientMigrationStatus } from '../entities/ClientMigrationStatus.js';
import { Comment } from '../entities/Comment.js';
import { LocalChanges } from '../entities/LocalChanges.js';
import { Project } from '../entities/Project.js';
import { Task } from '../entities/Task.js';
import { User } from '../entities/User.js';

// Export entity array for TypeORM
export const clientEntities = [
  ClientMigrationStatus,
  Comment,
  LocalChanges,
  Project,
  Task,
  User,
];

// Table hierarchy levels for client domain tables
// Level 0 = root tables (no dependencies)
// Level 1+ = tables with dependencies
export const CLIENT_TABLE_HIERARCHY = {
  '"users"': 0,
  '"projects"': 1,
  '"tasks"': 2,
  '"comments"': 3,
} as const;

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

