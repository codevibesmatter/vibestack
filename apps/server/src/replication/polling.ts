import type { Client } from '@neondatabase/serverless';
import type { Env } from '../types/env';
import type { ReplicationConfig } from './types';
import { replicationLogger } from '../middleware/logger';
import { getDBClient, sql } from '../lib/db';
import type { MinimalContext } from '../types/hono';
import type { TableChange } from '@repo/sync-types';
import { processWALChanges, processAndConsumeWALChanges } from './process-changes';
import { ClientManager } from './client-manager';
import { StateManager } from './state-manager';
import type { DurableObjectState } from '../types/cloudflare';
import type { WALData } from '../types/wal';

const MODULE_NAME = 'polling';

// Polling intervals
export const ACTIVE_POLL_INTERVAL = 1000; // 1 second

/**
 * Compare two LSNs
 * Returns true if first LSN is greater than second
 */
function compareLSNs(lsn1: string, lsn2: string): boolean {
  // Split into x/y components and parse as hex
  const [x1, y1] = lsn1.split('/').map(n => parseInt(n, 16));
  const [x2, y2] = lsn2.split('/').map(n => parseInt(n, 16));
  
  // Compare x first, then y if x is equal
  if (x1 !== x2) {
    return x1 > x2;
  }
  return y1 > y2;
}

export class PollingManager {
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  public hasCompletedFirstPoll = false;
  private initialPollPromise: Promise<void> | null = null;
  private initialPollResolve: (() => void) | null = null;

  constructor(
    private readonly clientManager: ClientManager,
    private readonly stateManager: StateManager,
    private readonly config: ReplicationConfig,
    private readonly c: MinimalContext,
    private readonly state: DurableObjectState
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
   */
  public async startPolling(): Promise<void> {
    try {
      // Do initial poll to catch up on changes
      const changes = await this.pollForChanges();
      
      // Process any changes found during initial poll
      if (changes && changes.length > 0) {
        replicationLogger.info('Processing changes from initial poll', {
          count: changes.length
        }, MODULE_NAME);
        
        // Process and consume WAL changes before marking initial poll as complete
        const { success, storedChanges, consumedChanges } = await processAndConsumeWALChanges(
          changes,
          this.clientManager,
          this.c,
          this.stateManager,
          this.config.slot
        );
        
        replicationLogger.info('Initial poll change processing completed', {
          success,
          storedChanges,
          consumedChanges,
          changeCount: changes.length
        }, MODULE_NAME);
        
        if (!success) {
          replicationLogger.warn('Initial poll processing had issues, but continuing', {
            storedChanges,
            consumedChanges
          }, MODULE_NAME);
        }
      } else {
        replicationLogger.info('No changes found in initial poll', {}, MODULE_NAME);
      }
      
      // Mark first poll complete and resolve promise
      this.hasCompletedFirstPoll = true;
      if (this.initialPollResolve) {
        this.initialPollResolve();
      }

      // Start continuous polling regardless of client state
      if (!this.pollingInterval) {
        replicationLogger.debug('Starting continuous polling', {
          pollInterval: ACTIVE_POLL_INTERVAL
        }, MODULE_NAME);
        
        // Start polling interval - simplified to only poll for changes without client checks
        this.pollingInterval = setInterval(() => this.pollAndProcess(), ACTIVE_POLL_INTERVAL);
      }
    } catch (err) {
      replicationLogger.error('Start polling error', {
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
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
        // Let the changes module handle processing, storage, and LSN advancement
        const { success, storedChanges, consumedChanges } = await processAndConsumeWALChanges(
          changes,
          this.clientManager,
          this.c,
          this.stateManager,
          this.config.slot
        );
        
        replicationLogger.info('Completed WAL change processing cycle', {
          success,
          storedChanges,
          consumedChanges,
          changeCount: changes.length
        }, MODULE_NAME);
      }
    } catch (err) {
      replicationLogger.error('Poll cycle error', {
        error: err instanceof Error ? err.message : String(err)
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
      replicationLogger.debug('Polling stopped', {}, MODULE_NAME);
    }
  }

  /**
   * Poll for new changes without advancing the LSN
   */
  private async pollForChanges(): Promise<WALData[] | null> {
    try {
      // Get current LSN from state manager
      const currentLSN = await this.stateManager.getLSN();

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
        LIMIT 100;
      `;
      
      // Use sql helper which manages connections automatically
      const rows = await sql(this.c, query, [this.config.slot, currentLSN]);
      
      // Map changes to our format
      const newChanges = rows.map(row => ({
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
      } else if (!this.hasCompletedFirstPoll) {
        // Only log no changes during initial poll
        replicationLogger.debug('No changes in initial poll', {
          currentLSN
        }, MODULE_NAME);
      }
      
      return null;
    } catch (err) {
      replicationLogger.error('Polling error', {
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
  }
} 