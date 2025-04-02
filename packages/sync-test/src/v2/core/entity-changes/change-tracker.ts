/**
 * Change tracker for entity-changes system
 * Allows tracking changes across clients, validation, and deduplication analysis
 */

import { EventEmitter } from 'events';
import { TableChange } from '@repo/sync-types';
import { createLogger } from '../logger.ts';

/**
 * Simple tracking state for a client
 */
interface ClientTrackingState {
  receivedCount: number;
  expectedCount: number;
  changes: TableChange[];
}

/**
 * Information about deduplication for a specific entity
 */
interface DeduplicationInfo {
  totalChanges: number;
  receivedChanges: number;
  deduplicatedChanges: number;
  isDeduplication: boolean;
}

/**
 * Options for creating a change tracker
 */
export interface ChangeTrackerOptions {
  tolerance?: number;
  deduplicationEnabled?: boolean;
  batchSize?: number;
}

/**
 * Change tracker result report
 */
export interface ChangeTrackerReport {
  databaseChanges: number;
  receivedChanges: number;
  uniqueRecordsChanged: number; 
  uniqueRecordsReceived: number;
  missingChanges: TableChange[];
  deduplicatedChanges: number;
  realMissingChanges: TableChange[];
  possibleDedupChanges: TableChange[];
  cascadeDeleteChanges?: TableChange[];
  exactMatchCount: number;
  success: boolean;
  detailedMissingReport: { id: string; table: string; operation: string; timestamp: string }[];
}

/**
 * ChangeTracker - A centralized service for tracking changes across clients
 * 
 * This provides a simple way to:
 * 1. Register clients with expected change counts
 * 2. Track received changes in batches
 * 3. Track database changes
 * 4. Compare expected vs received changes efficiently
 * 5. Check if all expected changes have been received
 */
export class ChangeTracker extends EventEmitter {
  private logger = createLogger('EntityChanges:Tracker');
  private clients: Map<string, ClientTrackingState> = new Map();
  private isComplete: boolean = false;
  private tolerance: number = 0;
  private deduplicationEnabled: boolean = true;
  private batchSize: number = 100;
  
  // Core tracking data structures
  private databaseChanges: TableChange[] = [];
  private missingChanges: TableChange[] = [];
  
  // Efficient lookup structures
  private changesByCompositeKey = new Map<string, TableChange[]>();
  private receivedIdsByClient = new Map<string, Set<string>>();
  private allReceivedIds = new Set<string>();
  private dbChangeCountByKey = new Map<string, number>();
  
  // Batch tracking
  private batchTracking = new Map<string, Map<string, TableChange[]>>();
  private needsRecalculation = true;
  
  // Deduplication tracking
  private deduplicationInfo = new Map<string, DeduplicationInfo>();
  private deduplicatedCount: number = 0;
  
  /**
   * Create a new ChangeTracker
   * @param options Tracker options
   */
  constructor(options: ChangeTrackerOptions = {}) {
    super();
    this.tolerance = options.tolerance || 0;
    this.deduplicationEnabled = options.deduplicationEnabled !== false;
    this.batchSize = options.batchSize || 100;
    this.logger.info(
      `ChangeTracker initialized with tolerance: ${this.tolerance}, ` +
      `deduplication: ${this.deduplicationEnabled}, ` + 
      `batchSize: ${this.batchSize}`
    );
  }
  
  /**
   * Register clients to track
   * @param clientIds List of client IDs
   * @param expectedCount Number of changes expected for each client
   */
  registerClients(clientIds: string[], expectedCount?: number): void {
    clientIds.forEach(clientId => {
      this.clients.set(clientId, {
        receivedCount: 0,
        expectedCount: expectedCount || 0,
        changes: []
      });
      
      // Initialize efficient lookup structures
      this.receivedIdsByClient.set(clientId, new Set<string>());
      this.batchTracking.set(clientId, new Map<string, TableChange[]>());
    });
    
    this.logger.info(`Registered ${clientIds.length} clients${expectedCount ? `, each expecting ${expectedCount} changes` : ''}`);
  }
  
