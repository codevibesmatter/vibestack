import { Entity, Column, PrimaryColumn, CreateDateColumn, Index } from 'typeorm';
import { IsString, IsArray, IsNumber, IsOptional, IsEnum, Matches } from 'class-validator';
import { ServerOnly, TableCategory } from '../utils/context.js';
import { EnumTypeName } from '../utils/decorators.js';
import { BaseSystemEntity } from './BaseSystemEntity.js';

export enum MigrationType {
  SCHEMA = 'schema',    // Changes to table structure
  DATA = 'data',        // Changes to data only
  MIXED = 'mixed'       // Both schema and data changes
}

export enum MigrationState {
  PENDING = 'pending',          // Created but not yet available to clients
  AVAILABLE = 'available',      // Ready for clients to apply
  DEPRECATED = 'deprecated',    // Superseded by newer migration
  REQUIRED = 'required'         // Must be applied by all clients
}

/**
 * This entity tracks migrations that need to be applied on the client side.
 * It stores the SQL queries that should be run in the client database and
 * manages schema versioning between server and clients.
 * 
 * The entity itself lives in the server database.
 * Categorized as a system table for internal state management
 */
@Entity('client_migration')
@(ServerOnly() as ClassDecorator)
@(TableCategory('system') as ClassDecorator)
export class ClientMigration extends BaseSystemEntity {
  @Column({ type: 'text', name: 'migration_name' })
  @IsString()
  migrationName!: string;

  @Column({ type: 'text', name: 'schema_version' })
  @Matches(/^\d+$/)
  @Index()
  schemaVersion!: string;  // Sequential integer version

  @Column({ type: 'text', array: true, default: [] })
  @IsString({ each: true })
  dependencies!: string[];  // Names of migrations this depends on

  @Column({ type: 'enum', enum: MigrationType, name: 'migration_type' })
  @IsEnum(MigrationType)
  @EnumTypeName('MigrationType')
  migrationType!: MigrationType;

  @Column({ type: 'enum', enum: MigrationState, default: MigrationState.PENDING })
  @IsEnum(MigrationState)
  @EnumTypeName('MigrationState')
  state!: MigrationState;

  @Column({ type: 'text', array: true, name: 'up_queries' })
  @IsArray()
  @IsString({ each: true })
  upQueries!: string[];  // SQL commands to apply migration

  @Column({ type: 'text', array: true, name: 'down_queries' })
  @IsArray()
  @IsString({ each: true })
  downQueries!: string[];  // SQL commands to rollback migration

  @Column({ type: 'text', nullable: true })
  @IsOptional()
  @IsString()
  description?: string;  // Human readable description of changes

  @Column({ type: 'bigint' })
  @IsNumber()
  timestamp!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
} 