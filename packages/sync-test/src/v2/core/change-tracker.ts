import { createLogger } from './logger.ts';
import { EntityType, Operation } from '../types.ts';
import { EventEmitter } from 'events';
import type { TableChange } from '@repo/sync-types';

/**
 * Simple tracking state for a client
 */
interface ClientTrackingState {
  receivedCount: number;
  expectedCount: number;
  changes: TableChange[];
}

/**
 * ChangeTracker - A centralized service for tracking changes across clients
 * 
 * This provides a simple way to:
 * 1. Register clients with expected change counts
 * 2. Track received changes
 * 3. Track database changes
 * 4. Compare expected vs received changes
 * 5. Check if all expected changes have been received
 */
export class ChangeTracker extends EventEmitter {
  private logger = createLogger('ChangeTracker');
  private clients: Map<string, ClientTrackingState> = new Map();
  private isComplete: boolean = false;
  private tolerance: number = 0;
  
  // Store database changes for comparison
  private databaseChanges: TableChange[] = [];
  private changesByIds: Map<string, TableChange[]> = new Map(); // Track multiple changes per ID
  private missingChanges: TableChange[] = [];
  
  // Tracking for deduplication analysis
  private duplicateIdsMap: Map<string, number> = new Map(); // Maps ID to count of changes
  private deduplicatedCount: number = 0;
  
