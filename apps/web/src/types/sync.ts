/**
 * Sync-related TypeScript interfaces for the admin app
 */

/**
 * Interface for sync LocalChanges storage
 * Copied from the web app for compatibility
 */
export interface DbLocalChange {
  id: string;           // Primary key
  table: string;        // Table name e.g. 'tasks', 'projects'
  operation: string;    // Operation type: 'insert', 'update', 'delete'
  data: Record<string, unknown>; // Changed data in JSON format
  lsn: string;          // Log Sequence Number
  updatedAt: Date;      // Timestamp when the change occurred
  processedSync: number; // 0 = not processed, 1 = success, 2 = error
}

/**
 * Table change type for sync operations
 */
export interface TableChange {
  table: string;
  operation: 'insert' | 'update' | 'delete';
  data: Record<string, any>;
} 