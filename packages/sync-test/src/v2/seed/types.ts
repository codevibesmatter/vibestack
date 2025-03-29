import { OrchestratorMessage } from '../workers/types.ts';

/**
 * Configuration for seeding data
 */
export interface SeedConfig {
  userCount: number;          // Number of users to create
  projectsPerUser: number;    // Average projects owned per user
  tasksPerProject: number;    // Average tasks per project 
  commentsPerTask: number;    // Average comments per task
  memberAssignmentRate: number; // Probability (0-1) of adding a user as project member
  taskAssignmentRate: number; // Probability (0-1) of assigning a task to a user
  clientId?: string;          // Optional client ID to associate with entities
  progressInterval?: number;  // How often to show progress updates (in items)
}

/**
 * Preset configurations for different dataset sizes
 */
export const SEED_PRESETS = {
  small: {
    userCount: 25,
    projectsPerUser: 2,
    tasksPerProject: 5,
    commentsPerTask: 2,
    memberAssignmentRate: 0.5,
    taskAssignmentRate: 0.7
  },
  medium: {
    userCount: 200,
    projectsPerUser: 2.5,
    tasksPerProject: 6,
    commentsPerTask: 2.5,
    memberAssignmentRate: 0.5,
    taskAssignmentRate: 0.7
  },
  large: {
    userCount: 1000,
    projectsPerUser: 2,
    tasksPerProject: 5,
    commentsPerTask: 2,
    memberAssignmentRate: 0.5,
    taskAssignmentRate: 0.7
  }
};

/**
 * Stats for seed operation
 */
export interface SeedStats {
  userCount: number;
  projectCount: number;
  taskCount: number;
  commentCount: number;
  timeTaken: number;
  entityTimings: {
    users: number;
    projects: number;
    tasks: number;
    comments: number;
  };
}

/**
 * Message types for seed worker
 */
export type SeedMessageType = 'initialize' | 'seed' | 'clear' | 'status' | 'seed_complete' | 'clear_complete' | 'error';

/**
 * Payload for seed message
 */
export interface SeedMessagePayload {
  seedConfig?: SeedConfig;
  stats?: SeedStats;
  status?: 'processing' | 'waiting' | 'complete';
  current?: number;
  total?: number;
  error?: Error;
}

/**
 * Simple message interface for seed worker
 */
export interface SeedMessage {
  type: SeedMessageType;
  payload: SeedMessagePayload;
} 