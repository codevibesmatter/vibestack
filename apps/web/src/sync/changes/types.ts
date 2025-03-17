/**
 * Types for server changes processing
 */

import { ServerChange } from '../message-types';

/**
 * Represents a server change record in the local_changes table
 */
export interface ServerChangeRecord {
  id: string;
  entity_type: string;
  entity_id: string;
  operation: 'insert' | 'update' | 'delete';
  data: any;
  old_data?: any;
  timestamp: number;
  processed_local: boolean;
  processed_sync: boolean;
  error?: string;
  attempts: number;
  from_server: true;
}

/**
 * Response from server change processing
 */
export interface ServerChangeResponse {
  success: boolean;
  error?: string;
  change_id?: string;
}

/**
 * Server change processing options
 */
export interface ServerChangeOptions {
  skipExisting?: boolean;
  retryOnError?: boolean;
  maxRetries?: number;
}

/**
 * Server change processor interface
 */
export interface ServerChangeProcessor {
  processChanges(changes: ServerChange[], options?: ServerChangeOptions): Promise<ServerChangeResponse[]>;
  recordChange(change: ServerChange): Promise<ServerChangeRecord>;
  retryFailedChanges(options?: ServerChangeOptions): Promise<void>;
} 