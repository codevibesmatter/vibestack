import { 
  Entity, 
  Column, 
  UpdateDateColumn
} from 'typeorm';
import { IsString } from 'class-validator';
import { BaseSystemEntity } from './BaseSystemEntity.js';
import { ServerOnly } from '../utils/context.js';

/**
 * Verification entity
 * Stores tokens for email verification, password reset, etc.
 * Aligned with Better Auth's verification schema
 */
@Entity('verifications')
@(ServerOnly() as ClassDecorator)
export class Verification extends BaseSystemEntity {
  @Column({ type: 'text' })
  @IsString()
  identifier!: string;

  @Column({ type: 'text' })
  @IsString()
  value!: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
} 