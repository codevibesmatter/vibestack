import { 
  Entity, 
  Column, 
  ManyToOne, 
  JoinColumn, 
  UpdateDateColumn
} from 'typeorm';
import { IsString, IsOptional } from 'class-validator';
import { BaseSystemEntity } from './BaseSystemEntity.js';
import { User } from './User.js';
import { ServerOnly } from '../utils/context.js';

/**
 * Session entity
 * Stores active user sessions
 * Aligned with Better Auth's session schema
 */
@Entity('sessions')
@(ServerOnly() as ClassDecorator)
export class Session extends BaseSystemEntity {
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: Promise<import('./User.js').User>;

  @Column({ type: 'text', unique: true })
  @IsString()
  token!: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'text', name: 'ip_address', nullable: true })
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @Column({ type: 'text', name: 'user_agent', nullable: true })
  @IsOptional()
  @IsString()
  userAgent?: string;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
} 