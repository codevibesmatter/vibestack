import type { Client } from '@neondatabase/serverless';
import type { Env } from '../types/env';
import type { ReplicationConfig } from './types';
import { replicationLogger } from '../middleware/logger';
import { getDBClient, sql } from '../lib/db';
import type { MinimalContext } from '../types/hono';
import type { TableChange } from '@repo/sync-types';
import { processWALChanges, processAndConsumeWALChanges } from './process-changes';
import { StateManager } from './state-manager';
import type { DurableObjectState } from '../types/cloudflare';
import type { WALData } from '../types/wal';
import { compareLSN } from '../lib/sync-common';

const MODULE_NAME = 'polling';

// Polling intervals
export const ACTIVE_POLL_INTERVAL = 1000; // 1 second

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
      // Mark polling as initialized - no initial poll
      replicationLogger.info('Starting polling process', {}, MODULE_NAME);
      
      // Mark initialized and resolve the initialization promise
      this.hasCompletedFirstPoll = true;
      if (this.initialPollResolve) {
        this.initialPollResolve();
      }

      // Start sequential polling immediately
      if (!this.pollingInterval) {
        // Start the polling cycle
        this.startSequentialPolling();
      }
    } catch (err) {
      replicationLogger.error('Start polling error', {
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Start sequential polling that ensures only one poll cycle runs at a time
   */
  private startSequentialPolling(): void {
    // Store timeout ID
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    
    // Define the polling function
    const poll = async () => {
      try {
        // Run the poll and process operation
        await this.pollAndProcess();
      } catch (error) {
        replicationLogger.error('Sequential polling error', {
          error: error instanceof Error ? error.message : String(error)
        }, MODULE_NAME);
      } finally {
        // Schedule the next poll after this one completes
        // Add a small delay to ensure we don't hammer the database
        timeoutId = setTimeout(poll, ACTIVE_POLL_INTERVAL);
      }
    };
    
    // Start the first poll with a small delay
    timeoutId = setTimeout(poll, 500); // Start with a small delay to allow initialization to complete
    
    // Store the timeout in pollingInterval for cleanup
    this.pollingInterval = {
      unref: () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      }
    } as any; // Cast to any to satisfy the type
  }

  /**
   * Poll for changes and process them
   */
  private async pollAndProcess(): Promise<void> {
    try {
      // Poll for changes - this only peeks at changes without consuming them
      const changes = await this.pollForChanges();
      
      // Process changes if any were found
      if (changes && changes.length > 0) {
        try {
          // Let the changes module handle processing, storage, and LSN advancement
          const { success, storedChanges, consumedChanges, changeCount } = await processAndConsumeWALChanges(
            changes,
            this.env,
            this.c,
            this.stateManager,
            this.config.slot
          );
          
          replicationLogger.info('Completed WAL change processing cycle', {
            success,
            storedChanges,
            consumedChanges,
            changeCount: changeCount ?? changes.length
          }, MODULE_NAME);
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
      if (typeof this.pollingInterval === 'object' && 'unref' in this.pollingInterval) {
        (this.pollingInterval as any).unref();
      } else {
        clearInterval(this.pollingInterval);
      }
      this.pollingInterval = null;
    }
  }

  /**
   * Poll for new changes without advancing the LSN
   */
  private async pollForChanges(): Promise<WALData[] | null> {
    const client = getDBClient(this.c);
    
    try {
      // Get current LSN from state manager
      const currentLSN = await this.stateManager.getLSN();

      // Connect to the database
      await client.connect();
      
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
        LIMIT 500;
      `;
      
      // Execute the query
      const result = await client.query(query, [this.config.slot, currentLSN]);
      
      // Map changes to our format
      const newChanges = result.rows.map(row => ({
        data: row.data as string,
        lsn: row.lsn as string,
        xid: row.xid as string
      }));

      // Log if we found changes, but don't advance LSN - that's now handled in changes module
      if (newChanges.length > 0) {
        replicationLogger.info('WAL changes found', {
          count: newChanges.length,
          currentLSN,
          lastLSN: newChanges[newChanges.length - 1].lsn
        }, MODULE_NAME);
        
        return newChanges;
      }
      
      return null;
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