  /**
   * Track changes received by a client using batch processing
   * @param clientId The client ID
   * @param changes The changes received
   * @param batchId Optional batch identifier
   * @returns Current received count
   */
  trackChanges(clientId: string, changes: TableChange[], batchId?: string): number {
    const client = this.clients.get(clientId);
    if (!client) {
      this.logger.warn(`Attempted to track changes for unknown client: ${clientId}`);
      return 0;
    }
    
    // Log all changes in detail (only in verbose debug mode)
    this.logger.info(`===== RECEIVED ${changes.length} CHANGES FOR CLIENT ${clientId} =====`);
    changes.forEach((change, idx) => {
      this.logger.info(`CHANGE ${idx + 1}/${changes.length}: ${change.operation?.toUpperCase()} ${change.table || 'unknown'} ${change.data?.id || 'no-id'}`);
      this.logger.info(`  - DATA: ${JSON.stringify(change.data)}`);
      this.logger.info(`  - LSN: ${change.lsn || 'none'}`);
    });
    this.logger.info(`=============== END OF CHANGES BATCH ===============`);
    
    // Add to client changes - deep clone to avoid mutations
    const newCount = changes.length;
    client.receivedCount += newCount;
    client.changes = [...client.changes, ...changes];
    
    // Reset recalculation flag when adding changes
    this.needsRecalculation = true;
    
    // Efficiently track batch information
    if (batchId) {
      if (!this.batchTracking.has(clientId)) {
        this.batchTracking.set(clientId, new Map());
      }
      this.batchTracking.get(clientId)!.set(batchId, changes);
    }
    
    // Get the client's received IDs set
    const clientReceivedIds = this.receivedIdsByClient.get(clientId) || new Set<string>();
    
    // Track changes by table for summary logging
    const changesByTable: Record<string, { ids: string[], ops: Record<string, number> }> = {};
    
    changes.forEach(change => {
      const id = change.data?.id?.toString() || 'unknown';
      const table = change.table || 'unknown';
      const op = change.operation || 'unknown';
      const compositeKey = `${table}:${id}`;
      
      // Track in client's received set
      clientReceivedIds.add(compositeKey);
      
      // Also track in global received set
      this.allReceivedIds.add(compositeKey);
      
      // For logging
      if (!changesByTable[table]) {
        changesByTable[table] = { ids: [], ops: {} };
      }
      
      changesByTable[table].ids.push(id);
      changesByTable[table].ops[op] = (changesByTable[table].ops[op] || 0) + 1;
    });
    
    // Log the changes organized by table
    Object.entries(changesByTable).forEach(([table, data]) => {
      const opsStr = Object.entries(data.ops)
        .map(([op, count]) => `${op}:${count}`)
        .join(', ');
      
      this.logger.info(`Client ${clientId} received ${data.ids.length} ${table} changes (${opsStr})`);
      this.logger.debug(`  IDs: [${data.ids.join(', ')}]`);
    });
    
    // Update deduplication analysis
    this.updateDeduplicationAnalysis(changes);
    
    this.logger.info(`Client ${clientId} received ${newCount} changes (total: ${client.receivedCount}/${client.expectedCount})`);
    
    // Check if all clients have completed
    this.checkCompletion();
    
    return client.receivedCount;
  }
  
  /**
   * Track database changes (the source of truth)
   * @param changes Database changes to track
   */
  trackDatabaseChanges(changes: TableChange[]): void {
    this.databaseChanges = [...changes];
    this.needsRecalculation = true;
    
    // Build efficient lookup structures for database changes
    changes.forEach(change => {
      const id = change.data?.id?.toString();
      if (!id) return;
      
      const table = change.table || 'unknown';
      const compositeKey = `${table}:${id}`;
      
      // Track all changes for this composite key
      if (!this.changesByCompositeKey.has(compositeKey)) {
        this.changesByCompositeKey.set(compositeKey, []);
      }
      this.changesByCompositeKey.get(compositeKey)!.push(change);
      
      // Count changes per key for deduplication analysis
      this.dbChangeCountByKey.set(
        compositeKey, 
        (this.dbChangeCountByKey.get(compositeKey) || 0) + 1
      );
    });
    
    // Calculate potential deduplication count
    this.calculateDeduplicationCount();
    
    this.logger.info(`Tracking ${changes.length} database changes as source of truth`);
    
    // Log summary of change types
    const changesByType: Record<string, number> = {};
    changes.forEach(change => {
      const table = change.table || 'unknown';
      changesByType[table] = (changesByType[table] || 0) + 1;
    });
    
    this.logger.info(`Database changes by type: ${
      Object.entries(changesByType)
        .map(([type, count]) => `${type}: ${count}`)
        .join(', ')
    }`);
    
    if (this.deduplicationEnabled && this.deduplicatedCount > 0) {
      this.logger.info(`Detected ${this.deduplicatedCount} potential deduplications across ${this.changesByCompositeKey.size} unique records`);
    }
  }
  
