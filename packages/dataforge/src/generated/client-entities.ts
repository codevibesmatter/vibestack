// Generated client entities - DO NOT EDIT

import { EntitySchema } from 'typeorm';
import { BaseDomainEntity } from '../entities/BaseDomainEntity.js';
import { BaseSystemEntity } from '../entities/BaseSystemEntity.js';

// Enum Imports (dynamically generated)
import { MigrationStatus } from '../entities/ClientMigrationStatus.js';
import { ProjectStatus } from '../entities/Project.js';
import { TaskPriority, TaskStatus } from '../entities/Task.js';
import { UserRole } from '../entities/User.js';


// Enum Exports
export { MigrationStatus } from '../entities/ClientMigrationStatus.js';
export { ProjectStatus } from '../entities/Project.js';
export { TaskPriority, TaskStatus } from '../entities/Task.js';
export { UserRole } from '../entities/User.js';


// Generated Classes (for type checking and validation)
export class ClientMigrationStatus {
  migrationName!: string;

  schemaVersion!: string;

  status!: MigrationStatus;

  startedAt?: Date;

  completedAt?: Date;

  errorMessage?: string;

  attempts!: number;

  timestamp!: number;

  createdAt!: Date;

}

export class Comment extends BaseDomainEntity {
  content!: string;

  entityType!: string;

  entityId?: string;

  authorId?: string;

  parentId?: string;

  author?: User;

  parent?: Comment;

  task!: Task;

  project!: Project;

}

export class LocalChanges extends BaseSystemEntity {
  table!: string;

  operation!: string;

  data!: any;

  lsn!: string;

  updatedAt!: Date;

  processedSync!: number;

}

export class Project extends BaseDomainEntity {
  name!: string;

  description?: string;

  status!: ProjectStatus;

  ownerId?: string;

  owner?: User;

  members!: User[];

  tasks!: Task[];

}

export class SyncMetadata {
  id!: string;

  clientId!: string;

  currentLsn!: string;

  syncState!: string;

  lastSyncTime?: Date;

  pendingChangesCount!: number;

}

export class Task extends BaseDomainEntity {
  title!: string;

  description?: string;

  status!: TaskStatus;

  priority!: TaskPriority;

  dueDate?: Date;

  completedAt?: Date;

  timeRange?: any;

  estimatedDuration?: any;

  tags!: string[];

  projectId?: string;

  assigneeId?: string;

  project?: Project;

  assignee?: User;

  dependencies!: Task[];

}

export class User extends BaseDomainEntity {
  name!: string;

  email!: string;

  avatarUrl?: string;

  role!: UserRole;

  tasks!: Task[];

  ownedProjects!: Project[];

  memberProjects!: Project[];

}


// Entity Schemas (for TypeORM metadata)
// Schema for ClientMigrationStatus
export const ClientMigrationStatusSchema = new EntitySchema<ClientMigrationStatus>({
    target: ClientMigrationStatus, // Link to generated class
    name: 'ClientMigrationStatus', 
    tableName: 'client_migration_status',
    columns: {
        'migrationName': {
            name: 'migration_name', // Explicit DB Name
            type: 'text', // Use helper
            primary: true
        },
        'schemaVersion': {
            name: 'schema_version', // Explicit DB Name
            type: 'text', // Use helper
        },
        'status': {
            name: 'status', // Explicit DB Name
            type: 'enum', // Use helper
            enum: MigrationStatus, // Use name from decorator
        },
        'startedAt': {
            name: 'started_at', // Explicit DB Name
            type: 'timestamptz', // Use helper
            nullable: true
        },
        'completedAt': {
            name: 'completed_at', // Explicit DB Name
            type: 'timestamptz', // Use helper
            nullable: true
        },
        'errorMessage': {
            name: 'error_message', // Explicit DB Name
            type: 'text', // Use helper
            nullable: true
        },
        'attempts': {
            name: 'attempts', // Explicit DB Name
            type: 'integer', // Use helper
            default: 0
        },
        'timestamp': {
            name: 'timestamp', // Explicit DB Name
            type: 'bigint', // Use helper
        },
        'createdAt': {
            name: 'created_at', // Explicit DB Name
            type: 'timestamptz', // Use helper
            createDate: true
        }
    },
    relations: {
    },
});

