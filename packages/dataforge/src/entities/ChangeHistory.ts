import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn
} from 'typeorm';

/**
 * ChangeHistory entity for tracking changes for catchup sync
 */
@Entity({ name: 'change_history' })
export class ChangeHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: false })
  lsn!: string;

  @Column({ type: 'text', nullable: false })
  table_name!: string;

  @Column({ type: 'text', nullable: false })
  operation!: string;

  @Column({ type: 'jsonb', nullable: true })
  data?: Record<string, any>;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'NOW()' })
  timestamp!: Date;
} 