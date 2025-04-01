import { 
  PrimaryGeneratedColumn, 
  CreateDateColumn
} from 'typeorm';
import {
  IsUUID,
  IsDate
} from 'class-validator';
import { TableCategory } from '../utils/context.js';

/**
 * Base System Entity
 * 
 * Provides common properties and behavior for all system entities
 * that manage internal state and are not replicated between devices.
 * 
 * Features:
 * - UUID primary key
 * - Creation timestamp
 * - System table categorization
 * 
 * Note: System entities typically don't need client_id or updated_at
 * as they aren't part of CRDT operations
 */
@TableCategory('system')
export abstract class BaseSystemEntity {
  @PrimaryGeneratedColumn('uuid')
  @IsUUID(4, { message: "ID must be a valid UUID" })
  id!: string;
  
  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  @IsDate({ message: "Created date must be a valid date" })
  createdAt!: Date;
} 