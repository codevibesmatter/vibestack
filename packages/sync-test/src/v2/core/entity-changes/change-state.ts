/**
 * Change State Manager
 * 
 * Manages state of changes including tracking, grouping, summarizing, and progress calculation.
 * Provides utilities for monitoring sync progress and change reporting.
 */

import { TableChangeTest } from './types.ts';
import { EntityType, TABLE_TO_ENTITY } from './entity-adapter.ts';
import { createLogger } from '../logger.ts';

// Initialize logger
const logger = createLogger('entity-changes.state');

/**
 * Intentional duplicate interface for tracking test duplicates
 */
export interface IntentionalDuplicate {
  original: TableChangeTest;
  duplicate: TableChangeTest;
}

/**
 * Summary of changes by client, table, or operation
 */
export interface ChangeSummary {
  total: number;
  byTable: Record<string, number>;
  byOperation: Record<string, number>;
  byClient?: Record<string, number>;
  duplicates?: number;
  progress?: {
    expected: number;
    received: number;
    percentage: number;
  };
}

/**
 * Detailed change grouping used for analysis
 */
export interface ChangeGroups {
  byTable: Record<string, TableChangeTest[]>;
  byOperation: Record<string, TableChangeTest[]>;
  byTableAndOperation: Record<string, Record<string, TableChangeTest[]>>;
}

/**
 * Change State Manager class
 */
export class ChangeStateManager {
  // Track changes by client ID
  private changesByClient: Record<string, TableChangeTest[]> = {};
  
  // Track database changes (source of truth)
  private databaseChanges: TableChangeTest[] = [];
  
  // Track intentional duplicates
  private intentionalDuplicates: IntentionalDuplicate[] = [];
  
  // Track batch information
  private batchesSeen: number = 0;
  private lastBatchTime: number = 0;
  private inactivityTimeout: number = 15000; // Default 15 seconds
  
  // Logger instance
  private logger = createLogger('entity-changes.state');
  
  /**
   * Create a new ChangeStateManager
   */
  constructor(options: {
    inactivityTimeout?: number;
    logLevel?: string;
  } = {}) {
    if (options.inactivityTimeout) {
      this.inactivityTimeout = options.inactivityTimeout;
    }
    
    // We don't need to set log level since it's not supported by the logger
    // Just log the configured level instead
    if (options.logLevel) {
      this.logger.info(`Log level requested: ${options.logLevel}`);
    }
  }
  
  /**
   * Record database changes that were applied
   * @param changes The database changes that were applied
   */
  recordDatabaseChanges(changes: TableChangeTest[], batchId?: string): void {
    this.databaseChanges = [...this.databaseChanges, ...changes];
    
    // Modified log that accounts for intentional duplicates
    if (this.intentionalDuplicates.length > 0) {
      this.logger.info(
        `Recorded ${changes.length} database changes (total: ${this.databaseChanges.length}) ` +
        `with ${this.intentionalDuplicates.length} intentional duplicates`
      );
    } else {
      this.logger.info(`Recorded ${changes.length} database changes (total: ${this.databaseChanges.length})`);
    }
  }
  
  /**
   * Mark certain changes as intentional duplicates
   * @param duplicates Intentional duplicate objects with original and duplicate changes
   */
  recordIntentionalDuplicates(duplicates: IntentionalDuplicate[]): void {
    this.intentionalDuplicates = [...this.intentionalDuplicates, ...duplicates];
    this.logger.info(`Recorded ${duplicates.length} intentional duplicates (total: ${this.intentionalDuplicates.length})`);
  }
  
  /**
   * Record received changes for a client
   * @param clientId The client ID that received the changes
   * @param changes The changes received by the client
   */
  recordClientChanges(clientId: string, changes: TableChangeTest[]): void {
    if (!this.changesByClient[clientId]) {
      this.changesByClient[clientId] = [];
    }
    
    this.changesByClient[clientId] = [...this.changesByClient[clientId], ...changes];
    
    this.batchesSeen++;
    this.lastBatchTime = Date.now();
    
    // Replace with a debug level log if absolutely needed
    this.logger.debug(`Recorded ${changes.length} changes for client ${clientId} (total: ${this.changesByClient[clientId].length})`);
  }
  
  /**
   * Get batch statistics including counts and timing information
   * @returns Batch statistics object
   */
  getBatchStatistics(): {
    totalBatches: number;
    totalChangesReceived: number;
    lastBatchTime: number;
    changesByBatch: number[];
  } {
    // Calculate total changes received across all clients
    const totalChangesReceived = Object.values(this.changesByClient)
      .reduce((sum, changes) => sum + changes.length, 0);
    
    return {
      totalBatches: this.batchesSeen,
      totalChangesReceived,
      lastBatchTime: this.lastBatchTime,
      changesByBatch: [] // Placeholder for future batch-by-batch tracking if needed
    };
  }
  
