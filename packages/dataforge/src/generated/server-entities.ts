// Generated server entities - DO NOT EDIT

export * from '../entities/ChangeHistory.js';
export * from '../entities/ClientMigration.js';
export * from '../entities/Comment.js';
export * from '../entities/Project.js';
export * from '../entities/Task.js';
export * from '../entities/User.js';
export * from '../entities/UserIdentity.js';

import { ChangeHistory } from '../entities/ChangeHistory.js';
import { ClientMigration } from '../entities/ClientMigration.js';
import { Comment } from '../entities/Comment.js';
import { Project } from '../entities/Project.js';
import { Task } from '../entities/Task.js';
import { User } from '../entities/User.js';
import { UserIdentity } from '../entities/UserIdentity.js';

// Export entity array for TypeORM
export const serverEntities = [
  ChangeHistory,
  ClientMigration,
  Comment,
  Project,
  Task,
  User,
  UserIdentity,
];

// Table hierarchy levels for server domain tables
// Level 0 = root tables (no dependencies)
// Level 1+ = tables with dependencies
export const SERVER_TABLE_HIERARCHY = {
  '"users"': 0,
  '"projects"': 1,
  '"tasks"': 2,
  '"comments"': 3,
} as const;

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
  '"user_identities"',
] as const;

