import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, Index, Relation, JoinColumn } from 'typeorm';
import { 
  IsString, 
  MinLength, 
  IsUUID, 
  MaxLength,
  IsDate,
  IsOptional
} from 'class-validator';
import { TableCategory } from '../utils/context.js';
import { User } from './User.js';
import { Task } from './Task.js';
import { Project } from './Project.js';
// No need for ServerOnly/ClientOnly decorators as this is a shared entity

/**
 * Universal Comment entity that can be associated with any entity type
 * Uses a polymorphic association pattern with entityType and entityId
 * Categorized as a domain entity for replication purposes
 */
@Entity('comments')
@TableCategory('domain')
@Index("IDX_comments_entity_type_entity_id", ["entityType", "entityId"]) // Index for faster lookups by entity
export class Comment {
  @PrimaryGeneratedColumn('uuid')
  @IsUUID(4)
  id!: string;
  
  @Column({ type: "text" })
  @IsString()
  @MinLength(1, { message: "Content cannot be empty" })
  @MaxLength(5000, { message: "Content cannot exceed 5000 characters" })
  content!: string;
  
  /**
   * The type of entity this comment is associated with (e.g., 'task', 'project')
   */
  @Column({ type: "varchar", name: "entity_type" })
  @IsString()
  entityType!: string;
  
  /**
   * The ID of the entity this comment is associated with
   */
  @Column({ type: "uuid", name: "entity_id" })
  @IsUUID(4)
  entityId!: string;
  
  @Column({ type: "uuid", name: "author_id" })
  @IsUUID(4)
  authorId!: string;
  
  /**
   * Optional parent comment ID for threaded comments
   */
  @Column({ type: "uuid", nullable: true, name: "parent_id" })
  @IsOptional()
  @IsUUID(4)
  parentId?: string;
  
  /**
   * Client ID for replication tracking
   */
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
  
  // Relationship fields with explicit JoinColumn decorators
  @ManyToOne(() => User)
  @JoinColumn({ name: "author_id" })
  author!: Relation<User>;
  
  @ManyToOne(() => Comment, { nullable: true })
  @JoinColumn({ name: "parent_id" })
  parent?: Relation<Comment>;
  
  // Note: For polymorphic relationships, we need application code to determine
  // which relationship to use based on entityType
  @ManyToOne(() => Task, { createForeignKeyConstraints: false })
  @JoinColumn([
    { name: "entity_id", referencedColumnName: "id" }
  ])
  task?: Relation<Task>;
  
  @ManyToOne(() => Project, { createForeignKeyConstraints: false })
  @JoinColumn([
    { name: "entity_id", referencedColumnName: "id" }
  ])
  project?: Relation<Project>;
} 