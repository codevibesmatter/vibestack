/**
 * Client Change State Manager
 * 
 * Manages the state of client changes, including:
 * - Tracking batches of changes
 * - Managing client progress
 * - Handling batch completion
 */

import { createLogger } from '../logger.ts';
import { TableChange } from '@repo/sync-types';

const logger = createLogger('client-change-state');

/**
 * Batch tracking information
 */
interface Batch {
  number: number;
  startTime: number;
  changes: Record<string, TableChange[]>;
}

/**
 * Client progress information
 */
interface ClientProgress {
  received: number;
  expected: number;
  lastActivity: number;
}

/**
 * Manages client change state and batch tracking
 */
export class ClientChangeStateManager {
  private batches: Batch[] = [];
  private currentBatch: Batch = {
    number: 0,
    startTime: Date.now(),
    changes: {}
  };
  private clientProgress: Record<string, ClientProgress> = {};
  private inactivityTimeout: number;

  constructor(options: { inactivityTimeout?: number } = {}) {
    this.inactivityTimeout = options.inactivityTimeout || 15000;
  }

  /**
   * Records changes for a client
   */
  recordClientChanges(clientId: string, changes: TableChange[]): void {
    // Initialize client progress if needed
    if (!this.clientProgress[clientId]) {
      this.clientProgress[clientId] = {
        received: 0,
        expected: 0,
        lastActivity: Date.now()
      };
    }

    // Update client progress
    this.clientProgress[clientId].received += changes.length;
    this.clientProgress[clientId].lastActivity = Date.now();

    // Add changes to current batch
    if (!this.currentBatch.changes[clientId]) {
      this.currentBatch.changes[clientId] = [];
    }
    this.currentBatch.changes[clientId].push(...changes);

    logger.debug(`Recorded ${changes.length} changes for client ${clientId}`);
  }

  /**
   * Sets expected changes for a client
   */
  setExpectedChanges(clientId: string, expected: number): void {
    if (!this.clientProgress[clientId]) {
      this.clientProgress[clientId] = {
        received: 0,
        expected: 0,
        lastActivity: Date.now()
      };
    }
    this.clientProgress[clientId].expected = expected;
    logger.debug(`Set expected changes for client ${clientId} to ${expected}`);
  }

  /**
   * Gets progress for a client
   */
  getClientProgress(clientId: string): ClientProgress {
    return this.clientProgress[clientId] || {
      received: 0,
      expected: 0,
      lastActivity: 0
    };
  }

  /**
   * Finalizes the current batch and starts a new one
   */
  finalizeCurrentBatch(): void {
    if (Object.keys(this.currentBatch.changes).length > 0) {
      this.batches.push({...this.currentBatch});
      logger.info(`Finalized batch ${this.currentBatch.number} with changes for ${Object.keys(this.currentBatch.changes).length} clients`);
    }

    this.currentBatch = {
      number: this.currentBatch.number + 1,
      startTime: Date.now(),
      changes: {}
    };
  }

  /**
   * Gets all batches
   */
  getBatches(): Batch[] {
    return this.batches;
  }

  /**
   * Gets the current batch
   */
  getCurrentBatch(): Batch {
    return this.currentBatch;
  }

  /**
   * Checks if the current batch is complete based on inactivity
   */
  isBatchComplete(): boolean {
    const now = Date.now();
    return Object.values(this.clientProgress).every(progress => 
      now - progress.lastActivity > this.inactivityTimeout
    );
  }

  /**
   * Resets all state
   */
  reset(): void {
    this.batches = [];
    this.currentBatch = {
      number: 0,
      startTime: Date.now(),
      changes: {}
    };
    this.clientProgress = {};
    logger.info('Reset client change state');
  }
} 