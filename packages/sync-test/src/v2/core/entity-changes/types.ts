/**
 * Entity Changes - Type Definitions
 * 
 * Central location for all type definitions used in the entity changes system.
 */

import { TableChange as BaseTableChange } from '@repo/sync-types';
import { EntityType } from './entity-adapter.ts';

/**
 * Extended TableChange interface for testing
 * Adds testing-specific properties like batch ID and intentional duplicate marker
 */
export interface TableChangeTest extends BaseTableChange {
  /** Batch ID for tracking groups of changes */
  batchId?: string;
  
  /** Intentional duplicate marker for testing deduplication */
  __intentionalDuplicate?: boolean;
  
  table: string;
  operation: "insert" | "update" | "delete";
  data: any;
  updated_at: string;
  _isConflict?: boolean;
}

/**
 * Mixed changes result interface
 */
export interface MixedChangesResult {
  changes: TableChangeTest[];
  insertUpdatePairs: {
    insertChange: TableChangeTest;
    updateChange: TableChangeTest;
  }[];
  entitySummary?: {
    created: Record<EntityType, string[]>;
    updated: Record<EntityType, string[]>;
    deleted: Record<EntityType, string[]>;
  };
}

/**
 * Options for mixed change generation
 */
export interface MixedChangesOptions {
  // Special modes
  mode?: 'seed' | 'mixed'; // seed mode is insert-only, mixed has a mix of operations
  
  // Fixed batch size (default is 20)
  batchSize?: number;
  
  // Advanced options (optional)
  distribution?: {
    user?: number;    // Percentage of user operations (0.0-1.0)
    project?: number; // Percentage of project operations (0.0-1.0)
    task?: number;    // Percentage of task operations (0.0-1.0)
    comment?: number; // Percentage of comment operations (0.0-1.0)
  };
  
  // Minimum age in seconds for entities to use in updates/deletes
  minEntityAgeInSeconds?: number;
  
  // Batch ID for tracking
  batchId?: string;
  
  // Intentional duplication for testing
  includeIntentionalDuplicate?: boolean;
  
  // Include cascade delete operation
  includeCascadeDelete?: boolean;
  
  // Entity IDs to exclude from updates (avoid updating recently created entities)
  excludeFromUpdates?: Record<EntityType, string[]>;
  
  // Whether to allow entities to be updated multiple times across batches
  allowMultipleUpdates?: boolean;
  
  // Number of batches after which updated entity IDs are released for further updates
  idReleaseAfterBatches?: number;
}

/**
 * Validation result interface for change validation
 */
export interface ValidationResult {
  success: boolean;
  summary: {
    total: {
      database: number;
      received: number;
    };
    byTable: Record<string, {
      database: number;
      received: number;
      missing: number;
      extra: number;
    }>;
    byOperation: Record<string, {
      database: number;
      received: number;
      missing: number;
      extra: number;
    }>;
    intentionalDuplicates: number;
  };
  details: {
    missingChanges: TableChangeTest[];
    extraChanges: TableChangeTest[];
    intentionalDuplicates: TableChangeTest[];
  };
} 