// Schema for Comment
export const CommentSchema = new EntitySchema<Comment>({
    target: Comment, // Link to generated class
    name: 'Comment', 
    tableName: 'comments',
    columns: {
        id: { name: 'id', type: 'uuid', primary: true, generated: 'uuid' },
        createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
        updatedAt: { name: 'updated_at', type: 'timestamptz', updateDate: true },
        clientId: { name: 'client_id', type: 'varchar', length: 255, nullable: true },
        'content': {
            name: 'content', // Explicit DB Name
            type: 'text', // Use helper
        },
        'entityType': {
            name: 'entity_type', // Explicit DB Name
            type: 'varchar', // Use helper
        },
        'entityId': {
            name: 'entity_id', // Explicit DB Name
            type: 'uuid', // Use helper
            nullable: true
        },
        'authorId': {
            name: 'author_id', // Explicit DB Name
            type: 'uuid', // Use helper
            nullable: true
        },
        'parentId': {
            name: 'parent_id', // Explicit DB Name
            type: 'uuid', // Use helper
            nullable: true
        }
    },
    relations: {
        'author': {
            target: 'User', // Target Entity Name (String)
            type: 'many-to-one',
            joinColumn: { name: 'author_id' },
            nullable: true
        },
        'parent': {
            target: 'Comment', // Target Entity Name (String)
            type: 'many-to-one',
            joinColumn: { name: 'parent_id' },
            nullable: true
        },
        'task': {
            target: 'Task', // Target Entity Name (String)
            type: 'many-to-one',
            joinColumn: { name: 'entity_id', referencedColumnName: 'id' }
        },
        'project': {
            target: 'Project', // Target Entity Name (String)
            type: 'many-to-one',
            joinColumn: { name: 'entity_id', referencedColumnName: 'id' }
        }
    },
});

// Schema for LocalChanges
export const LocalChangesSchema = new EntitySchema<LocalChanges>({
    target: LocalChanges, // Link to generated class
    name: 'LocalChanges', 
    tableName: 'local_changes',
    columns: {
        id: { name: 'id', type: 'uuid', primary: true, generated: 'uuid' },
        'table': {
            name: 'table', // Explicit DB Name
            type: 'text', // Use helper
        },
        'operation': {
            name: 'operation', // Explicit DB Name
            type: 'text', // Use helper
        },
        'data': {
            name: 'data', // Explicit DB Name
            type: 'jsonb', // Use helper
        },
        'lsn': {
            name: 'lsn', // Explicit DB Name
            type: 'text', // Use helper
        },
        'updatedAt': {
            name: 'updated_at', // Explicit DB Name
            type: 'timestamptz', // Use helper
        },
        'processedSync': {
            name: 'processed_sync', // Explicit DB Name
            type: 'integer', // Use helper
            default: 0
        }
    },
    relations: {
    },
});

// Schema for Project
export const ProjectSchema = new EntitySchema<Project>({
    target: Project, // Link to generated class
    name: 'Project', 
    tableName: 'projects',
    columns: {
        id: { name: 'id', type: 'uuid', primary: true, generated: 'uuid' },
        createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
        updatedAt: { name: 'updated_at', type: 'timestamptz', updateDate: true },
        clientId: { name: 'client_id', type: 'varchar', length: 255, nullable: true },
        'name': {
            name: 'name', // Explicit DB Name
            type: 'varchar', // Use helper
            length: 100
        },
        'description': {
            name: 'description', // Explicit DB Name
            type: 'text', // Use helper
            nullable: true
        },
        'status': {
            name: 'status', // Explicit DB Name
            type: 'enum', // Use helper
            default: "active",
            enum: ProjectStatus, // Use name from decorator
        },
        'ownerId': {
            name: 'owner_id', // Explicit DB Name
            type: 'uuid', // Use helper
            nullable: true
        }
    },
    relations: {
        'owner': {
            target: 'User', // Target Entity Name (String)
            type: 'many-to-one',
            joinColumn: { name: 'owner_id' },
            nullable: true
        },
        'members': {
            target: 'User', // Target Entity Name (String)
            type: 'many-to-many',
            joinTable: {
                name: 'project_members',
                joinColumns: [{ name: 'project_id', referencedColumnName: 'id' }],
                inverseJoinColumns: [{ name: 'user_id', referencedColumnName: 'id' }],
            }
        },
        'tasks': {
            target: 'Task', // Target Entity Name (String)
            type: 'one-to-many'
        }
    },
});

// Schema for SyncMetadata
export const SyncMetadataSchema = new EntitySchema<SyncMetadata>({
    target: SyncMetadata, // Link to generated class
    name: 'SyncMetadata', 
    tableName: 'sync_metadata',
    columns: {
        'id': {
            name: 'id', // Explicit DB Name
            type: 'text', // Use helper
            primary: true
        },
        'clientId': {
            name: 'client_id', // Explicit DB Name
            type: 'text', // Use helper
        },
        'currentLsn': {
            name: 'current_lsn', // Explicit DB Name
            type: 'text', // Use helper
            default: "0/0"
        },
        'syncState': {
            name: 'sync_state', // Explicit DB Name
            type: 'text', // Use helper
            default: "disconnected"
        },
        'lastSyncTime': {
            name: 'last_sync_time', // Explicit DB Name
            type: 'timestamptz', // Use helper
            nullable: true
        },
        'pendingChangesCount': {
            name: 'pending_changes_count', // Explicit DB Name
            type: 'integer', // Use helper
            default: 0
        }
    },
    relations: {
    },
});

