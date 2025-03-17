import { z } from 'zod';
import { 
  User,
  Project,
  Task,
  TaskComment,
  TimeTrackingEntry,
  Entity
} from '@repo/db';

// Re-export types
export type {
  Entity as ValidatedBase,
  User as ValidatedUser,
  Project as ValidatedProject,
  Task as ValidatedTask,
  TaskComment as ValidatedTaskComment,
  TimeTrackingEntry as ValidatedTimeTrackingEntry
}; 