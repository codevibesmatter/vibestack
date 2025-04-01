import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany, ManyToMany, JoinTable, Relation, JoinColumn } from 'typeorm';
import { 
  IsString, 
  MinLength, 
  IsOptional, 
  IsUUID, 
  MaxLength, 
  IsDate,
  Matches,
  IsEnum
} from 'class-validator';
// Import User and Task for use in decorators
// The Relation wrapper will handle circular dependencies
import { User } from './User.js';
import { Task } from './Task.js';
import { TableCategory } from '../utils/context.js';
// No need for ServerOnly/ClientOnly decorators as this is a shared entity

export enum ProjectStatus {
  ACTIVE = 'active',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  ON_HOLD = 'on_hold'
}

/**
 * Project entity
 * Contains project information and relationships to users and tasks
 * Categorized as a domain entity for replication purposes
 */
@Entity('projects')
@TableCategory('domain')
export class Project {
  @PrimaryGeneratedColumn('uuid')
  @IsUUID(4, { message: "Project ID must be a valid UUID" })
  id!: string;
  
  @Column({ type: "varchar", length: 100 })
  @IsString({ message: "Name must be a string" })
  @MinLength(2, { message: "Name must be at least 2 characters long" })
  @MaxLength(100, { message: "Name cannot exceed 100 characters" })
  @Matches(/^[a-zA-Z0-9\s\-_'.]+$/, { 
    message: "Name can only contain letters, numbers, spaces, hyphens, underscores, apostrophes, and periods" 
  })
  name!: string;
  
  @Column({ type: "text", nullable: true })
  @IsOptional()
  @IsString({ message: "Description must be a string" })
  @MaxLength(5000, { message: "Description cannot exceed 5000 characters" })
  description?: string;
  
  @Column({ type: "enum", enum: ProjectStatus, default: ProjectStatus.ACTIVE })
  @IsEnum(ProjectStatus)
  status!: ProjectStatus;
  
  @Column({ type: "uuid", name: "owner_id" })
  @IsUUID(4, { message: "Owner ID must be a valid UUID" })
  ownerId!: string;
  
  @Column({ type: "uuid", nullable: true, name: "client_id" })
  @IsOptional()
  @IsUUID(4, { message: "Client ID must be a valid UUID" })
  clientId?: string;
  
  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  @IsDate({ message: "Created date must be a valid date" })
  createdAt!: Date;
  
  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  @IsDate({ message: "Updated date must be a valid date" })
  updatedAt!: Date;
  
  // Relationship fields using Relation wrapper to avoid circular dependencies
  @ManyToOne(() => User, (user) => user.ownedProjects)
  @JoinColumn({ name: "owner_id" })
  owner!: Relation<User>;
  
  @ManyToMany(() => User, (user) => user.memberProjects)
  @JoinTable({
    name: 'project_members',
    joinColumn: {
      name: 'project_id',
      referencedColumnName: 'id'
    },
    inverseJoinColumn: {
      name: 'user_id',
      referencedColumnName: 'id'
    }
  })
  members!: Relation<User[]>;
  
  @OneToMany(() => Task, (task) => task.project)
  tasks!: Relation<Task[]>;
} 