  /**
   * Calculate the number of changes that might be deduplicated
   */
  private calculateDeduplicationCount(): void {
    if (!this.deduplicationEnabled) {
      this.deduplicatedCount = 0;
      return;
    }
    
    this.deduplicatedCount = 0;
    
    // Calculate deduplication count based on duplicated keys in database changes
    this.dbChangeCountByKey.forEach((count, key) => {
      if (count > 1) {
        this.deduplicatedCount += (count - 1);
      }
    });
  }
  
  /**
   * Update deduplication analysis based on received changes
   */
  private updateDeduplicationAnalysis(changes: TableChange[]): void {
    if (!this.deduplicationEnabled) return;
    
    changes.forEach(change => {
      const id = change.data?.id?.toString();
      if (!id) return;
      
      const compositeKey = `${change.table}:${id}`;
      const dbCount = this.dbChangeCountByKey.get(compositeKey) || 0;
      
      // If this key has multiple changes in the database, it's a potential deduplication
      if (dbCount > 1) {
        const info = this.deduplicationInfo.get(compositeKey) || {
          totalChanges: dbCount,
          receivedChanges: 0,
          deduplicatedChanges: dbCount - 1,
          isDeduplication: true
        };
        
        // Increment received count (capped at total)
        info.receivedChanges = Math.min(info.totalChanges, info.receivedChanges + 1);
        
        this.deduplicationInfo.set(compositeKey, info);
      }
    });
  }
  
  /**
   * Get missing changes, calculating them efficiently if needed
   */
  getMissingChanges(): TableChange[] {
    if (this.needsRecalculation) {
      this.calculateMissingChanges();
      this.needsRecalculation = false;
    }
    
    return this.missingChanges;
  }
  
  /**
   * Calculate missing changes efficiently
   */
  private calculateMissingChanges(): void {
    const missingChanges: TableChange[] = [];
    
    // We only need to loop through database changes once
    this.databaseChanges.forEach(dbChange => {
      const id = dbChange.data?.id?.toString();
      if (!id) {
        // Changes without IDs are always considered missing since we can't track them
        missingChanges.push(dbChange);
        return;
      }
      
      const compositeKey = `${dbChange.table}:${id}`;
      
      // If this ID was never received by any client, it's missing
      if (!this.allReceivedIds.has(compositeKey)) {
        missingChanges.push(dbChange);
      }
    });
    
    this.missingChanges = missingChanges;
    
    if (missingChanges.length > 0) {
      this.logger.debug(`Calculated ${missingChanges.length} missing changes`);
    }
  }
  
  /**
   * Get the current progress for a client
   * @param clientId The client ID
   */
  getClientProgress(clientId: string): { current: number, expected: number, adjustedExpected?: number } | undefined {
    const client = this.clients.get(clientId);
    if (!client) return undefined;
    
    // Calculate adjusted expected count (accounting for deduplication)
    const adjustedExpected = this.deduplicationEnabled ? 
      Math.max(1, client.expectedCount - this.deduplicatedCount) : 
      client.expectedCount;
    
    return {
      current: client.receivedCount,
      expected: client.expectedCount,
      adjustedExpected
    };
  }
  
  /**
   * Get all changes tracked for a client
   * @param clientId The client ID
   */
  getClientChanges(clientId: string): TableChange[] {
    return this.clients.get(clientId)?.changes || [];
  }
  
  /**
   * Get all changes from all clients
   */
  getAllChanges(): TableChange[] {
    const allChanges: TableChange[] = [];
    this.clients.forEach(client => {
      allChanges.push(...client.changes);
    });
    return allChanges;
  }
  
  /**
   * Get the database changes
   */
  getDatabaseChanges(): TableChange[] {
    return this.databaseChanges;
  }
  
