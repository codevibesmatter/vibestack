import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, ManyToMany, JoinTable, Relation, JoinColumn } from 'typeorm';
import { 
  IsString, 
  MinLength, 
  IsOptional, 
  IsEnum, 
  IsDate, 
  IsInt, 
  Min, 
  IsArray, 
  IsUUID,
  MaxLength
} from 'class-validator';
// Import User and Project for use in decorators
// The Relation wrapper will handle circular dependencies
import { User } from './User.js';
import { Project } from './Project.js';
import { TableCategory } from '../utils/context.js';
// No need for ServerOnly/ClientOnly decorators as this is a shared entity

// These enum values must match the database exactly
export enum TaskStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed'
}

export enum TaskPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high'
}

/**
 * Task entity
 * Contains task information and relationships to users and projects
 * Categorized as a domain entity for replication purposes
 */
@Entity('tasks')
@TableCategory('domain')
export class Task {
  @PrimaryGeneratedColumn('uuid')
  @IsUUID(4)
  id!: string;
  
  @Column({ type: "varchar", length: 100 })
  @IsString()
  @MinLength(1, { message: "Title cannot be empty" })
  @MaxLength(100, { message: "Title cannot exceed 100 characters" })
  title!: string;
  
  @Column({ type: "text", nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(5000, { message: "Description cannot exceed 5000 characters" })
  description?: string;
  
  @Column({ type: "enum", enum: TaskStatus })
  @IsEnum(TaskStatus)
  status!: TaskStatus;
  
  @Column({ type: "enum", enum: TaskPriority, default: TaskPriority.MEDIUM })
  @IsEnum(TaskPriority)
  priority!: TaskPriority;
  
  @Column({ type: "timestamptz", nullable: true, name: "due_date" })
  @IsOptional()
  @IsDate()
  dueDate?: Date;
  
  @Column({ type: "timestamptz", nullable: true, name: "completed_at" })
  @IsOptional()
  @IsDate()
  completedAt?: Date;

  @Column({ type: "tsrange", nullable: true, name: "time_range" })
  @IsOptional()
  timeRange?: string;

  @Column({ type: "interval", nullable: true, name: "estimated_duration" })
  @IsOptional()
  estimatedDuration?: string;
  
  @Column("text", { array: true, default: [] })
  @IsArray()
  @IsString({ each: true })
  tags!: string[];
  
  @Column({ type: "uuid", name: "project_id" })
  @IsUUID(4)
  projectId!: string;
  
  @Column({ type: "uuid", nullable: true, name: "assignee_id" })
  @IsOptional()
  @IsUUID(4)
  assigneeId?: string;
  
  @Column({ type: "uuid", nullable: true, name: "client_id" })
  @IsOptional()
  @IsUUID(4, { message: "Client ID must be a valid UUID" })
  clientId?: string;
  
  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  @IsDate()
  createdAt!: Date;
  
  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  @IsDate()
  updatedAt!: Date;
  
  // Relationship fields using Relation wrapper to avoid circular dependencies
  @ManyToOne(() => Project, (project) => project.tasks)
  @JoinColumn({ name: "project_id" })
  project!: Relation<Project>;
  
  @ManyToOne(() => User, (user) => user.tasks, { nullable: true })
  @JoinColumn({ name: "assignee_id" })
  assignee?: Relation<User>;
  
  @ManyToMany(() => Task)
  @JoinTable({
    name: 'task_dependencies',
    joinColumn: {
      name: 'dependent_task_id',
      referencedColumnName: 'id'
    },
    inverseJoinColumn: {
      name: 'dependency_task_id',
      referencedColumnName: 'id'
    }
  })
  dependencies!: Relation<Task[]>;
} 