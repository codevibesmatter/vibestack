import { Entity, Column, OneToMany, ManyToMany } from 'typeorm';
import { 
  IsString, 
  IsEmail, 
  MinLength, 
  IsOptional, 
  IsUrl, 
  Matches, 
  IsEnum,
  IsBoolean
} from 'class-validator';
import { ServerOnly } from '../utils/context.js';
// Import Task and Project for use in decorators
// The Relation wrapper will handle circular dependencies
import { Task } from './Task.js';
import { Project } from './Project.js';
import { BaseDomainEntity } from './BaseDomainEntity.js';
import { EnumTypeName } from '../utils/decorators.js';
import { Session } from './Session.js';
import { Account } from './Account.js';

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
 * Aligned with Better Auth's user schema
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
  
  @Column({ type: "boolean", name: "email_verified", default: false })
  @IsBoolean()
  emailVerified!: boolean;
  
  @Column({ type: "varchar", length: 255, nullable: true, name: "image" })
  @IsOptional()
  @IsUrl({}, { message: "Image URL must be a valid URL" })
  image?: string;
  
  @Column({ type: "enum", enum: UserRole, default: UserRole.MEMBER })
  @IsEnum(UserRole)
  @EnumTypeName('UserRole')
  role!: UserRole;
  
  // Relationship fields using Relation wrapper to avoid circular dependencies
  @OneToMany(() => Task, (task) => task.assignee)
  tasks!: Promise<import('./Task.js').Task[]>;
  
  @OneToMany(() => Project, (project) => project.owner)
  ownedProjects!: Promise<import('./Project.js').Project[]>;
  
  @ManyToMany(() => Project, (project) => project.members)
  memberProjects!: Promise<import('./Project.js').Project[]>;

  @ServerOnly()
  @OneToMany(() => Session, (session) => session.user)
  sessions!: Promise<import('./Session.js').Session[]>;

  @ServerOnly()
  @OneToMany(() => Account, (account) => account.user)
  accounts!: Promise<import('./Account.js').Account[]>;
} 