// Schema for Task
export const TaskSchema = new EntitySchema<Task>({
    target: Task, // Link to generated class
    name: 'Task', 
    tableName: 'tasks',
    columns: {
        id: { name: 'id', type: 'uuid', primary: true, generated: 'uuid' },
        createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
        updatedAt: { name: 'updated_at', type: 'timestamptz', updateDate: true },
        clientId: { name: 'client_id', type: 'varchar', length: 255, nullable: true },
        'title': {
            name: 'title', // Explicit DB Name
            type: 'varchar', // Use helper
            length: 100
        },
        'description': {
            name: 'description', // Explicit DB Name
            type: 'text', // Use helper
            nullable: true
        },
        'status': {
            name: 'status', // Explicit DB Name
            type: 'enum', // Use helper
            enum: TaskStatus, // Use name from decorator
        },
        'priority': {
            name: 'priority', // Explicit DB Name
            type: 'enum', // Use helper
            default: "medium",
            enum: TaskPriority, // Use name from decorator
        },
        'dueDate': {
            name: 'due_date', // Explicit DB Name
            type: 'timestamptz', // Use helper
            nullable: true
        },
        'completedAt': {
            name: 'completed_at', // Explicit DB Name
            type: 'timestamptz', // Use helper
            nullable: true
        },
        'timeRange': {
            name: 'time_range', // Explicit DB Name
            type: 'tsrange', // Use helper
            nullable: true
        },
        'estimatedDuration': {
            name: 'estimated_duration', // Explicit DB Name
            type: 'interval', // Use helper
            nullable: true
        },
        'tags': {
            name: 'tags', // Explicit DB Name
            type: 'text', // Use helper
            default: [],
            array: true
        },
        'projectId': {
            name: 'project_id', // Explicit DB Name
            type: 'uuid', // Use helper
            nullable: true
        },
        'assigneeId': {
            name: 'assignee_id', // Explicit DB Name
            type: 'uuid', // Use helper
            nullable: true
        }
    },
    relations: {
        'project': {
            target: 'Project', // Target Entity Name (String)
            type: 'many-to-one',
            joinColumn: { name: 'project_id' },
            nullable: true
        },
        'assignee': {
            target: 'User', // Target Entity Name (String)
            type: 'many-to-one',
            joinColumn: { name: 'assignee_id' },
            nullable: true
        },
        'dependencies': {
            target: 'Task', // Target Entity Name (String)
            type: 'many-to-many',
            joinTable: {
                name: 'task_dependencies',
                joinColumns: [{ name: 'dependent_task_id', referencedColumnName: 'id' }],
                inverseJoinColumns: [{ name: 'dependency_task_id', referencedColumnName: 'id' }],
            }
        }
    },
});

// Schema for User
export const UserSchema = new EntitySchema<User>({
    target: User, // Link to generated class
    name: 'User', 
    tableName: 'users',
    columns: {
        id: { name: 'id', type: 'uuid', primary: true, generated: 'uuid' },
        createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
        updatedAt: { name: 'updated_at', type: 'timestamptz', updateDate: true },
        clientId: { name: 'client_id', type: 'varchar', length: 255, nullable: true },
        'name': {
            name: 'name', // Explicit DB Name
            type: 'varchar', // Use helper
            length: 100
        },
        'email': {
            name: 'email', // Explicit DB Name
            type: 'varchar', // Use helper
            length: 255,
            unique: true
        },
        'avatarUrl': {
            name: 'avatar_url', // Explicit DB Name
            type: 'varchar', // Use helper
            nullable: true,
            length: 255
        },
        'role': {
            name: 'role', // Explicit DB Name
            type: 'enum', // Use helper
            default: "member",
            enum: UserRole, // Use name from decorator
        }
    },
    relations: {
        'tasks': {
            target: 'Task', // Target Entity Name (String)
            type: 'one-to-many'
        },
        'ownedProjects': {
            target: 'Project', // Target Entity Name (String)
            type: 'one-to-many'
        },
        'memberProjects': {
            target: 'Project', // Target Entity Name (String)
            type: 'many-to-many'
        }
    },
});


// Exports
// Export entity schema array for TypeORM
export const clientEntities = [
  ClientMigrationStatusSchema,
  CommentSchema,
  LocalChangesSchema,
  ProjectSchema,
  SyncMetadataSchema,
  TaskSchema,
  UserSchema
];

// domain tables for client context
export const CLIENT_DOMAIN_TABLES = [
  '"comments"',
  '"projects"',
  '"tasks"',
  '"users"',
];

// Table hierarchy levels for client domain tables
// Level 0 = root tables (no dependencies)
// Level 1+ = tables with dependencies
export const CLIENT_TABLE_HIERARCHY = {
  '"users"': 0,
  '"projects"': 1,
  '"tasks"': 2,
  '"comments"': 0,
} as const;

// system tables for client context
export const CLIENT_SYSTEM_TABLES = [
  '"client_migration_status"',
  '"local_changes"',
  '"sync_metadata"',
];

// utility tables for client context
export const CLIENT_UTILITY_TABLES = [
];

