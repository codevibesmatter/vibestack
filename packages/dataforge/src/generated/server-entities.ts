// Generated server entities - DO NOT EDIT

import { EntitySchema } from 'typeorm';
import { BaseDomainEntity } from '../entities/BaseDomainEntity.js';
import { BaseSystemEntity } from '../entities/BaseSystemEntity.js';

// Enum Imports (dynamically generated)
import { MigrationState, MigrationType } from '../entities/ClientMigration.js';
import { ProjectStatus } from '../entities/Project.js';
import { TaskPriority, TaskStatus } from '../entities/Task.js';
import { UserRole } from '../entities/User.js';


// Enum Exports
export { MigrationState, MigrationType } from '../entities/ClientMigration.js';
export { ProjectStatus } from '../entities/Project.js';
export { TaskPriority, TaskStatus } from '../entities/Task.js';
export { UserRole } from '../entities/User.js';


// Generated Classes (for type checking and validation)
export class ChangeHistory {
  id!: string;

  lsn!: string;

  tableName!: string;

  operation!: string;

  data?: any;

  timestamp!: Date;

}

export class ClientMigration {
  migrationName!: string;

  schemaVersion!: string;

  dependencies!: string[];

  migrationType!: MigrationType;

  state!: MigrationState;

  upQueries!: string[];

  downQueries!: string[];

  description?: string;

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

export class Project extends BaseDomainEntity {
  name!: string;

  description?: string;

  status!: ProjectStatus;

  ownerId?: string;

  owner?: User;

  members!: User[];

  tasks!: Task[];

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

  identities!: UserIdentity[];

}

export class UserIdentity extends BaseSystemEntity {
  userId!: string;

  provider!: string;

  providerId!: string;

  user!: User;

}


// Entity Schemas (for TypeORM metadata)
// Schema for ChangeHistory
export const ChangeHistorySchema = new EntitySchema<ChangeHistory>({
    target: ChangeHistory, // Link to generated class
    name: 'ChangeHistory', 
    tableName: 'change_history',
    columns: {
        'id': {
            name: 'id', // Explicit DB Name
            type: 'uuid', // Use helper
            primary: true
        },
        'lsn': {
            name: 'lsn', // Explicit DB Name
            type: 'text', // Use helper
        },
        'tableName': {
            name: 'table_name', // Explicit DB Name
            type: 'text', // Use helper
        },
        'operation': {
            name: 'operation', // Explicit DB Name
            type: 'text', // Use helper
        },
        'data': {
            name: 'data', // Explicit DB Name
            type: 'jsonb', // Use helper
            nullable: true
        },
        'timestamp': {
            name: 'timestamp', // Explicit DB Name
            type: 'timestamptz', // Use helper
            createDate: true,
            default: undefined
        }
    },
    relations: {
    },
});

// Schema for ClientMigration
export const ClientMigrationSchema = new EntitySchema<ClientMigration>({
    target: ClientMigration, // Link to generated class
    name: 'ClientMigration', 
    tableName: 'client_migration',
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
        'dependencies': {
            name: 'dependencies', // Explicit DB Name
            type: 'text', // Use helper
            default: [],
            array: true
        },
        'migrationType': {
            name: 'migration_type', // Explicit DB Name
            type: 'enum', // Use helper
            enum: MigrationType, // Use name from decorator
        },
        'state': {
            name: 'state', // Explicit DB Name
            type: 'enum', // Use helper
            default: "pending",
            enum: MigrationState, // Use name from decorator
        },
        'upQueries': {
            name: 'up_queries', // Explicit DB Name
            type: 'text', // Use helper
            array: true
        },
        'downQueries': {
            name: 'down_queries', // Explicit DB Name
            type: 'text', // Use helper
            array: true
        },
        'description': {
            name: 'description', // Explicit DB Name
            type: 'text', // Use helper
            nullable: true
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
        },
        'identities': {
            target: 'UserIdentity', // Target Entity Name (String)
            type: 'one-to-many'
        }
    },
});

// Schema for UserIdentity
export const UserIdentitySchema = new EntitySchema<UserIdentity>({
    target: UserIdentity, // Link to generated class
    name: 'UserIdentity', 
    tableName: 'user_identities',
    columns: {
        id: { name: 'id', type: 'uuid', primary: true, generated: 'uuid' },
        'userId': {
            name: 'user_id', // Explicit DB Name
            type: 'uuid', // Use helper
        },
        'provider': {
            name: 'provider', // Explicit DB Name
            type: 'varchar', // Use helper
            length: 50
        },
        'providerId': {
            name: 'provider_id', // Explicit DB Name
            type: 'varchar', // Use helper
            length: 255
        }
    },
    relations: {
        'user': {
            target: 'User', // Target Entity Name (String)
            type: 'many-to-one',
            joinColumn: { name: 'user_id' }
        }
    },
});


// Exports
// Export entity schema array for TypeORM
export const serverEntities = [
  ChangeHistorySchema,
  ClientMigrationSchema,
  CommentSchema,
  ProjectSchema,
  TaskSchema,
  UserSchema,
  UserIdentitySchema
];

// domain tables for server context
export const SERVER_DOMAIN_TABLES = [
  '"comments"',
  '"projects"',
  '"tasks"',
  '"users"',
];

// Table hierarchy levels for server domain tables
// Level 0 = root tables (no dependencies)
// Level 1+ = tables with dependencies
export const SERVER_TABLE_HIERARCHY = {
  '"users"': 0,
  '"projects"': 1,
  '"tasks"': 2,
  '"comments"': 0,
} as const;

// system tables for server context
export const SERVER_SYSTEM_TABLES = [
  '"change_history"',
  '"client_migration"',
  '"user_identities"',
];

// utility tables for server context
export const SERVER_UTILITY_TABLES = [
];