  /**
   * Create a new ChangeTracker
   * @param tolerance How many fewer changes is acceptable (defaults to 0)
   */
  constructor(tolerance: number = 0) {
    super();
    this.tolerance = tolerance;
    this.logger.info(`ChangeTracker initialized with tolerance: ${tolerance}`);
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
    });
    
    this.logger.info(`Registered ${clientIds.length} clients, each expecting ${expectedCount} changes`);
  }
  
  /**
   * Track changes received by a client
   * @param clientId The client ID
   * @param changes The changes received
   * @returns Current received count
   */
  trackChanges(clientId: string, changes: TableChange[]): number {
    const client = this.clients.get(clientId);
    if (!client) {
      this.logger.warn(`Attempted to track changes for unknown client: ${clientId}`);
      return 0;
    }
    
    const newCount = changes.length;
    client.receivedCount += newCount;
    client.changes.push(...changes);
    
    // Log IDs for better debug tracking
    const changesByTable: Record<string, { ids: string[], ops: Record<string, number> }> = {};
    
    changes.forEach(change => {
      const id = change.data?.id?.toString() || 'unknown';
      const table = change.table || 'unknown';
      const op = change.operation || 'unknown';
      
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
      this.logger.info(`  IDs: [${data.ids.join(', ')}]`);
    });
    
    // Check changes against database changes for validation
    this.compareWithDatabaseChanges(changes);
    
    this.logger.info(`Client ${clientId} received ${newCount} changes (total: ${client.receivedCount}/${client.expectedCount})`);
    
    // Check if this client has completed
    const isClientComplete = client.receivedCount >= (client.expectedCount - this.tolerance);
    
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
    
    // Index changes by ID for quick lookups, detecting duplicates
    changes.forEach(change => {
      // Get ID from data object
      const id = change.data?.id?.toString();
      if (id) {
        // Get the composite key for this record (table+id)
        const compositeKey = `${change.table}:${id}`;
        
        // Track duplicates for deduplication analysis
        this.duplicateIdsMap.set(compositeKey, (this.duplicateIdsMap.get(compositeKey) || 0) + 1);
        
        // Track all changes for this ID
        if (!this.changesByIds.has(compositeKey)) {
          this.changesByIds.set(compositeKey, []);
        }
        this.changesByIds.get(compositeKey)!.push(change);
      }
    });
    
    // Calculate expected deduplication count
    // Any ID with more than 1 change represents a potential deduplication
    this.deduplicatedCount = 0;
    this.duplicateIdsMap.forEach((count, id) => {
      if (count > 1) {
        this.deduplicatedCount += count - 1;
      }
    });
    
    this.logger.info(`Tracking ${changes.length} database changes as source of truth`);
    this.logger.info(`Detected ${this.deduplicatedCount} potential deduplications across ${this.duplicateIdsMap.size} unique records`);
    
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
  }
  
  /**
   * Compare received changes with database changes
   * @param changes Changes received from clients
   */
  private compareWithDatabaseChanges(changes: TableChange[]): void {
    if (this.databaseChanges.length === 0) {
      // No database changes tracked yet
      return;
    }
    
    this.logger.debug(`Comparing ${changes.length} received changes with ${this.databaseChanges.length} database changes`);
    
    // Check if change IDs match expected changes
    changes.forEach(receivedChange => {
      const receivedId = receivedChange.data?.id?.toString();
      if (!receivedId) {
        this.logger.debug(`Received change has no ID: ${JSON.stringify(receivedChange)}`);
        return;
      }
      
      // Use composite key for lookups
      const compositeKey = `${receivedChange.table}:${receivedId}`;
      const databaseChanges = this.changesByIds.get(compositeKey);
      
      if (databaseChanges && databaseChanges.length > 0) {
        // Found a match - we don't need to track exactly which version was received
        // since the server might have deduplicated changes
        this.logger.debug(`✓ Received change ${receivedId} (${receivedChange.table}, ${receivedChange.operation}) matches a database change`);
      } else {
        this.logger.debug(`✗ Received change ${receivedId} (${receivedChange.table}, ${receivedChange.operation}) NOT found in database changes`);
        
        // Debug: List some composite keys for comparison
        if (this.changesByIds.size < 20) { // Only if there aren't too many
          const dbKeys = Array.from(this.changesByIds.keys()).slice(0, 10);
          this.logger.debug(`Available database change keys (10 samples): ${dbKeys.join(', ')}`);
        }
      }
    });
    
    // Recalculate missing changes
    this.recalculateMissingChanges();
  }
  
  /**
   * Recalculate missing changes by comparing all received changes with database changes
   */
  private recalculateMissingChanges(): void {
    // Start with all database changes
    this.missingChanges = [...this.databaseChanges];
    
    // Get all unique composite keys (table:id) from all clients
    const allReceivedKeys: Set<string> = new Set();
    this.clients.forEach(client => {
      client.changes.forEach(change => {
        const id = change.data?.id?.toString();
        if (id) {
          allReceivedKeys.add(`${change.table}:${id}`);
        }
      });
    });
    
    // Filter out the changes that have been received by any client
    // We only keep the change if NO client has received ANY change for this record
    this.missingChanges = this.missingChanges.filter(change => {
      const id = change.data?.id?.toString();
      if (!id) return true; // Keep changes without ID
      
      const compositeKey = `${change.table}:${id}`;
      return !allReceivedKeys.has(compositeKey);
    });
    
    if (this.missingChanges.length > 0) {
      this.logger.debug(`Missing ${this.missingChanges.length} changes from clients`);
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
    const adjustedExpected = Math.max(1, client.expectedCount - this.deduplicatedCount);
    
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
   * Get missing changes (changes in database but not received by any client)
   */
  getMissingChanges(): TableChange[] {
    return this.missingChanges;
  }
  
  /**
   * Check if all expected changes have been received by all clients
   * Accounts for potential deduplication when determining completion
   */
  checkCompletion(): boolean {
    // Skip if already complete
    if (this.isComplete) return true;
    
    // If no clients registered, we're not complete
    if (this.clients.size === 0) return false;
    
    // Check if all clients have received their expected changes
    // accounting for both tolerance and potential deduplication
    let allComplete = true;
    this.clients.forEach((client, clientId) => {
      // Calculate adjusted expected count
      const adjustedExpected = Math.max(1, client.expectedCount - this.deduplicatedCount);
      
      // A client is complete if they've reached the adjusted expected count (with tolerance)
      const clientComplete = client.receivedCount >= (adjustedExpected - this.tolerance);
      
      if (!clientComplete) {
        allComplete = false;
        this.logger.debug(`Client ${clientId} not yet complete: ${client.receivedCount}/${adjustedExpected} (adjusted for deduplication)`);
      }
    });
    
    // If all complete and wasn't complete before, emit an event
    if (allComplete && !this.isComplete) {
      this.isComplete = true;
      
      // Recalculate missing changes and include in the event
      this.recalculateMissingChanges();
      
      // Perform final validation accounting for deduplication
      const validationReport = this.getValidationReport();
      
      this.emit('complete', {
        progress: this.getProgressSummary(),
        missingCount: this.missingChanges.length,
        deduplicatedCount: this.deduplicatedCount,
        validationReport,
        isComplete: true
      });
      
      this.logger.info(`All clients have received expected changes (accounting for ${this.deduplicatedCount} deduplications)`);
      
      if (validationReport.realMissingChanges.length > 0) {
        this.logger.warn(`${validationReport.realMissingChanges.length} database changes were never received by any client (not due to deduplication)`);
      }
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
      const adjustedExpected = Math.max(1, client.expectedCount - this.deduplicatedCount);
      parts.push(`${clientId.substring(0, 8)}: ${client.receivedCount}/${client.expectedCount} (adjusted: ${adjustedExpected})`);
    });
    return parts.join(', ');
  }
  
  /**
   * Get a validation report comparing database changes with received changes
   * With enhanced support for deduplication awareness
   */
  getValidationReport(): {
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
  } {
    // First, calculate unique records in database changes and received changes
    const dbUniqueRecords = new Set<string>();
    const receivedUniqueRecords = new Set<string>();
    
    // Collect all database change composite keys
    this.databaseChanges.forEach(dbChange => {
      const dbId = dbChange.data?.id?.toString();
      if (dbId) {
        dbUniqueRecords.add(`${dbChange.table}:${dbId}`);
      }
    });
    
    // Collect all received change composite keys
    this.clients.forEach(client => {
      client.changes.forEach(change => {
        const id = change.data?.id?.toString();
        if (id) {
          receivedUniqueRecords.add(`${change.table}:${id}`);
        }
      });
    });
    
    // Count exact matches between database records and received records
    let exactMatchCount = 0;
    dbUniqueRecords.forEach(dbKey => {
      if (receivedUniqueRecords.has(dbKey)) {
        exactMatchCount++;
      }
    });
    
    // Categorize missing changes into those that could be due to deduplication
    // and those that are truly missing
    const realMissingChanges: TableChange[] = [];
    const possibleDedupChanges: TableChange[] = [];
    
    // Group missing changes by ID
    const missingByKey = new Map<string, TableChange[]>();
    this.missingChanges.forEach(change => {
      const id = change.data?.id?.toString();
      if (!id) {
        realMissingChanges.push(change); // No ID means can't be deduplicated
        return;
      }
      
      const compositeKey = `${change.table}:${id}`;
      if (!missingByKey.has(compositeKey)) {
        missingByKey.set(compositeKey, []);
      }
      missingByKey.get(compositeKey)!.push(change);
    });
    
    // For each group of missing changes:
    // - If we have multiple changes for the same ID and some were received, 
    //   it's likely deduplication
    // - If ALL changes for an ID are missing, it's a real missing change
    missingByKey.forEach((changes, key) => {
      if (receivedUniqueRecords.has(key)) {
        // Some change for this ID was received, so these are likely deduplicated
        possibleDedupChanges.push(...changes);
      } else {
        // No change for this ID was received at all
        realMissingChanges.push(...changes);
      }
    });
    
    // Calculate success - only counting truly missing changes, not deduplication
    const success = realMissingChanges.length === 0;
    
    return {
      databaseChanges: this.databaseChanges.length,
      receivedChanges: this.getAllChanges().length,
      uniqueRecordsChanged: dbUniqueRecords.size,
      uniqueRecordsReceived: receivedUniqueRecords.size,
      missingChanges: this.missingChanges,
      deduplicatedChanges: this.deduplicatedCount,
      realMissingChanges,
      possibleDedupChanges,
      exactMatchCount,
      success
    };
  }
} 