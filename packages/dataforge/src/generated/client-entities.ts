// Generated client entities - DO NOT EDIT

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

@Entity('client_migration_status')
export class ClientMigrationStatus {
  @Column({"type":"text","name":"migration_name","primary":true})
  migrationName!: string;

  @Column({"type":"text","name":"schema_version"})
  schemaVersion!: string;

  @Column({"type":"enum","enum":{"PENDING":"pending","IN_PROGRESS":"in_progress","COMPLETED":"completed","FAILED":"failed","ROLLED_BACK":"rolled_back"}})
  status!: MigrationStatus;

  @Column({"type":"timestamptz","nullable":true,"name":"started_at"})
  startedAt?: Date;

  @Column({"type":"timestamptz","nullable":true,"name":"completed_at"})
  completedAt?: Date;

  @Column({"type":"text","nullable":true,"name":"error_message"})
  errorMessage?: string;

  @Column({"type":"integer","default":0})
  attempts!: number;

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

@Entity('local_changes')
export class LocalChanges extends BaseSystemEntity {
  @Column({"type":"text"})
  table!: string;

  @Column({"type":"text"})
  operation!: string;

  @Column({"type":"jsonb"})
  data!: any;

  @Column({"type":"text"})
  lsn!: string;

  @Column({"type":"timestamptz","name":"updated_at"})
  updatedAt!: Date;

  @Column({"type":"integer","default":0,"name":"processed_sync"})
  processedSync!: number;

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

@Entity('sync_metadata')
export class SyncMetadata {
  @Column({"type":"text","primary":true})
  id!: string;

  @Column({"type":"text","name":"client_id"})
  clientId!: string;

  @Column({"type":"text","name":"current_lsn","default":"0/0"})
  currentLsn!: string;

  @Column({"type":"text","name":"sync_state","default":"disconnected"})
  syncState!: string;

  @Column({"type":"timestamptz","name":"last_sync_time","nullable":true})
  lastSyncTime?: Date;

  @Column({"type":"integer","name":"pending_changes_count","default":0})
  pendingChangesCount!: number;

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

}

// Export entity array for TypeORM
export const clientEntities = [
  ClientMigrationStatus,
  Comment,
  LocalChanges,
  Project,
  SyncMetadata,
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
] as const;

// utility tables for client context
export const CLIENT_UTILITY_TABLES = [
] as const;

