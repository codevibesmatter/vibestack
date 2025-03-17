/**
 * @repo/shared-types
 * 
 * This module exports all shared TypeScript type definitions.
 */

// Environment types
export type { Env, ApiEnv, RuntimeEnv, LogLevel, WALMessage, WALChange, Change } from './env/env-types';

// Service types and utilities
export {
  type ServiceResult,
  type SuccessResponse,
  type ErrorResponse,
  type ServiceError,
  ServiceErrorType,
  ErrorTypeToStatus,
  createSuccessResponse,
  createErrorResponse
} from './validation/services';

// Re-export entity types
export type { User } from '@repo/typeorm/entities/User';
export type { Task } from '@repo/typeorm/entities/Task';
export type { Project } from '@repo/typeorm/entities/Project';
export type { Comment as TaskComment } from '@repo/typeorm/entities/Comment';

// Re-export TypeORM types
export type { Entity } from 'typeorm';

// Define enum types that might be used in entities
export enum UserRole {
  ADMIN = 'admin',
  USER = 'user'
}

// Define placeholder types for entities that might not exist yet
export interface TimeTrackingEntry {
  id: string;
  task_id: string;
  start_time: Date;
  end_time?: Date;
}

export interface ProjectSettings {
  project_id: string;
  settings: Record<string, any>;
}