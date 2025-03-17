/**
 * This file contains manual definitions of the enums from the TypeORM package
 * to avoid CommonJS/ESM compatibility issues
 */

// Task Status Enum
export enum TaskStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED'
}

// Task Priority Enum
export enum TaskPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH'
}

// Project Status Enum
export enum ProjectStatus {
  ACTIVE = 'active',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  ON_HOLD = 'on_hold'
} 