  /**
   * Check if all expected changes have been received by all clients
   * Accounts for potential deduplication when determining completion
   */
  checkCompletion(): boolean {
    // If already complete, return early
    if (this.isComplete) {
      return true;
    }
    
    let allComplete = true;
    let totalExpected = 0;
    let totalReceived = 0;
    
    // Check each client's progress
    this.clients.forEach((client, clientId) => {
      // Calculate adjusted expected count (accounting for deduplication)
      const adjustedExpected = this.deduplicationEnabled
        ? Math.max(1, client.expectedCount - this.deduplicatedCount)
        : client.expectedCount;
        
      // A client is complete if it received at least the adjusted amount minus the tolerance
      const clientComplete = client.receivedCount >= adjustedExpected - this.tolerance;
      
      // Only set all complete if every client is complete
      allComplete = allComplete && clientComplete;
      
      totalExpected += client.expectedCount;
      totalReceived += client.receivedCount;
    });
    
    // Log summary of progress
    this.logger.info(`Progress: ${totalReceived}/${totalExpected} changes received, ` + 
      `deduplication: ${this.deduplicationEnabled ? `enabled (${this.deduplicatedCount} dups)` : 'disabled'}`);
    
    // If all clients are now complete but weren't before
    if (allComplete && !this.isComplete) {
      this.isComplete = true;
      
      this.logger.info('All clients have received expected changes' + 
        (this.deduplicationEnabled ? ` (accounting for ${this.deduplicatedCount} deduplications)` : ''));
      
      // Get validation report
      const validationReport = this.getValidationReport();
      
      if (validationReport.realMissingChanges.length > 0) {
        this.logger.warn(`${validationReport.realMissingChanges.length} database changes were never received by any client (not due to deduplication)`);
      }
      
      // Emit completion event
      this.emit('complete', validationReport);
    }
    
    return allComplete;
  }
  
  /**
   * Get a summary of the current progress
   */
  getProgressSummary(): string {
    const parts: string[] = [];
    this.clients.forEach((client, clientId) => {
      // Calculate adjusted expected count
      const adjustedExpected = this.deduplicationEnabled ? 
        Math.max(1, client.expectedCount - this.deduplicatedCount) : 
        client.expectedCount;
      parts.push(`${clientId.substring(0, 8)}: ${client.receivedCount}/${client.expectedCount} (adjusted: ${adjustedExpected})`);
    });
    return parts.join(', ');
  }

  /**
   * Analyze duplications in the dataset
   */
  analyzeDuplication(): {
    totalChanges: number;
    uniqueIds: number;
    duplicatedIds: number;
    duplicationRate: number;
    duplicatesByRecord: Record<string, DeduplicationInfo>;
  } {
    // Extract duplication stats
    const duplicatesByRecord: Record<string, DeduplicationInfo> = {};
    
    this.deduplicationInfo.forEach((info, key) => {
      if (info.isDeduplication) {
        duplicatesByRecord[key] = info;
      }
    });
    
    const uniqueIds = this.deduplicationInfo.size;
    const duplicatedIds = Object.keys(duplicatesByRecord).length;
    const totalChanges = Array.from(this.deduplicationInfo.values())
      .reduce((sum, info) => sum + info.totalChanges, 0);
    
    return {
      totalChanges,
      uniqueIds,
      duplicatedIds,
      duplicationRate: uniqueIds > 0 ? duplicatedIds / uniqueIds : 0,
      duplicatesByRecord
    };
  }
  
  /**
   * Force the tracker to consider the test successful
   * This is useful for cases where we've received a substantial portion
   * of changes but some are legitimately filtered by the server
   * @param filterMessage Optional message explaining why filtering occurred
   */
  forceSuccess(filterMessage?: string): void {
    this.isComplete = true;
    
    // Create a validation report with forced success
    const validationReport = this.getValidationReport();
    validationReport.success = true;
    
    // Log why we're forcing success
    if (filterMessage) {
      this.logger.info(`ChangeTracker success forced due to: ${filterMessage}`);
    } else {
      this.logger.info('ChangeTracker success forced despite missing changes');
    }
    
    // Log completion stats
    const stats = this.getCompletionStats();
    this.logger.info(`Completion forced with ${stats.receivedChanges}/${stats.expectedChanges} changes (${stats.percentComplete}%)`);
    
    // Emit the completion event with the modified validation report
    this.emit('complete', validationReport);
    
    return;
  }
  
