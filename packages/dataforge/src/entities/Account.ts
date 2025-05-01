import { 
  Entity, 
  Column, 
  ManyToOne, 
  JoinColumn, 
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn
} from 'typeorm';
import { IsString, IsOptional } from 'class-validator';
import { BaseSystemEntity } from './BaseSystemEntity.js';
import { User } from './User.js';
import { ServerOnly } from '../utils/context.js';

/**
 * Account entity
 * Links users to authentication methods (email/password, social providers)
 * Aligned with Better Auth's account schema
 */
@Entity('accounts')
@(ServerOnly() as ClassDecorator)
export class Account extends BaseSystemEntity {
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: Promise<import('./User.js').User>;

  @Column({ type: 'text', name: 'account_id' })
  @IsString()
  accountId!: string;

  @Column({ type: 'text', name: 'provider_id' })
  @IsString()
  providerId!: string;

  @Column({ type: 'text', name: 'access_token', nullable: true })
  @IsOptional()
  @IsString()
  accessToken?: string;

  @Column({ type: 'text', name: 'refresh_token', nullable: true })
  @IsOptional()
  @IsString()
  refreshToken?: string;

  @Column({ type: 'text', name: 'id_token', nullable: true })
  @IsOptional()
  @IsString()
  idToken?: string;

  @Column({ type: 'timestamptz', name: 'access_token_expires_at', nullable: true })
  accessTokenExpiresAt?: Date;

  @Column({ type: 'timestamptz', name: 'refresh_token_expires_at', nullable: true })
  refreshTokenExpiresAt?: Date;

  @Column({ type: 'text', nullable: true })
  @IsOptional()
  @IsString()
  scope?: string;

  @Column({ type: 'text', nullable: true })
  @IsOptional()
  @IsString()
  password?: string;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
} 