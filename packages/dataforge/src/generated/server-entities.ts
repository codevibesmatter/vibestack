// Generated server entities - DO NOT EDIT

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany, ManyToMany, JoinColumn, JoinTable } from 'typeorm';
import { BaseDomainEntity } from '../entities/BaseDomainEntity.js';
import { BaseSystemEntity } from '../entities/BaseSystemEntity.js';
import { TaskStatus, TaskPriority } from '../entities/Task.js';
export { TaskStatus, TaskPriority };
import { ProjectStatus } from '../entities/Project.js';
export { ProjectStatus };
import { UserRole } from '../entities/User.js';
export { UserRole };
import { MigrationStatus } from '../entities/ClientMigrationStatus.js';
export { MigrationStatus };
import { MigrationType, MigrationState } from '../entities/ClientMigration.js';
export { MigrationType, MigrationState };

@Entity('change_history')
export class ChangeHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({"type":"text","nullable":false})
  lsn!: string;

  @Column({"type":"text","nullable":false,"name":"table_name"})
  tableName!: string;

  @Column({"type":"text","nullable":false})
  operation!: string;

  @Column({"type":"jsonb","nullable":true})
  data?: any;

  @CreateDateColumn({"type":"timestamptz"})
  timestamp!: Date;

}

@Entity('client_migration')
export class ClientMigration {
  @Column({"type":"text","name":"migration_name","primary":true})
  migrationName!: string;

  @Column({"type":"text","name":"schema_version"})
  schemaVersion!: string;

  @Column({"type":"text","array":true,"default":[]})
  dependencies!: any[];

  @Column({"type":"enum","enum":{"SCHEMA":"schema","DATA":"data","MIXED":"mixed"},"name":"migration_type"})
  migrationType!: MigrationType;

  @Column({"type":"enum","enum":{"PENDING":"pending","AVAILABLE":"available","DEPRECATED":"deprecated","REQUIRED":"required"},"default":"pending"})
  state!: MigrationState;

  @Column({"type":"text","array":true,"name":"up_queries"})
  upQueries!: any[];

  @Column({"type":"text","array":true,"name":"down_queries"})
  downQueries!: any[];

  @Column({"type":"text","nullable":true})
  description?: string;

  @Column({"type":"bigint"})
  timestamp!: number;

  @CreateDateColumn({"type":"timestamptz","name":"created_at"})
  createdAt!: Date;

}

@Entity('comments')
export class Comment extends BaseDomainEntity {
  @Column({"type":"text"})
  content!: string;

  @Column({"type":"varchar","name":"entity_type"})
  entityType!: string;

  @Column({"type":"uuid","name":"entity_id","nullable":true})
  entityId?: string;

  @Column({"type":"uuid","name":"author_id","nullable":true})
  authorId?: string;

  @Column({"type":"uuid","nullable":true,"name":"parent_id"})
  parentId?: string;

  @ManyToOne(() => User, undefined, {"nullable":true})
  @JoinColumn()
  author?: User;

  @ManyToOne(() => Comment, undefined, {"nullable":true})
  @JoinColumn()
  parent?: Comment;

  @ManyToOne(() => Task, undefined, {"createForeignKeyConstraints":false})
  @JoinColumn()
  task!: Task;

  @ManyToOne(() => Project, undefined, {"createForeignKeyConstraints":false})
  @JoinColumn()
  project!: Project;

}

@Entity('projects')
export class Project extends BaseDomainEntity {
  @Column({"type":"varchar","length":100})
  name!: string;

  @Column({"type":"text","nullable":true})
  description?: string;

  @Column({"type":"enum","enum":{"ACTIVE":"active","IN_PROGRESS":"in_progress","COMPLETED":"completed","ON_HOLD":"on_hold"},"default":"active"})
  status!: ProjectStatus;

  @Column({"type":"uuid","name":"owner_id","nullable":true})
  ownerId?: string;

  @ManyToOne(() => User, (user) => user.ownedProjects, {"nullable":true})
  @JoinColumn()
  owner?: User;

  @ManyToMany(() => User, (user) => user.memberProjects, {})
  @JoinTable()
  members!: User[];

  @OneToMany(() => Task, (task) => task.project, {})
  tasks!: Task[];

}

@Entity('tasks')
export class Task extends BaseDomainEntity {
  @Column({"type":"varchar","length":100})
  title!: string;

  @Column({"type":"text","nullable":true})
  description?: string;

  @Column({"type":"enum","enum":{"OPEN":"open","IN_PROGRESS":"in_progress","COMPLETED":"completed"}})
  status!: TaskStatus;

  @Column({"type":"enum","enum":{"LOW":"low","MEDIUM":"medium","HIGH":"high"},"default":"medium"})
  priority!: TaskPriority;

  @Column({"type":"timestamptz","nullable":true,"name":"due_date"})
  dueDate?: Date;

  @Column({"type":"timestamptz","nullable":true,"name":"completed_at"})
  completedAt?: Date;

  @Column({"type":"tsrange","nullable":true,"name":"time_range"})
  timeRange?: string;

  @Column({"type":"interval","nullable":true,"name":"estimated_duration"})
  estimatedDuration?: string;

  @Column({"array":true,"default":[],"type":"text"})
  tags!: any[];

  @Column({"type":"uuid","name":"project_id","nullable":true})
  projectId?: string;

  @Column({"type":"uuid","nullable":true,"name":"assignee_id"})
  assigneeId?: string;

  @ManyToOne(() => Project, (project) => project.tasks, {"nullable":true})
  @JoinColumn()
  project?: Project;

  @ManyToOne(() => User, (user) => user.tasks, {"nullable":true})
  @JoinColumn()
  assignee?: User;

  @ManyToMany(() => Task, undefined, {})
  @JoinTable()
  dependencies!: Task[];

}

@Entity('users')
export class User extends BaseDomainEntity {
  @Column({"type":"varchar","length":100})
  name!: string;

  @Column({"type":"varchar","length":255,"unique":true})
  email!: string;

  @Column({"type":"varchar","length":255,"nullable":true,"name":"avatar_url"})
  avatarUrl?: string;

  @Column({"type":"enum","enum":{"ADMIN":"admin","MEMBER":"member","VIEWER":"viewer"},"default":"member"})
  role!: UserRole;

  @OneToMany(() => Task, (task) => task.assignee, {})
  tasks!: Task[];

  @OneToMany(() => Project, (project) => project.owner, {})
  ownedProjects!: Project[];

  @ManyToMany(() => Project, (project) => project.members, {})
  memberProjects!: Project[];

  @OneToMany(() => UserIdentity, (identity) => identity.user, {})
  identities!: UserIdentity[];

}

@Entity('user_identities')
export class UserIdentity extends BaseSystemEntity {
  @Column({"type":"uuid","name":"user_id"})
  userId!: string;

  @Column({"type":"varchar","length":50})
  provider!: string;

  @Column({"type":"varchar","length":255,"name":"provider_id"})
  providerId!: string;

  @ManyToOne(() => User, (user) => user.identities, {})
  @JoinColumn()
  user!: User;

}

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

// domain tables for server context
export const SERVER_DOMAIN_TABLES = [
  '"comments"',
  '"projects"',
  '"tasks"',
  '"users"',
] as const;

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
] as const;

// utility tables for server context
export const SERVER_UTILITY_TABLES = [
] as const;