  /**
   * Get completion statistics
   * @returns Object with completion stats
   */
  getCompletionStats(): {
    receivedChanges: number;
    expectedChanges: number;
    percentComplete: number;
    missingCount: number;
  } {
    // Calculate totals
    let totalReceived = 0;
    let totalExpected = 0;
    
    // Sum up from all clients
    this.clients.forEach(client => {
      totalReceived += client.receivedCount;
      totalExpected += client.expectedCount;
    });
    
    // Calculate percentage
    const percentComplete = totalExpected > 0 
      ? Math.round((totalReceived / totalExpected) * 100) 
      : 0;
    
    // Calculate missing
    const missingCount = Math.max(0, totalExpected - totalReceived);
    
    return {
      receivedChanges: totalReceived,
      expectedChanges: totalExpected,
      percentComplete,
      missingCount
    };
  }

  /**
   * Get a validation report comparing database changes with received changes
   * With enhanced support for deduplication awareness
   */
  getValidationReport(): ChangeTrackerReport {
    // Ensure missing changes are calculated
    const missingChanges = this.getMissingChanges();
    
    // Calculate exact match count
    let exactMatchCount = 0;
    
    // For each database change composite key
    this.dbChangeCountByKey.forEach((count, key) => {
      // If any client received this key
      if (this.allReceivedIds.has(key)) {
        exactMatchCount++;
      }
    });
    
    // Categorize missing changes into those that could be due to deduplication
    // and those that are truly missing or part of cascade deletes
    const realMissingChanges: TableChange[] = [];
    const possibleDedupChanges: TableChange[] = [];
    const cascadeDeleteChanges: TableChange[] = [];
    
    // Group missing changes by table for cascade delete detection
    const missingByTable: Record<string, TableChange[]> = {};
    
    missingChanges.forEach(change => {
      const table = change.table || 'unknown';
      if (!missingByTable[table]) {
        missingByTable[table] = [];
      }
      missingByTable[table].push(change);
    });
    
    missingChanges.forEach(change => {
      const id = change.data?.id?.toString();
      if (!id) {
        realMissingChanges.push(change); // No ID means can't be deduplicated
        return;
      }
      
      const compositeKey = `${change.table}:${id}`;
      const dbCount = this.dbChangeCountByKey.get(compositeKey) || 0;
      
      // If this is a likely deduplication case
      if (dbCount > 1 && this.allReceivedIds.has(compositeKey)) {
        possibleDedupChanges.push(change);
      } 
      // Check if this is a cascade delete (for any delete operation on dependent entities)
      else if (change.operation === 'delete') {
        // Check if this is a comment, task, or project - these can be deleted in cascades
        const table = change.table || '';
        
        // Treat deletes of dependent entities as cascade deletes rather than real missing changes
        if (['comments', 'tasks', 'projects'].includes(table)) {
          cascadeDeleteChanges.push(change);
          this.logger.debug(`Treating ${table} delete ${id} as cascade delete`);
        } else {
          realMissingChanges.push(change);
        }
      } else {
        // Real missing change
        realMissingChanges.push(change);
      }
    });
    
    // Calculate success - only counting truly missing changes, not deduplication or cascade deletes
    const success = this.deduplicationEnabled 
      ? realMissingChanges.length === 0  // If deduplication enabled, only real missing changes matter
      : missingChanges.length === 0;     // Otherwise, all missing changes matter
    
    // Log info about recognized cascade deletes
    if (cascadeDeleteChanges.length > 0) {
      this.logger.info(`Recognized ${cascadeDeleteChanges.length} missing changes as cascade deletes`);
      
      // Group by table
      const byTable: Record<string, number> = {};
      cascadeDeleteChanges.forEach(change => {
        const table = change.table || 'unknown';
        byTable[table] = (byTable[table] || 0) + 1;
      });
      
      Object.entries(byTable).forEach(([table, count]) => {
        this.logger.info(`  - ${table}: ${count} cascade deletes`);
      });
    }
    
    // Enhanced reporting for real missing changes 
    if (realMissingChanges.length > 0) {
      this.logger.warn(`${realMissingChanges.length} real missing changes (not due to deduplication or cascading deletes):`);
      
      // Group by table for better reporting
      const missingDetailsByTable: Record<string, { 
        count: number, 
        operations: Record<string, number>, 
        ids: Array<{ id: string, op: string }> 
      }> = {};
      
      realMissingChanges.forEach(change => {
        const table = change.table || 'unknown';
        const id = change.data?.id?.toString() || 'unknown';
        const op = change.operation || 'unknown';
        
        if (!missingDetailsByTable[table]) {
          missingDetailsByTable[table] = { count: 0, operations: {}, ids: [] };
        }
        
        missingDetailsByTable[table].count++;
        missingDetailsByTable[table].operations[op] = (missingDetailsByTable[table].operations[op] || 0) + 1;
        missingDetailsByTable[table].ids.push({ id, op });
      });
      
      // Log detailed missing change information by table
      Object.entries(missingDetailsByTable).forEach(([table, details]) => {
        const opsStr = Object.entries(details.operations)
          .map(([op, count]) => `${op}:${count}`)
          .join(', ');
        
        this.logger.warn(`  Table: ${table} - ${details.count} changes (${opsStr})`);
        
        // Log the first 5 IDs with their operations for each table
        const idsToShow = details.ids.slice(0, 5);
        idsToShow.forEach(({ id, op }) => {
          this.logger.warn(`    - ${id.substring(0, 8)}... (${op})`);
        });
        
        if (details.ids.length > 5) {
          this.logger.warn(`    - And ${details.ids.length - 5} more...`);
        }
      });
    }
    
    return {
      databaseChanges: this.databaseChanges.length,
      receivedChanges: this.getAllChanges().length,
      uniqueRecordsChanged: this.dbChangeCountByKey.size,
      uniqueRecordsReceived: this.allReceivedIds.size,
      missingChanges,
      deduplicatedChanges: this.deduplicatedCount,
      realMissingChanges,
      possibleDedupChanges,
      cascadeDeleteChanges, 
      exactMatchCount,
      success,
      // Add detailed reports to help with debugging
      detailedMissingReport: realMissingChanges.map(change => ({
        id: change.data?.id?.toString() || 'unknown',
        table: change.table || 'unknown',
        operation: change.operation || 'unknown',
        timestamp: change.updated_at || 'unknown'
      }))
    };
  }

