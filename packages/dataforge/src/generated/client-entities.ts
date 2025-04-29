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

@Entity('client_migration_status')
export class ClientMigrationStatus {
  @Column({"type":"text","name":"migration_name","primary":true})
  migrationName!: any;

  @Column({"type":"text","name":"schema_version"})
  schemaVersion!: any;

  @Column({"type":"enum","enum":{"PENDING":"pending","IN_PROGRESS":"in_progress","COMPLETED":"completed","FAILED":"failed","ROLLED_BACK":"rolled_back"}})
  status!: ClientMigrationStatus;

  @Column({"type":"timestamptz","nullable":true,"name":"started_at"})
  startedAt?: any;

  @Column({"type":"timestamptz","nullable":true,"name":"completed_at"})
  completedAt?: any;

  @Column({"type":"text","nullable":true,"name":"error_message"})
  errorMessage?: any;

  @Column({"type":"integer","default":0})
  attempts!: any;

  @Column({"type":"bigint"})
  timestamp!: any;

  @CreateDateColumn({"type":"timestamptz","name":"created_at"})
  createdAt!: any;

}

@Entity('comments')
export class Comment extends BaseDomainEntity {
  @Column({"type":"text"})
  content!: any;

  @Column({"type":"varchar","name":"entity_type"})
  entityType!: any;

  @Column({"type":"uuid","name":"entity_id","nullable":true})
  entityId?: any;

  @Column({"type":"uuid","name":"author_id","nullable":true})
  authorId?: any;

  @Column({"type":"uuid","nullable":true,"name":"parent_id"})
  parentId?: any;

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
  table!: any;

  @Column({"type":"text"})
  operation!: any;

  @Column({"type":"jsonb"})
  data!: any;

  @Column({"type":"text"})
  lsn!: any;

  @Column({"type":"timestamptz","name":"updated_at"})
  updatedAt!: any;

  @Column({"type":"integer","default":0,"name":"processed_sync"})
  processedSync!: any;

}

@Entity('projects')
export class Project extends BaseDomainEntity {
  @Column({"type":"varchar","length":100})
  name!: any;

  @Column({"type":"text","nullable":true})
  description?: any;

  @Column({"type":"enum","enum":{"ACTIVE":"active","IN_PROGRESS":"in_progress","COMPLETED":"completed","ON_HOLD":"on_hold"},"default":"active"})
  status!: Project;

  @Column({"type":"uuid","name":"owner_id","nullable":true})
  ownerId?: any;

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
  id!: any;

  @Column({"type":"text","name":"client_id"})
  clientId!: any;

  @Column({"type":"text","name":"current_lsn","default":"0/0"})
  currentLsn!: any;

  @Column({"type":"text","name":"sync_state","default":"disconnected"})
  syncState!: any;

  @Column({"type":"timestamptz","name":"last_sync_time","nullable":true})
  lastSyncTime?: any;

  @Column({"type":"integer","name":"pending_changes_count","default":0})
  pendingChangesCount!: any;

}

@Entity('tasks')
export class Task extends BaseDomainEntity {
  @Column({"type":"varchar","length":100})
  title!: any;

  @Column({"type":"text","nullable":true})
  description?: any;

  @Column({"type":"enum","enum":{"OPEN":"open","IN_PROGRESS":"in_progress","COMPLETED":"completed"}})
  status!: Task;

  @Column({"type":"enum","enum":{"LOW":"low","MEDIUM":"medium","HIGH":"high"},"default":"medium"})
  priority!: Task;

  @Column({"type":"timestamptz","nullable":true,"name":"due_date"})
  dueDate?: any;

  @Column({"type":"timestamptz","nullable":true,"name":"completed_at"})
  completedAt?: any;

  @Column({"type":"tsrange","nullable":true,"name":"time_range"})
  timeRange?: any;

  @Column({"type":"interval","nullable":true,"name":"estimated_duration"})
  estimatedDuration?: any;

  @Column({"array":true,"default":[],"type":"text"})
  tags!: any[];

  @Column({"type":"uuid","name":"project_id","nullable":true})
  projectId?: any;

  @Column({"type":"uuid","nullable":true,"name":"assignee_id"})
  assigneeId?: any;

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
  name!: any;

  @Column({"type":"varchar","length":255,"unique":true})
  email!: any;

  @Column({"type":"varchar","length":255,"nullable":true,"name":"avatar_url"})
  avatarUrl?: any;

  @Column({"type":"enum","enum":{"ADMIN":"admin","MEMBER":"member","VIEWER":"viewer"},"default":"member"})
  role!: User;

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

