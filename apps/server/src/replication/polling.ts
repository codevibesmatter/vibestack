import type { Client } from '@neondatabase/serverless';
import type { Env } from '../types/env';
import type { ReplicationConfig } from './types';
import { replicationLogger } from '../middleware/logger';
import { getDBClient, sql } from '../lib/db';
import type { MinimalContext } from '../types/hono';
import type { TableChange } from '@repo/sync-types';
import { processWALChanges, processAndConsumeWALChanges, processWALChangesWithoutConsume } from './process-changes';
import { StateManager } from './state-manager';
import type { DurableObjectState } from '../types/cloudflare';
import type { WALData } from '../types/wal';
import { compareLSN } from '../lib/sync-common';

const MODULE_NAME = 'polling';

// Use static defaults as fallbacks if config doesn't provide values
const DEFAULT_POLL_INTERVAL = 1000; // 1 second
const DEFAULT_BATCH_SIZE = 2000;    // Maximum changes to peek per cycle
const DEFAULT_CONSUME_SIZE = 2000;  // Maximum changes to consume per cycle

/**
 * Compare two LSNs
 * Returns true if first LSN is greater than second
 * Uses the common compareLSN function for consistency
 */
function compareLSNs(lsn1: string, lsn2: string): boolean {
  return compareLSN(lsn1, lsn2) > 0;
}

export class PollingManager {
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  public hasCompletedFirstPoll = false;
  private initialPollPromise: Promise<void> | null = null;
  private initialPollResolve: (() => void) | null = null;
  private isPolling = false; // Flag to prevent concurrent polling
  private pollCounter = 0; // Counter for heartbeat logging
  private readonly HEARTBEAT_INTERVAL = 60; // Log a heartbeat every 60 polls (approx 1 minute with default settings)

  constructor(
    private readonly state: DurableObjectState,
    private readonly config: ReplicationConfig,
    private readonly c: MinimalContext,
    private readonly env: Env,
    private readonly stateManager: StateManager
  ) {
    // Initialize first poll promise
    this.initialPollPromise = new Promise<void>((resolve) => {
      this.initialPollResolve = resolve;
    });
  }

  /**
   * Get the current poll counter value
   * Used for status reporting and monitoring
   */
  public getPollCount(): number {
    return this.pollCounter;
  }

  /**
   * Wait for the initial polling cycle to complete
   */
  public async waitForInitialPoll(): Promise<void> {
    return this.initialPollPromise as Promise<void>;
  }

