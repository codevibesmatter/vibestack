/**
 * Shared database types
 */

// Re-export the canonical TableChange type
export type { TableChange } from '@repo/sync-types';

/**
 * Error class for database change processing
 */
export class DBChangeProcessorError extends Error {
  constructor(
    message: string,
    public operation: string,
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'DBChangeProcessorError';
  }
} 