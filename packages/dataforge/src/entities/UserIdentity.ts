import { 
  Entity, 
  Column, 
  ManyToOne, 
  Relation, 
  Unique, 
  JoinColumn
} from 'typeorm';
import { IsString, MinLength } from 'class-validator';
import { BaseSystemEntity } from './BaseSystemEntity.js';
import { User } from './User.js'; // Import User for relation

/**
 * UserIdentity entity
 * Stores authentication provider details linked to a User.
 * Allows a single User account to be accessed via multiple providers (account linking).
 */
@Entity('user_identities')
@Unique(['provider', 'providerId']) // Ensure a providerId is unique for a given provider
export class UserIdentity extends BaseSystemEntity {
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, (user) => user.identities) // Link back to the User entity
  @JoinColumn({ name: 'user_id' }) // Specify the foreign key column
  user!: Relation<User>;

  @Column({ type: 'varchar', length: 50 })
  @IsString()
  @MinLength(2)
  provider!: string; // e.g., 'github', 'password', 'google'

  @Column({ type: 'varchar', length: 255, name: 'provider_id' })
  @IsString()
  @MinLength(1)
  providerId!: string; // The unique ID from the provider (e.g., GitHub user ID, email for password)
} 