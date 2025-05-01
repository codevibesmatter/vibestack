import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index
} from 'typeorm';
import { ServerOnly } from '../utils/context.js';
import { BaseSystemEntity } from './BaseSystemEntity.js';

/**
 * ChangeHistory entity for tracking changes for catchup sync
 * Server-only entity - not replicated to clients
 */
@Entity({ name: 'change_history' })
@ServerOnly()
export class ChangeHistory extends BaseSystemEntity {
  // Regular text index for basic lookups
  @Index()
  @Column({ type: 'text', nullable: false })
  lsn!: string;

  @Column({ type: 'text', nullable: false, name: 'table_name' })
  tableName!: string;

  @Column({ type: 'text', nullable: false })
  operation!: string;

  @Column({ type: 'jsonb', nullable: true })
  data?: Record<string, any>;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'NOW()' })
  timestamp!: Date;
} 