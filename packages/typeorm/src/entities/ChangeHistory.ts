import { Entity, Column, PrimaryGeneratedColumn, Index, CreateDateColumn } from 'typeorm';
import { IsUUID, IsString, IsJSON, IsOptional } from 'class-validator';
import { ServerOnly, TableCategory } from '../utils/context.js';

/**
 * ChangeHistory entity
 * Tracks changes to domain entities for replication purposes
 * Uses CRDT with last-write-wins based on updated_at
 * This is a server-only entity that won't be exposed to clients
 * Note: client_id is nullable for changes from external sources
 */
@Entity('change_history')
@TableCategory('system')
@ServerOnly()
@Index('idx_table_updated_at', ['table_name', 'updated_at'])
export class ChangeHistory {
  @PrimaryGeneratedColumn('uuid')
  @IsUUID(4)
  id!: string;

  @Column({ type: 'text' })
  @IsString()
  @Index('idx_lsn')
  lsn!: string;

  @Column({ type: 'text' })
  @IsString()
  table_name!: string;

  @Column({ type: 'text' })
  @IsString()
  operation!: string;

  @Column({ type: 'jsonb' })
  @IsJSON()
  data!: Record<string, unknown>;

  @Column({ type: 'timestamptz' })
  @Index('idx_updated_at')
  updated_at!: Date;

  @Column({ type: 'uuid', nullable: true })
  @IsUUID(4)
  @IsOptional()
  @Index('idx_client_id')
  client_id?: string;
} 