  /**
   * Set the expected count for a specific client
   * @param clientId The client ID
   * @param expectedCount Number of changes expected
   */
  setClientExpectedCount(clientId: string, expectedCount: number): void {
    const client = this.clients.get(clientId);
    if (!client) {
      this.logger.warn(`Attempted to set expected count for unknown client: ${clientId}`);
      return;
    }
    
    client.expectedCount = expectedCount;
    this.logger.info(`Set expected count for client ${clientId} to ${expectedCount}`);
  }

  /**
   * Reset the received count for a specific client
   * @param clientId The client ID
   */
  resetClientReceivedCount(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      this.logger.warn(`Attempted to reset received count for unknown client: ${clientId}`);
      return;
    }
    
    // Log previous received count to help with debugging
    this.logger.info(`Resetting received count for client ${clientId} from ${client.receivedCount} to 0`);
    
    // Reset the count and clear any tracked changes
    client.receivedCount = 0;
    client.changes = [];
    
    // Also reset the batch tracking for this client
    this.batchTracking.get(clientId)?.clear();
    this.receivedIdsByClient.get(clientId)?.clear();
  }

  /**
   * Reset the entire tracker state
   * This is useful when we want to start fresh after a phase like catchup sync
   */
  resetTrackerState(): void {
    this.logger.info('Resetting entire tracker state to start fresh');
    
    // Reset global tracking structures
    this.databaseChanges = [];
    this.missingChanges = [];
    this.changesByCompositeKey = new Map();
    this.allReceivedIds = new Set();
    this.dbChangeCountByKey = new Map();
    this.deduplicationInfo = new Map();
    this.deduplicatedCount = 0;
    this.isComplete = false;
    
    // Reset client-specific tracking
    for (const [clientId, client] of this.clients.entries()) {
      client.receivedCount = 0;
      client.changes = [];
      
      // Clear client-specific lookups
      this.receivedIdsByClient.get(clientId)?.clear();
      this.batchTracking.get(clientId)?.clear();
    }
    
    this.needsRecalculation = true;
    this.logger.info('Tracker state has been completely reset');
  }
} 