import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';
import { IsUUID, IsString, IsJSON, IsOptional, IsDate } from 'class-validator';
import { ServerOnly } from '../utils/context.js';

@ServerOnly()
@Entity('health_check_state')
export class HealthCheckState {
  @PrimaryGeneratedColumn('uuid')
  @IsUUID(4)
  id!: string;

  @Column({ type: 'timestamp' })
  @IsDate()
  last_run_timestamp!: Date;

  @Column({ type: 'text' })
  @IsString()
  status!: string;

  @Column({ type: 'jsonb', nullable: true })
  @IsJSON()
  @IsOptional()
  metrics?: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamp' })
  created_at!: Date;
} 