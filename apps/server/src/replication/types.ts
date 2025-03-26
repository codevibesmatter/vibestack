import type { DurableObjectState } from '../types/cloudflare';
import type { Context } from 'hono';
import type { AppBindings } from '../types/hono';
import type { TableChange } from '@repo/sync-types';
// Import domain tables from the typeorm package
import { SERVER_DOMAIN_TABLES } from '@repo/dataforge/server-entities';

/**
 * Configuration for the replication system
 */
export interface ReplicationConfig {
  /**
   * Replication slot name used for PostgreSQL logical replication
   */
  slot: string;
  
  /**
   * Publication name for logical replication setup
   */
  publication: string;
  
  /**
   * Maximum number of WAL changes to fetch in a single peek operation
   * Higher values process more changes at once but use more memory
   */
  walBatchSize?: number;
  
  /**
   * Maximum number of WAL changes to consume in a single consume operation
   * Controls how many changes to acknowledge to PostgreSQL at once
   */
  walConsumeSize?: number;
  
  /**
   * Threshold percentage of batch size that triggers immediate re-polling
   * When reached, system will immediately poll again without waiting for the next cycle
   * Value from 0.0 to 1.0 (e.g., 0.5 = re-poll when batch is 50% full)
   */
  walBatchThreshold?: number;
  
  /**
   * Interval in milliseconds between polling cycles
   * Shorter intervals detect changes faster but consume more resources
   */
  pollingInterval?: number;
  
  /**
   * Faster polling interval to use when high throughput is detected
   * This allows the system to process large batches of changes more quickly
   * For example, 100ms for high throughput vs 1000ms for normal operation
   */
  fastPollingInterval?: number;
  
  /**
   * Maximum number of consecutive immediate re-polls when batches are full
   * Prevents infinite loops if there are too many changes
   */
  maxConsecutivePolls?: number;
  
  /**
   * Batch size for storing changes in the change_history table
   * Controls how many INSERT statements are batched together
   */
  storeBatchSize?: number;
  
  /**
   * Skip consuming WAL during normal processing cycle
   * When true, the replication system only tracks LSN position without consuming WAL
   * This can improve performance for high-volume changes as WAL can be consumed on a separate schedule
   * Default is false for backward compatibility
   */
  skipWALConsumption?: boolean;
}

export const DEFAULT_REPLICATION_CONFIG: ReplicationConfig = {
  slot: 'vibestack',
  publication: 'vibestack_pub',
  walBatchSize: 2000,      // Increased from 1000 - maximum changes to peek at once
  walConsumeSize: 2000,    // Increased from 1000 - maximum changes to consume at once
  walBatchThreshold: 0.5,  // Re-poll immediately if batch is 50% full
  pollingInterval: 1000,   // 1 second between polls
  fastPollingInterval: 100, // 100ms for high throughput scenarios
  maxConsecutivePolls: 10, // Maximum consecutive immediate re-polls
  storeBatchSize: 100,     // Number of changes to batch in a single INSERT
  skipWALConsumption: true  // Skip consuming WAL during normal processing for improved performance
};

/**
 * Metrics for monitoring replication performance
 */
export interface ReplicationMetrics {
  changes: {
    processed: number;
    failed: number;
  };
  errors: Map<string, number>;
  notifications: {
    totalNotificationsSent: number;
  };
}

export type MinimalContext = Context<AppBindings>;

export interface ReplicationLagStatus {
  replayLag: number;  // Seconds behind
  writeLag: number;   // Bytes behind in WAL
  flushLag: number;   // Bytes not yet flushed
}

/**
 * Health check metrics interface
 */
export interface HealthCheckMetrics {
  tables_checked: number;
  records_scanned: number;
  missing_changes_found: number;
  synthetic_changes_created: number;
  errors: number;
  duration_ms: number;
  tables_with_issues: string[];
}

/**
 * Health check result interface
 */
export interface HealthCheckResult {
  success: boolean;
  timestamp: string;
  metrics: HealthCheckMetrics;
  error?: string;
}

/**
 * Initial cleanup metrics interface
 */
export interface InitialCleanupMetrics {
  tables_checked: number;
  records_scanned: number;
  early_records_found: number;
  synthetic_changes_created: number;
  errors: number;
  duration_ms: number;
  tables_with_issues: string[];
}

/**
 * Initial cleanup result interface
 */
export interface InitialCleanupResult {
  success: boolean;
  timestamp: string;
  metrics: InitialCleanupMetrics;
  error?: string;
}

export interface SlotStatus {
  exists: boolean;
  lsn?: string;
}

// For type safety when dealing with domain tables
export type DomainTable = typeof SERVER_DOMAIN_TABLES[number];

/**
 * Get the list of domain tables to track for replication
 */
export function getDomainTables(): string[] {
  return SERVER_DOMAIN_TABLES as unknown as string[];
}

/**
 * Verification metrics interface
 */
export interface VerificationMetrics {
  table: string;
  current_count: number;
  expected_count: number;
  matches: boolean;
  change_history: {
    inserts: number;
    updates: number;
    deletes: number;
  };
  details?: {
    current_ids: string[];
    missing_ids: string[];  // IDs that exist in change history but not in table
    extra_ids: string[];    // IDs that exist in table but not in change history
    change_history_by_id: Record<string, {
      final_operation: 'insert' | 'update' | 'delete';
      operations_count: {
        inserts: number;
        updates: number;
        deletes: number;
      };
    }>;
  };
}

/**
 * Verification result interface
 */
export interface VerificationResult {
  success: boolean;
  timestamp: string;
  verification: VerificationMetrics[];
  error?: string;
} 