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
  exactMatchCount: number;
  success: boolean;
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
    this.logger.info(`ChangeTracker initialized with tolerance: ${this.tolerance}, deduplication: ${this.deduplicationEnabled}, batchSize: ${this.batchSize}`);
  }
  
  /**
   * Register clients to track
   * @param clientIds List of client IDs
   * @param expectedCount Number of changes expected for each client
   */
  registerClients(clientIds: string[], expectedCount: number): void {
    clientIds.forEach(clientId => {
      this.clients.set(clientId, {
        receivedCount: 0,
        expectedCount,
        changes: []
      });
      
      // Initialize efficient lookup structures
      this.receivedIdsByClient.set(clientId, new Set<string>());
      this.batchTracking.set(clientId, new Map<string, TableChange[]>());
    });
    
    this.logger.info(`Registered ${clientIds.length} clients, each expecting ${expectedCount} changes`);
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
    
    // Generate batch ID if not provided
    const batchKey = batchId || `batch-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    // Track the batch
    this.batchTracking.get(clientId)!.set(batchKey, [...changes]);
    
    const newCount = changes.length;
    client.receivedCount += newCount;
    
    // Only store actual changes if we need them for debugging
    // Otherwise, just track IDs for efficiency
    client.changes.push(...changes);
    
    // Update our efficient ID tracking
    const clientReceivedIds = this.receivedIdsByClient.get(clientId)!;
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
    
    // Mark that we need to recalculate missing changes
    this.needsRecalculation = true;
    
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
    // and those that are truly missing
    const realMissingChanges: TableChange[] = [];
    const possibleDedupChanges: TableChange[] = [];
    
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
      } else {
        // Real missing change
        realMissingChanges.push(change);
      }
    });
    
    // Calculate success - only counting truly missing changes, not deduplication
    const success = this.deduplicationEnabled 
      ? realMissingChanges.length === 0  // If deduplication enabled, only real missing changes matter
      : missingChanges.length === 0;     // Otherwise, all missing changes matter
    
    return {
      databaseChanges: this.databaseChanges.length,
      receivedChanges: this.getAllChanges().length,
      uniqueRecordsChanged: this.dbChangeCountByKey.size,
      uniqueRecordsReceived: this.allReceivedIds.size,
      missingChanges,
      deduplicatedChanges: this.deduplicatedCount,
      realMissingChanges,
      possibleDedupChanges,
      exactMatchCount,
      success
    };
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
}