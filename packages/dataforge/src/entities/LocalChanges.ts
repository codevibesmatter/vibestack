import { Entity, Column, PrimaryGeneratedColumn, Index, CreateDateColumn } from 'typeorm';
import { IsUUID, IsString, IsJSON, IsBoolean } from 'class-validator';
import { ClientOnly, TableCategory } from '../utils/context.js';

/**
 * LocalChanges entity
 * Tracks local changes that need to be synced to the server
 * This is a client-only entity that won't be exposed to the server
 */
@Entity('local_changes')
@TableCategory('system')
@ClientOnly()
export class LocalChanges {
  @PrimaryGeneratedColumn('uuid')
  @IsUUID(4)
  id!: string;

  @Column({ type: 'text' })
  @IsString()
  table!: string;

  @Column({ type: 'text' })
  @IsString()
  operation!: string;

  @Column({ type: 'jsonb' })
  @IsJSON()
  data!: Record<string, unknown>;

  @Column({ type: 'text' })
  @IsString()
  lsn!: string;

  @Column({ type: 'timestamptz' })
  updated_at!: Date;

  @Column({ type: 'boolean', default: false })
  @IsBoolean()
  processed_sync!: boolean;
} 