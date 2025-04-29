import { Entity, Column, OneToMany, ManyToMany } from 'typeorm';
import { 
  IsString, 
  IsEmail, 
  MinLength, 
  IsOptional, 
  IsUrl, 
  Matches, 
  IsEnum
} from 'class-validator';
import { ServerOnly } from '../utils/context.js';
// Import Task and Project for use in decorators
// The Relation wrapper will handle circular dependencies
import { Task } from './Task.js';
import { Project } from './Project.js';
import { BaseDomainEntity } from './BaseDomainEntity.js';
import { UserIdentity } from './UserIdentity.js';

export enum UserRole {
  ADMIN = 'admin',
  MEMBER = 'member',
  VIEWER = 'viewer'
}

/**
 * User entity
 * Contains fields for both server and client contexts with appropriate decorators
 * This is a shared entity (not server-only or client-only)
 * Extends BaseDomainEntity for common fields and behavior
 */
@Entity('users')
export class User extends BaseDomainEntity {
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
  
  @Column({ type: "varchar", length: 255, nullable: true, name: "avatar_url" })
  @IsOptional()
  @IsUrl({}, { message: "Avatar URL must be a valid URL" })
  avatarUrl?: string;
  
  @Column({ type: "enum", enum: UserRole, default: UserRole.MEMBER })
  @IsEnum(UserRole)
  role!: UserRole;
  
  // Relationship fields using Relation wrapper to avoid circular dependencies
  @OneToMany(() => Task, (task) => task.assignee)
  tasks!: Promise<import('./Task.js').Task[]>;
  
  @OneToMany(() => Project, (project) => project.owner)
  ownedProjects!: Promise<import('./Project.js').Project[]>;
  
  @ManyToMany(() => Project, (project) => project.members)
  memberProjects!: Promise<import('./Project.js').Project[]>;

  @ServerOnly()
  @OneToMany(() => UserIdentity, (identity) => identity.user)
  identities!: Promise<import('./UserIdentity.js').UserIdentity[]>;
} 