import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index
} from 'typeorm';

/**
 * ChangeHistory entity for tracking changes for catchup sync
 */
@Entity({ name: 'change_history' })
export class ChangeHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

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