  /**
   * Get a client's progress in receiving expected changes
   * @param clientId The client ID to check progress for
   * @returns Progress metrics for the client
   */
  getClientProgress(clientId: string): {
    expected: number;
    received: number;
    percentage: number;
    complete: boolean;
  } {
    const expected = this.databaseChanges.length - this.intentionalDuplicates.length;
    const received = this.changesByClient[clientId]?.length || 0;
    const percentage = expected > 0 ? (received / expected) * 100 : 0;
    
    return {
      expected,
      received,
      percentage,
      complete: percentage >= 100
    };
  }
  
  /**
   * Get detailed summary of changes for a client
   * @param clientId The client ID to get summary for
   * @returns A summary of changes for the client
   */
  getClientSummary(clientId: string): ChangeSummary {
    const changes = this.changesByClient[clientId] || [];
    
    // Create the summary
    const summary: ChangeSummary = {
      total: changes.length,
      byTable: {},
      byOperation: {},
      progress: this.getClientProgress(clientId)
    };
    
    // Summarize by table and operation
    for (const change of changes) {
      // Count by table
      summary.byTable[change.table] = (summary.byTable[change.table] || 0) + 1;
      
      // Count by operation
      summary.byOperation[change.operation] = (summary.byOperation[change.operation] || 0) + 1;
    }
    
    return summary;
  }
  
  /**
   * Group changes by table, operation, or both
   * @param changes The changes to group
   * @returns Grouped changes for detailed analysis
   */
  groupChanges(changes: TableChangeTest[]): ChangeGroups {
    const groups: ChangeGroups = {
      byTable: {},
      byOperation: {},
      byTableAndOperation: {}
    };
    
    for (const change of changes) {
      // Group by table
      if (!groups.byTable[change.table]) {
        groups.byTable[change.table] = [];
      }
      groups.byTable[change.table].push(change);
      
      // Group by operation
      if (!groups.byOperation[change.operation]) {
        groups.byOperation[change.operation] = [];
      }
      groups.byOperation[change.operation].push(change);
      
      // Group by table and operation
      if (!groups.byTableAndOperation[change.table]) {
        groups.byTableAndOperation[change.table] = {};
      }
      
      if (!groups.byTableAndOperation[change.table][change.operation]) {
        groups.byTableAndOperation[change.table][change.operation] = [];
      }
      
      groups.byTableAndOperation[change.table][change.operation].push(change);
    }
    
    return groups;
  }
  
  /**
   * Generate a human-readable summary of changes
   * @param changes The changes to summarize
   * @returns A string summary suitable for logging
   */
  getChangeSummaryText(changes: TableChangeTest[]): string {
    const groups = this.groupChanges(changes);
    
    // Summary by table and operation - compact format on a single line
    const tableOperationSummary = Object.entries(groups.byTableAndOperation)
      .map(([table, operations]) => {
        return Object.entries(operations)
          .map(([operation, tableOpChanges]) => {
            let text = `${table}:${operation}:${tableOpChanges.length}`;
            
            // Add IDs if there are 5 or fewer
            if (tableOpChanges.length <= 5 && tableOpChanges.some(c => c.data?.id)) {
              const ids = tableOpChanges.map(c => {
                const id = c.data?.id || 'no-id';
                return typeof id === 'string' ? id.substring(0, 8) : id;
              }).join(',');
              
              text += `[${ids}]`;
            }
            return text;
          })
          .join(' ');
      })
      .filter(Boolean)
      .join(' | ');
    
    // Summary by operation
    const operationSummary = Object.entries(groups.byOperation)
      .map(([operation, opChanges]) => `${operation}:${opChanges.length}`)
      .join(',');
    
    return `Change summary: ${changes.length} total | ${tableOperationSummary} | Ops[${operationSummary}]`;
  }
  
  /**
   * Check if a batch is considered complete based on inactivity
   */
  isBatchComplete(): boolean {
    const currentTime = Date.now();
    const timeSinceLastBatch = currentTime - this.lastBatchTime;
    
    return timeSinceLastBatch > this.inactivityTimeout;
  }
  
