import { 
  Entity, 
  Column, 
  CreateDateColumn
} from 'typeorm';
import { IsString } from 'class-validator';
import { BaseSystemEntity } from './BaseSystemEntity.js';
import { ServerOnly } from '../utils/context.js';

/**
 * JWKS (JSON Web Key Set) entity
 * Stores cryptographic keys for JWT (JSON Web Token) authentication
 * This entity is based on Better Auth's JWT plugin schema
 * 
 * Better Auth uses these keys to sign and verify JWT tokens.
 * The public key is shared via the JWKS endpoint for token verification.
 * The private key is used to sign the tokens and should be kept secure.
 */
@Entity('jwks')
@(ServerOnly() as ClassDecorator)
export class JWKS extends BaseSystemEntity {
  @Column({ type: 'text' })
  @IsString()
  publicKey!: string;

  @Column({ type: 'text' })
  @IsString()
  privateKey!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
} 