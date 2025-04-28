import { Entity, Column, PrimaryColumn } from 'typeorm';
import { IsString, IsNumber, IsDate, IsOptional } from 'class-validator';
import { ClientOnly } from '../utils/context.js';
import { TableCategory } from '../utils/context.js';

/**
 * SyncMetadata entity
 * 
 * Tracks metadata related to synchronization between client and server
 * Uses a single record with id='sync' to store all sync state
 * 
 * This is a client-only entity that won't be exposed to the server
 */
@Entity('sync_metadata')
@ClientOnly()
@TableCategory('system')
export class SyncMetadata {
  @PrimaryColumn('text')
  @IsString()
  id!: string;

  @Column({ type: 'text', name: 'client_id' })
  @IsString()
  clientId!: string;

  @Column({ type: 'text', name: 'current_lsn', default: '0/0' })
  @IsString()
  currentLsn!: string;

  @Column({ type: 'text', name: 'sync_state', default: 'disconnected' })
  @IsString()
  syncState!: string;

  @Column({ type: 'timestamptz', name: 'last_sync_time', nullable: true })
  @IsDate()
  @IsOptional()
  lastSyncTime?: Date;

  @Column({ type: 'integer', name: 'pending_changes_count', default: 0 })
  @IsNumber()
  pendingChangesCount!: number;
} 