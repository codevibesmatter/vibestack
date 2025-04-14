import { createLogger } from '../logger.ts';
import { TableChangeTest } from './types.ts';

/**
 * Interface for tracking seen updates
 */
interface SeenUpdate {
  clientId: string;
  taskId: string;
  batchNumber: number;
  change: TableChangeTest;
}

/**
 * Tracks client-side changes and their state
 */
export class ClientChangeTracker {
  private logger = createLogger('client-change-tracker');
  private clientChanges: Map<string, TableChangeTest[]> = new Map();
  private conflictUpdates: Map<string, TableChangeTest[]> = new Map();
  private seenUpdates: Map<string, SeenUpdate> = new Map();
  private changesByBatch: Map<string, TableChangeTest[]> = new Map();
  private idsToExclude: Set<string> = new Set();

  /**
   * Records changes submitted by a client
   */
  recordClientChanges(clientId: string, changes: TableChangeTest[]): void {
    this.logger.debug(`Recording ${changes.length} changes for client ${clientId}`);
    const existingChanges = this.clientChanges.get(clientId) || [];
    this.clientChanges.set(clientId, [...existingChanges, ...changes]);
    
    // Track changes by batch
    for (const change of changes) {
      if (change.batchId) {
        if (!this.changesByBatch.has(change.batchId)) {
          this.changesByBatch.set(change.batchId, []);
        }
        this.changesByBatch.get(change.batchId)!.push(change);
      }
    }
  }

  /**
   * Records conflict updates for a client
   */
  recordConflictUpdates(clientId: string, changes: TableChangeTest[]): void {
    this.logger.debug(`Recording ${changes.length} conflict updates for client ${clientId}`);
    const existingUpdates = this.conflictUpdates.get(clientId) || [];
    this.conflictUpdates.set(clientId, [...existingUpdates, ...changes]);
  }

  /**
   * Records a seen update for a specific task
   */
  recordSeenUpdate(clientId: string, taskId: string, batchNumber: number, change: TableChangeTest): void {
    this.logger.debug(`Recording seen update for client ${clientId}, task ${taskId}, batch ${batchNumber}`);
    const key = `${clientId}-${taskId}`;
    this.seenUpdates.set(key, { clientId, taskId, batchNumber, change });
  }

  /**
   * Gets all changes for a specific client
   */
  getClientChanges(clientId: string): TableChangeTest[] {
    return this.clientChanges.get(clientId) || [];
  }

  /**
   * Gets conflict updates for a specific client
   */
  getConflictUpdates(clientId: string): TableChangeTest[] {
    return this.conflictUpdates.get(clientId) || [];
  }

  /**
   * Gets all seen updates
   */
  getSeenUpdates(): Map<string, SeenUpdate> {
    return this.seenUpdates;
  }

  /**
   * Gets IDs to exclude from tracking
   */
  getIdsToExclude(): Set<string> {
    return this.idsToExclude;
  }

  /**
   * Clears all tracked data
   */
  clear(): void {
    this.logger.debug('Clearing all tracked changes');
    this.clientChanges.clear();
    this.conflictUpdates.clear();
    this.seenUpdates.clear();
    this.changesByBatch.clear();
    this.idsToExclude.clear();
  }

  recordAppliedChanges(changes: TableChangeTest[]): void {
    this.logger.debug(`Recording ${changes.length} applied changes`);
    changes.forEach(change => {
      if (change.table === 'tasks' && change.operation === 'update') {
        this.idsToExclude.add(change.data.id);
      }
    });
  }

  /**
   * Gets all changes for a specific batch
   */
  getChangesByBatch(batchId: string): TableChangeTest[] {
    return this.changesByBatch.get(batchId) || [];
  }
}

/**
 * Interface for batch information
 */
interface Batch {
  number: number;
  startTime: number;
  changes: Map<string, TableChangeTest[]>;
}

/**
 * Interface for client progress
 */
interface ClientProgress {
  received: number;
  expected: number;
}

/**
 * Manages client-side change state and batching
 */
export class ClientChangeStateManager {
  private batches: Batch[] = [];
  private currentBatch: Batch = {
    number: 0,
    startTime: Date.now(),
    changes: new Map<string, TableChangeTest[]>()
  };
  private clientProgress: Map<string, ClientProgress> = new Map();

  /**
   * Records a batch of changes for a client
   */
  recordBatch(clientId: string, changes: TableChangeTest[]): void {
    if (!this.currentBatch.changes.has(clientId)) {
      this.currentBatch.changes.set(clientId, []);
    }
    this.currentBatch.changes.get(clientId)!.push(...changes);
  }

  /**
   * Finalizes the current batch and starts a new one
   */
  finalizeCurrentBatch(): void {
    if (this.currentBatch.changes.size > 0) {
      this.batches.push(this.currentBatch);
      this.currentBatch = {
        number: this.currentBatch.number + 1,
        startTime: Date.now(),
        changes: new Map()
      };
    }
  }

  /**
   * Gets statistics about batches
   */
  getBatchStatistics(): {
    totalBatches: number;
    currentBatch: number;
    totalChanges: number;
  } {
    return {
      totalBatches: this.batches.length,
      currentBatch: this.currentBatch.number,
      totalChanges: this.batches.reduce((sum, batch) => 
        sum + Array.from(batch.changes.values()).reduce((batchSum, changes) => batchSum + changes.length, 0), 0)
    };
  }

  /**
   * Gets progress information for a client
   */
  getClientProgress(clientId: string): ClientProgress & { percentage: number } {
    const progress = this.clientProgress.get(clientId) || { received: 0, expected: 0 };
    return {
      ...progress,
      percentage: progress.expected > 0 ? (progress.received / progress.expected) * 100 : 0
    };
  }

  /**
   * Sets the expected number of changes for a client
   */
  setClientExpectedChanges(clientId: string, expected: number): void {
    this.clientProgress.set(clientId, { received: 0, expected });
  }

  /**
   * Increments the number of received changes for a client
   */
  incrementClientReceivedChanges(clientId: string, count: number): void {
    const progress = this.clientProgress.get(clientId) || { received: 0, expected: 0 };
    this.clientProgress.set(clientId, { ...progress, received: progress.received + count });
  }

  /**
   * Gets all batches
   */
  getBatches(): Batch[] {
    return this.batches;
  }

  /**
   * Clears all tracked data
   */
  clear(): void {
    this.batches = [];
    this.currentBatch = {
      number: 0,
      startTime: Date.now(),
      changes: new Map()
    };
    this.clientProgress.clear();
  }
} 