  /**
   * Find duplicate changes in a batch
   * @param changes The changes to check for duplicates
   * @returns Information about any duplicates found
   */
  findDuplicates(changes: TableChangeTest[]): {
    count: number;
    duplicates: Array<{
      key: string;
      current: TableChangeTest;
      previous: TableChangeTest;
    }>;
  } {
    const seenChanges = new Map<string, TableChangeTest>();
    const duplicates: Array<{
      key: string;
      current: TableChangeTest;
      previous: TableChangeTest;
    }> = [];
    
    for (const change of changes) {
      const id = change.data?.id;
      if (!id) continue;
      
      const key = `${change.table}:${id}:${change.operation}`;
      
      if (seenChanges.has(key)) {
        duplicates.push({
          key,
          current: change,
          previous: seenChanges.get(key)!
        });
      } else {
        seenChanges.set(key, change);
      }
    }
    
    return {
      count: duplicates.length,
      duplicates
    };
  }
  
  /**
   * Find matching changes between two sets
   * @param sourceChanges Source changes to check against (database changes)
   * @param targetChanges Target changes to check (client changes)
   * @returns Information about matches between the sets
   */
  findMatches(
    sourceChanges: TableChangeTest[],
    targetChanges: TableChangeTest[]
  ): {
    matches: TableChangeTest[];
    missing: TableChangeTest[];
    extra: TableChangeTest[];
    matchPercentage: number;
  } {
    // Find matches (changes in both sets)
    const matches = targetChanges.filter(targetChange => 
      sourceChanges.some(sourceChange => 
        sourceChange.table === targetChange.table && 
        sourceChange.operation === targetChange.operation && 
        sourceChange.data?.id === targetChange.data?.id
      )
    );
    
    // Find missing (in source but not in target)
    const missing = sourceChanges.filter(sourceChange => 
      !targetChanges.some(targetChange => 
        sourceChange.table === targetChange.table && 
        sourceChange.operation === targetChange.operation && 
        sourceChange.data?.id === targetChange.data?.id
      )
    );
    
    // Find extra (in target but not in source)
    const extra = targetChanges.filter(targetChange => 
      !sourceChanges.some(sourceChange => 
        sourceChange.table === targetChange.table && 
        sourceChange.operation === targetChange.operation && 
        sourceChange.data?.id === targetChange.data?.id
      )
    );
    
    // Calculate match percentage
    const matchPercentage = sourceChanges.length > 0 
      ? (matches.length / sourceChanges.length) * 100 
      : 0;
    
    return {
      matches,
      missing,
      extra,
      matchPercentage
    };
  }
  
  /**
   * Get overall sync status for all clients
   * @returns Summary of sync status for all clients
   */
  getSyncStatus(): Record<string, {
    progress: {
      expected: number;
      received: number;
      percentage: number;
      complete: boolean;
    };
    summary: ChangeSummary;
  }> {
    const status: Record<string, any> = {};
    
    for (const clientId of Object.keys(this.changesByClient)) {
      status[clientId] = {
        progress: this.getClientProgress(clientId),
        summary: this.getClientSummary(clientId)
      };
    }
    
    return status;
  }
  
  /**
   * Reset all state information
   */
  reset(): void {
    this.changesByClient = {};
    this.databaseChanges = [];
    this.intentionalDuplicates = [];
    this.batchesSeen = 0;
    this.lastBatchTime = 0;
    
    this.logger.info('State manager reset');
  }
  
  /**
   * Get all changes received by a specific client
   * @param clientId The client ID to get changes for
   * @returns Array of changes received by the client
   */
  getClientChanges(clientId: string): TableChangeTest[] {
    return this.changesByClient[clientId] || [];
  }
  
  /**
   * Get all database changes that were applied
   * @returns Array of all database changes
   */
  getDatabaseChanges(): TableChangeTest[] {
    return this.databaseChanges;
  }
  
  /**
   * Get all intentional duplicates
   * @returns Array of all intentional duplicates
   */
  getIntentionalDuplicates(): IntentionalDuplicate[] {
    return this.intentionalDuplicates;
  }
  
  /**
   * Check if synchronization is complete for all clients
   * @returns True if sync is complete for all clients
   */
  isSyncComplete(): boolean {
    // If no database changes have been applied, sync cannot be complete
    if (this.databaseChanges.length === 0) {
      return false;
    }
    
    // If no clients have received changes, sync cannot be complete
    if (Object.keys(this.changesByClient).length === 0) {
      return false;
    }
    
    // Check if all clients have received 100% of expected changes
    for (const clientId of Object.keys(this.changesByClient)) {
      const progress = this.getClientProgress(clientId);
      if (!progress.complete) {
        return false;
      }
    }
    
    // All clients have received all expected changes
    return true;
  }
}

// Export a global instance for convenience
export const globalChangeStateManager = new ChangeStateManager(); 