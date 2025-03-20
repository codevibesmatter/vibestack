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
  slot: string;
  publication: string;
  hibernationDelay: number;
}

export const DEFAULT_REPLICATION_CONFIG: ReplicationConfig = {
  slot: 'vibestack',
  publication: 'vibestack_pub',
  hibernationDelay: 60000 // 1 minute
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