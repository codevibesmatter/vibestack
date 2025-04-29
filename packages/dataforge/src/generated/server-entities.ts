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

@Entity('change_history')
export class ChangeHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: any;

  @Column({"type":"text","nullable":false})
  lsn!: any;

  @Column({"type":"text","nullable":false,"name":"table_name"})
  tableName!: any;

  @Column({"type":"text","nullable":false})
  operation!: any;

  @Column({"type":"jsonb","nullable":true})
  data?: any;

  @CreateDateColumn({"type":"timestamptz"})
  timestamp!: any;

}

@Entity('client_migration')
export class ClientMigration {
  @Column({"type":"text","name":"migration_name","primary":true})
  migrationName!: any;

  @Column({"type":"text","name":"schema_version"})
  schemaVersion!: any;

  @Column({"type":"text","array":true,"default":[]})
  dependencies!: any[];

  @Column({"type":"enum","enum":{"SCHEMA":"schema","DATA":"data","MIXED":"mixed"},"name":"migration_type"})
  migrationType!: ClientMigration;

  @Column({"type":"enum","enum":{"PENDING":"pending","AVAILABLE":"available","DEPRECATED":"deprecated","REQUIRED":"required"},"default":"pending"})
  state!: ClientMigration;

  @Column({"type":"text","array":true,"name":"up_queries"})
  upQueries!: any[];

  @Column({"type":"text","array":true,"name":"down_queries"})
  downQueries!: any[];

  @Column({"type":"text","nullable":true})
  description?: any;

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

  @OneToMany(() => UserIdentity, (identity) => identity.user, {})
  identities!: UserIdentity[];

}

@Entity('user_identities')
export class UserIdentity extends BaseSystemEntity {
  @Column({"type":"uuid","name":"user_id"})
  userId!: any;

  @Column({"type":"varchar","length":50})
  provider!: any;

  @Column({"type":"varchar","length":255,"name":"provider_id"})
  providerId!: any;

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

