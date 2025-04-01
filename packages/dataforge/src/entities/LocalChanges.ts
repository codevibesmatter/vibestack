import { Entity, Column, Index } from 'typeorm';
import { IsString, IsJSON, IsBoolean } from 'class-validator';
import { ClientOnly } from '../utils/context.js';
import { BaseSystemEntity } from './BaseSystemEntity.js';

/**
 * LocalChanges entity
 * Tracks local changes that need to be synced to the server
 * This is a client-only entity that won't be exposed to the server
 * Extends BaseSystemEntity for common system fields and behavior
 */
@Entity('local_changes')
@ClientOnly()
export class LocalChanges extends BaseSystemEntity {
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

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'boolean', default: false, name: 'processed_sync' })
  @IsBoolean()
  processedSync!: boolean;
} 