  /**
   * Start polling for changes
   * Simply marks as initialized and starts sequential polling
   */
  public async startPolling(): Promise<void> {
    try {
      // Check if polling is already active
      if (this.pollingInterval) {
        // Log at debug level instead of info to reduce noise
        replicationLogger.debug('Polling already active, no action needed', {}, MODULE_NAME);
        return;
      }
      
      // Reset poll counter on start
      this.pollCounter = 0;
      
      // Mark polling as initialized - no initial poll
      replicationLogger.info('Starting polling process', {}, MODULE_NAME);
      
      // Mark initialized and resolve the initialization promise
      this.hasCompletedFirstPoll = true;
      if (this.initialPollResolve) {
        this.initialPollResolve();
      }

      // Start polling with setInterval for more reliability
      this.startContinuousPolling();
    } catch (err) {
      replicationLogger.error('Start polling error', {
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Start continuous polling using setInterval
   * This is more reliable for Durable Objects than setTimeout chains
   */
  private startContinuousPolling(): void {
    // Get poll interval from config or use default
    const pollInterval = this.config.pollingInterval || DEFAULT_POLL_INTERVAL;
    
    // Use setInterval for reliable, continuous polling
    this.pollingInterval = setInterval(async () => {
      // Skip if already polling to prevent concurrent operations
      if (this.isPolling) {
        return;
      }
      
      this.isPolling = true;
      
      try {
        // Increment poll counter
        this.pollCounter++;
        
        // Log heartbeat periodically to show the polling is still active
        if (this.pollCounter % this.HEARTBEAT_INTERVAL === 0) {
          const currentLSN = await this.stateManager.getLSN();
          replicationLogger.info('Polling heartbeat', {
            counter: this.pollCounter,
            intervalMs: pollInterval,
            currentLSN
          }, MODULE_NAME);
        }
        
        // Run the poll and process operation
        await this.pollAndProcess();
      } catch (error) {
        replicationLogger.error('Polling error', {
          error: error instanceof Error ? error.message : String(error)
        }, MODULE_NAME);
        
        // Note: We don't need to reschedule here since we're using setInterval
      } finally {
        // Mark polling as complete
        this.isPolling = false;
      }
    }, pollInterval);
    
    // Log only at debug level to reduce redundant logs
    replicationLogger.debug('Polling interval started', { intervalMs: pollInterval }, MODULE_NAME);
  }

  /**
   * Poll for changes and process them
   * This method ensures all changes are fully processed and acknowledged
   * before returning, to maintain a strict sequence of operations
   */
  private async pollAndProcess(): Promise<void> {
    try {
      // Poll for changes - this only peeks at changes without consuming them
      const changes = await this.pollForChanges();
      
      // Process changes if any were found
      if (changes && changes.length > 0) {
        try {
          // If we should skip WAL consumption, use the non-consuming version
          if (this.config.skipWALConsumption) {
            // Process changes without consuming WAL - more efficient
            await processWALChangesWithoutConsume(
              changes,
              this.env,
              this.c,
              this.stateManager,
              this.config.storeBatchSize
            );
            
            // Log that WAL changes were processed without consumption
            replicationLogger.info('WAL changes fully processed (without consumption)', {
              changeCount: changes.length
            }, MODULE_NAME);
          } else {
            // Use the traditional method with WAL consumption for backward compatibility
            // Pass the changes to the process-changes module and wait for FULL completion
            // This includes transformation, storage, LSN advancement, and WAL consumption
            await processAndConsumeWALChanges(
              changes,
              this.env,
              this.c,
              this.stateManager,
              this.config.slot,
              this.config.walConsumeSize,
              this.config.storeBatchSize
            );
            
            // Log only that WAL changes were processed
            replicationLogger.info('WAL changes fully processed', {
              changeCount: changes.length
            }, MODULE_NAME);
          }
          
        } catch (processError) {
          const errorMsg = processError instanceof Error ? processError.message : String(processError);
          
          // Check for replication slot errors in processing
          if (errorMsg.includes('replication slot') && errorMsg.includes('is active for PID')) {
            replicationLogger.warn('Replication slot in use during change processing, will retry next cycle', {
              error: errorMsg,
              slot: this.config.slot
            }, MODULE_NAME);
          } else {
            replicationLogger.error('Error processing WAL changes', {
              error: errorMsg
            }, MODULE_NAME);
          }
        }
      }
    } catch (err) {
      // Should only get here for non-slot errors since slot errors now return null
      const errorMsg = err instanceof Error ? err.message : String(err);
      replicationLogger.error('Poll cycle error', {
        error: errorMsg
      }, MODULE_NAME);
    }
  }

  /**
   * Stop active polling
   */
  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      
      // Reset counter when stopping
      this.pollCounter = 0;
      
      replicationLogger.info('Polling stopped', {}, MODULE_NAME);
    }
  }

  /**
   * Poll for new changes without advancing the LSN
   * This method ONLY retrieves changes - it doesn't make any decisions
   * about processing or filtering
   */
  private async pollForChanges(): Promise<WALData[] | null> {
    const client = getDBClient(this.c);
    
    try {
      // Get current LSN from state manager
      const currentLSN = await this.stateManager.getLSN();

      // Connect to the database
      await client.connect();
      
      // Use configured batch size or default
      const batchSize = this.config.walBatchSize || DEFAULT_BATCH_SIZE;
      
      // Use peek_changes which doesn't consume/advance the WAL
      const query = `
        SELECT data, lsn, xid 
        FROM pg_logical_slot_peek_changes(
          $1,
          NULL,
          NULL,
          'include-xids', '1',
          'include-timestamp', 'true'
        )
        WHERE lsn > $2::pg_lsn
        LIMIT ${batchSize};
      `;
      
      // Execute the query
      const result = await client.query(query, [this.config.slot, currentLSN]);
      
      // Map changes to our format
      const newChanges = result.rows.map(row => ({
        data: row.data as string,
        lsn: row.lsn as string,
        xid: row.xid as string
      }));

      // Only log the count of changes found at debug level, no details
      if (newChanges.length > 0) {
        replicationLogger.debug('WAL changes found', {
          count: newChanges.length
        }, MODULE_NAME);
      }
      
      return newChanges.length > 0 ? newChanges : null;
    } catch (err) {
      // Check for replication slot errors
      const errorMsg = err instanceof Error ? err.message : String(err);
      
      if (errorMsg.includes('replication slot') && errorMsg.includes('is active for PID')) {
        replicationLogger.warn('Replication slot in use by another process during poll', {
          error: errorMsg,
          slot: this.config.slot
        }, MODULE_NAME);
        
        // Don't throw for slot in use - just return null to continue polling
        return null;
      } else {
        replicationLogger.error('Polling error', {
          error: errorMsg
        }, MODULE_NAME);
        
        // Still throw for other errors
        throw err;
      }
    } finally {
      // Ensure connection is always closed
      try {
        await client.end();
      } catch (closeError) {
        replicationLogger.error('Error closing database connection after polling', {
          error: closeError instanceof Error ? closeError.message : String(closeError),
          slot: this.config.slot
        }, MODULE_NAME);
      }
    }
  }
} 