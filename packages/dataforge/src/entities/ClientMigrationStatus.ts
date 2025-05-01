import { Entity, Column, PrimaryColumn, CreateDateColumn, Index } from 'typeorm';
import { IsString, IsNumber, IsEnum, Matches } from 'class-validator';
import { ClientOnly, TableCategory } from '../utils/context.js';
import { EnumTypeName } from '../utils/decorators.js';
import { BaseSystemEntity } from './BaseSystemEntity.js';

export enum MigrationStatus {
  PENDING = 'pending',          // Not yet started
  IN_PROGRESS = 'in_progress',  // Currently being applied
  COMPLETED = 'completed',      // Successfully applied
  FAILED = 'failed',           // Failed to apply
  ROLLED_BACK = 'rolled_back'  // Successfully rolled back
}

/**
 * This entity tracks the status of client migrations that have been applied.
 * It is only used in the client database and maintains the client's current
 * schema version and migration state.
 * Categorized as a system table for internal state management
 */
@Entity('client_migration_status')
@(ClientOnly() as ClassDecorator)
@(TableCategory('system') as ClassDecorator)
export class ClientMigrationStatus extends BaseSystemEntity {
  @Column({ type: "text", name: "migration_name" })
  @IsString()
  migrationName!: string;

  @Column({ type: "text", name: "schema_version" })
  @Matches(/^\d+\.\d+\.\d+$/)
  @Index()
  schemaVersion!: string;  // Schema version this migration moves to

  @Column({ type: "enum", enum: MigrationStatus })
  @IsEnum(MigrationStatus)
  @EnumTypeName('MigrationStatus')
  status!: MigrationStatus;

  @Column({ type: "timestamptz", nullable: true, name: "started_at" })
  startedAt?: Date;  // When migration started

  @Column({ type: "timestamptz", nullable: true, name: "completed_at" })
  completedAt?: Date;  // When migration finished (success or failure)

  @Column({ type: "text", nullable: true, name: "error_message" })
  errorMessage?: string;  // Error message if failed

  @Column({ type: "integer", default: 0 })
  @IsNumber()
  attempts!: number;  // Number of attempts to apply

  @Column({ type: "bigint" })
  @IsNumber()
  timestamp!: number;  // For ordering

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
} 