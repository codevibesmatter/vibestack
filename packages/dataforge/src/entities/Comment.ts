import { Entity, Column, ManyToOne, Index, JoinColumn } from 'typeorm';
import { 
  IsString, 
  MinLength, 
  IsUUID, 
  MaxLength,
  IsOptional
} from 'class-validator';
import { User } from './User.js';
import { Task } from './Task.js';
import { Project } from './Project.js';
import { BaseDomainEntity } from './BaseDomainEntity.js';
// No need for ServerOnly/ClientOnly decorators as this is a shared entity

/**
 * Universal Comment entity that can be associated with any entity type
 * Uses separate nullable foreign key columns (taskId, projectId, etc.)
 * Extends BaseDomainEntity for common fields and behavior
 */
@Entity('comments')
// Removed index: @Index("IDX_comments_entity_type_entity_id", ["entityType", "entityId"]) 
export class Comment extends BaseDomainEntity {
  @Column({ type: "text" })
  @IsString()
  @MinLength(1, { message: "Content cannot be empty" })
  @MaxLength(5000, { message: "Content cannot exceed 5000 characters" })
  content!: string;
  
  // Removed entityType and entityId columns

  @Column({ type: "uuid", name: "author_id", nullable: true })
  @IsOptional()
  @IsUUID(4)
  authorId?: string;
  
  /**
   * Optional parent comment ID for threaded comments
   */
  @Column({ type: "uuid", nullable: true, name: "parent_id" })
  @IsOptional()
  @IsUUID(4)
  parentId?: string;

  // --- New FK columns ---
  @Column({ type: "uuid", name: "task_id", nullable: true })
  @IsOptional()
  @IsUUID(4)
  taskId?: string;

  @Column({ type: "uuid", name: "project_id", nullable: true })
  @IsOptional()
  @IsUUID(4)
  projectId?: string;
  
  // --- Relationships ---
  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "author_id" })
  author?: User;
  
  @ManyToOne(() => Comment, { nullable: true })
  @JoinColumn({ name: "parent_id" })
  parent?: Comment;
  
  // --- Relations using new FK columns ---
  @ManyToOne(() => Task, { nullable: true }) // Add nullable here too
  @JoinColumn({ name: "task_id" }) // Join on the specific task_id column
  task?: Task;
  
  @ManyToOne(() => Project, { nullable: true }) // Add nullable here too
  @JoinColumn({ name: "project_id" }) // Join on the specific project_id column
  project?: Project;
} 