import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, OneToMany, Relation, ManyToMany } from 'typeorm';
import { 
  IsString, 
  IsEmail, 
  MinLength, 
  IsOptional, 
  IsUrl, 
  Matches, 
  IsUUID,
  IsDate,
  IsEnum
} from 'class-validator';
import { ServerOnly, TableCategory } from '../utils/context.js';
// Import Task and Project for use in decorators
// The Relation wrapper will handle circular dependencies
import { Task } from './Task.js';
import { Project } from './Project.js';

export enum UserRole {
  ADMIN = 'admin',
  MEMBER = 'member',
  VIEWER = 'viewer'
}

/**
 * User entity
 * Contains fields for both server and client contexts with appropriate decorators
 * This is a shared entity (not server-only or client-only)
 * Categorized as a domain entity for replication purposes
 */
@Entity('users')
@TableCategory('domain')
export class User {
  @PrimaryGeneratedColumn('uuid')
  @IsUUID(4)
  id!: string;
  
  @Column({ type: "varchar", length: 100 })
  @IsString()
  @MinLength(2, { message: "Name must be at least 2 characters long" })
  @Matches(/^[a-zA-Z0-9\s\-']+$/, { 
    message: "Name can only contain letters, numbers, spaces, hyphens, and apostrophes" 
  })
  name!: string;
  
  @Column({ type: "varchar", length: 255, unique: true })
  @IsEmail({}, { message: "Please provide a valid email address" })
  email!: string;
  
  @Column({ type: "varchar", length: 255, nullable: true })
  @IsOptional()
  @IsUrl({}, { message: "Avatar URL must be a valid URL" })
  avatar_url?: string;
  
  @Column({ type: "enum", enum: UserRole, default: UserRole.MEMBER })
  @IsEnum(UserRole)
  role!: UserRole;
  
  @ServerOnly()
  @Column({ type: "varchar", length: 255, select: false, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: "Password hash must be at least 8 characters long" })
  password_hash?: string;
  
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
  @OneToMany(() => Task, (task) => task.assignee)
  tasks!: Relation<Task[]>;
  
  @OneToMany(() => Project, (project) => project.owner)
  owned_projects!: Relation<Project[]>;
  
  @ManyToMany(() => Project, (project) => project.members)
  member_projects!: Relation<Project[]>;
} 