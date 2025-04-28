import { 
  PrimaryGeneratedColumn, 
  CreateDateColumn, 
  UpdateDateColumn,
  Column 
} from 'typeorm';
import { 
  IsUUID, 
  IsDate, 
  IsOptional 
} from 'class-validator';
import { TableCategory } from '../utils/context.js';

/**
 * Base Domain Entity
 * 
 * Provides common properties and behavior for all domain entities
 * that participate in business logic and are replicated between devices.
 * 
 * Features:
 * - UUID primary key
 * - Creation and update timestamps
 * - Client ID for CRDT operations
 * - Domain table categorization
 */
@TableCategory('domain')
export abstract class BaseDomainEntity {
  @PrimaryGeneratedColumn('uuid')
  @IsUUID(4, { message: "ID must be a valid UUID" })
  id!: string;
  
  @Column({ type: "uuid", nullable: true, name: "client_id" })
  @IsOptional()
  @IsUUID(4, { message: "Client ID must be a valid UUID" })
  clientId?: string;
  
  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  @IsDate({ message: "Created date must be a valid date" })
  createdAt!: Date;
  
  @UpdateDateColumn({ 
    type: "timestamptz", 
    name: "updated_at" 
  })
  @IsDate({ message: "Updated date must be a valid date" })
  updatedAt!: Date;
} 