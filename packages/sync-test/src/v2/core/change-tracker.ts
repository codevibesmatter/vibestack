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
  private changesByIds: Map<string, TableChange> = new Map();
  private missingChanges: TableChange[] = [];
  
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
    
    // Index changes by ID for quick lookups
    changes.forEach(change => {
      // Get ID from data object
      const id = change.data?.id?.toString();
      if (id) {
        this.changesByIds.set(id, change);
      }
    });
    
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
      
      const databaseChange = this.changesByIds.get(receivedId);
      if (databaseChange) {
        // Found a match - remove from missing changes if it was there
        const missingIndex = this.missingChanges.findIndex(c => c.data?.id === receivedId);
        if (missingIndex >= 0) {
          this.missingChanges.splice(missingIndex, 1);
        }
        this.logger.debug(`✓ Received change ${receivedId} (${receivedChange.table}, ${receivedChange.operation}) matches a database change`);
      } else {
        this.logger.debug(`✗ Received change ${receivedId} (${receivedChange.table}, ${receivedChange.operation}) NOT found in database changes`);
        
        // Debug: List all db change IDs for comparison
        if (this.databaseChanges.length < 20) { // Only if there aren't too many
          const dbIds = Array.from(this.changesByIds.keys());
          this.logger.debug(`Available database change IDs: ${dbIds.join(', ')}`);
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
    
    // Get all changes from all clients
    const allReceivedChangeIds: Set<string> = new Set();
    this.clients.forEach(client => {
      client.changes.forEach(change => {
        const id = change.data?.id?.toString();
        if (id) {
          allReceivedChangeIds.add(id);
        }
      });
    });
    
    // Filter out the changes that have been received
    this.missingChanges = this.missingChanges.filter(change => {
      const id = change.data?.id?.toString();
      return id && !allReceivedChangeIds.has(id);
    });
    
    if (this.missingChanges.length > 0) {
      this.logger.debug(`Missing ${this.missingChanges.length} changes from clients`);
    }
  }
  
  /**
   * Get the current progress for a client
   * @param clientId The client ID
   */
  getClientProgress(clientId: string): { current: number, expected: number } | undefined {
    const client = this.clients.get(clientId);
    if (!client) return undefined;
    
    return {
      current: client.receivedCount,
      expected: client.expectedCount
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
   */
  checkCompletion(): boolean {
    // Skip if already complete
    if (this.isComplete) return true;
    
    // If no clients registered, we're not complete
    if (this.clients.size === 0) return false;
    
    // Check if all clients have received their expected changes (with tolerance)
    let allComplete = true;
    this.clients.forEach((client, clientId) => {
      const clientComplete = client.receivedCount >= (client.expectedCount - this.tolerance);
      if (!clientComplete) {
        allComplete = false;
      }
    });
    
    // If all complete and wasn't complete before, emit an event
    if (allComplete && !this.isComplete) {
      this.isComplete = true;
      
      // Recalculate missing changes and include in the event
      this.recalculateMissingChanges();
      
      this.emit('complete', {
        progress: this.getProgressSummary(),
        missingCount: this.missingChanges.length,
        isComplete: true
      });
      
      this.logger.info(`All clients have received all expected changes!`);
      if (this.missingChanges.length > 0) {
        this.logger.warn(`But ${this.missingChanges.length} database changes were not received by any client.`);
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
      parts.push(`${clientId.substring(0, 8)}: ${client.receivedCount}/${client.expectedCount}`);
    });
    return parts.join(', ');
  }
  
  /**
   * Get a validation report comparing database changes with received changes
   */
  getValidationReport(): {
    databaseChanges: number;
    receivedChanges: number;
    missingChanges: TableChange[];
    exactMatchCount: number;
    success: boolean;
  } {
    // Count exact matches between database changes and received changes
    let exactMatchCount = 0;
    const receivedIds = new Set<string>();
    
    // Collect all received change IDs
    this.clients.forEach(client => {
      client.changes.forEach(change => {
        const id = change.data?.id?.toString();
        if (id) {
          receivedIds.add(id);
        }
      });
    });
    
    // Count how many database changes have matching received changes
    this.databaseChanges.forEach(dbChange => {
      const dbId = dbChange.data?.id?.toString();
      if (dbId && receivedIds.has(dbId)) {
        exactMatchCount++;
      }
    });
    
    // Calculate success
    const success = exactMatchCount === this.databaseChanges.length;
    
    // If not successful but we have the right number of changes, log more details
    if (!success && this.getAllChanges().length >= this.databaseChanges.length) {
      this.logger.warn(`Validation failed despite receiving ${this.getAllChanges().length} changes (expected ${this.databaseChanges.length}). Only ${exactMatchCount} exact ID matches.`);
      
      // Log sample IDs for comparison
      const dbIds = this.databaseChanges.slice(0, 3).map(c => c.data?.id?.toString()).filter(Boolean);
      const clientIds = Array.from(receivedIds).slice(0, 3);
      this.logger.warn(`Sample DB IDs: ${dbIds.join(', ')}`);
      this.logger.warn(`Sample client IDs: ${clientIds.join(', ')}`);
    }
    
    return {
      databaseChanges: this.databaseChanges.length,
      receivedChanges: this.getAllChanges().length,
      missingChanges: this.missingChanges,
      exactMatchCount,
      success
    };
  }
} 