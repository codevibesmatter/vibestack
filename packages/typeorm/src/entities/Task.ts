import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, ManyToMany, JoinTable, Relation } from 'typeorm';
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
  
  @Column({ type: "timestamptz", nullable: true })
  @IsOptional()
  @IsDate()
  due_date?: Date;
  
  @Column({ type: "timestamptz", nullable: true })
  @IsOptional()
  @IsDate()
  completed_at?: Date;

  @Column({ type: "tsrange", nullable: true })
  @IsOptional()
  time_range?: string;

  @Column({ type: "interval", nullable: true })
  @IsOptional()
  estimated_duration?: string;
  
  @Column("text", { array: true, default: [] })
  @IsArray()
  @IsString({ each: true })
  tags!: string[];
  
  @Column({ type: "uuid" })
  @IsUUID(4)
  project_id!: string;
  
  @Column({ type: "uuid", nullable: true })
  @IsOptional()
  @IsUUID(4)
  assignee_id?: string;
  
  @Column({ type: "uuid", nullable: true })
  @IsOptional()
  @IsUUID(4, { message: "Client ID must be a valid UUID" })
  client_id?: string;
  
  @CreateDateColumn({ type: "timestamptz" })
  @IsDate()
  created_at!: Date;
  
  @UpdateDateColumn({ type: "timestamptz" })
  @IsDate()
  updated_at!: Date;
  
  // Relationship fields using Relation wrapper to avoid circular dependencies
  @ManyToOne(() => Project, (project) => project.tasks)
  project!: Relation<Project>;
  
  @ManyToOne(() => User, (user) => user.tasks, { nullable: true })
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