import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, Index } from 'typeorm';
import { 
  IsString, 
  MinLength, 
  IsUUID, 
  MaxLength,
  IsDate,
  IsOptional
} from 'class-validator';
import { TableCategory } from '../utils/context.js';
// No need for ServerOnly/ClientOnly decorators as this is a shared entity

/**
 * Universal Comment entity that can be associated with any entity type
 * Uses a polymorphic association pattern with entityType and entityId
 * Categorized as a domain entity for replication purposes
 */
@Entity('comments')
@TableCategory('domain')
@Index(['entityType', 'entityId']) // Index for faster lookups by entity
export class Comment {
  @PrimaryGeneratedColumn('uuid')
  @IsUUID(4, { message: "ID must be a valid UUID" })
  id!: string;
  
  @Column({ type: "text" })
  @IsString({ message: "Content must be a string" })
  @MinLength(1, { message: "Content cannot be empty" })
  @MaxLength(5000, { message: "Content cannot exceed 5000 characters" })
  content!: string;
  
  /**
   * The type of entity this comment is associated with (e.g., 'task', 'project')
   */
  @Column({ type: "varchar" })
  @IsString({ message: "Entity type must be a string" })
  entityType!: string;
  
  /**
   * The ID of the entity this comment is associated with
   */
  @Column({ type: "uuid" })
  @IsUUID(4, { message: "Entity ID must be a valid UUID" })
  entityId!: string;
  
  @Column({ type: "uuid" })
  @IsUUID(4, { message: "Author ID must be a valid UUID" })
  authorId!: string;
  
  /**
   * Optional parent comment ID for threaded comments
   */
  @Column({ type: "uuid", nullable: true })
  @IsOptional()
  @IsUUID(4, { message: "Parent comment ID must be a valid UUID" })
  parentId?: string;
  
  @CreateDateColumn({ type: "timestamp" })
  @IsDate({ message: "Created date must be a valid date" })
  createdAt!: Date;
  
  @UpdateDateColumn({ type: "timestamp" })
  @IsDate({ message: "Updated date must be a valid date" })
  updatedAt!: Date;
  
  // Relationship fields - these will be properly linked when all entities are created
  // @ManyToOne(() => User)
  // author!: User;
  
  // @ManyToOne(() => Comment, { nullable: true })
  // parent?: Comment;
} 