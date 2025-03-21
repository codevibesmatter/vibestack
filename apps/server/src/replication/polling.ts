import type { Client } from '@neondatabase/serverless';
import type { Env } from '../types/env';
import type { ReplicationConfig } from './types';
import { replicationLogger } from '../middleware/logger';
import { getDBClient } from '../lib/db';
import type { MinimalContext } from '../types/hono';
import type { TableChange } from '@repo/sync-types';
import { processWALChanges } from './changes';
import { ClientManager } from './client-manager';
import { StateManager } from './state-manager';
import type { DurableObjectState } from '../types/cloudflare';
import type { WALData } from '../types/wal';

const MODULE_NAME = 'polling';

// Polling intervals
export const ACTIVE_POLL_INTERVAL = 1000; // 1 second
export const CLIENT_CHECK_INTERVAL = 60000; // 60 seconds
export const HIBERNATION_CHECK_INTERVAL = 300000; // 300 seconds

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
  private clientCheckInterval: ReturnType<typeof setInterval> | null = null;
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
      await this.pollForChanges();
      
      // Mark first poll complete and resolve promise
      this.hasCompletedFirstPoll = true;
      if (this.initialPollResolve) {
        this.initialPollResolve();
      }

      // Check for active clients after initial poll
      const hasActiveClients = await this.clientManager.hasActiveClients();
      
      if (!hasActiveClients) {
        replicationLogger.info('No active clients after initial poll, entering hibernation', {
          event: 'replication.hibernation.enter',
          reason: 'no_active_clients'
        }, MODULE_NAME);
        
        // Stop polling and set hibernation check
        this.stopPolling();
        const nextCheck = Date.now() + HIBERNATION_CHECK_INTERVAL;
        await this.state.storage.setAlarm(nextCheck);
        replicationLogger.info('Set hibernation wake-up alarm', {
          event: 'replication.hibernation.alarm_set',
          nextCheck: new Date(nextCheck).toISOString(),
          intervalMs: HIBERNATION_CHECK_INTERVAL
        }, MODULE_NAME);
        return;
      }

      // Start active polling and client checking if we have clients
      if (!this.pollingInterval) {
        replicationLogger.debug('Starting regular polling and client checks', {
          event: 'replication.polling.start',
          pollInterval: `${ACTIVE_POLL_INTERVAL}ms`,
          clientCheckInterval: `${CLIENT_CHECK_INTERVAL}ms`
        }, MODULE_NAME);
        
        // Start polling interval
        this.pollingInterval = setInterval(() => this.checkClientsAndPoll(), ACTIVE_POLL_INTERVAL);
        
        // Start periodic client check interval (runs less frequently to reduce noise)
        this.clientCheckInterval = setInterval(async () => {
          const hasClients = await this.checkForActiveClients();
          if (!hasClients) {
            // Stop both intervals and enter hibernation
            this.stopPolling();
            const nextCheck = Date.now() + HIBERNATION_CHECK_INTERVAL;
            await this.state.storage.setAlarm(nextCheck);
          }
        }, CLIENT_CHECK_INTERVAL);
      }
    } catch (err) {
      replicationLogger.error('Error starting polling:', err, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Check for active clients and handle hibernation if none found
   */
  private async checkForActiveClients(): Promise<boolean> {
    const hasActiveClients = await this.clientManager.hasActiveClients();
    
    if (!hasActiveClients) {
      replicationLogger.info('No active clients found during periodic check, entering hibernation', {
        event: 'replication.hibernation.enter',
        reason: 'periodic_check'
      }, MODULE_NAME);
      return false;
    }
    
    return true;
  }

  /**
   * Check for changes and notify active clients if needed
   */
  private async checkClientsAndPoll(): Promise<void> {
    try {
      // Poll for changes first - this is fast since it just checks LSN
      const changes = await this.pollForChanges();
      
      // Process changes if any were found
      if (changes && changes.length > 0) {
        // Process and send changes to clients
        await processWALChanges(changes, this.clientManager);
      }
    } catch (err) {
      replicationLogger.error('Error in client check and poll:', err, MODULE_NAME);
    }
  }

  /**
   * Stop active polling
   */
  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      replicationLogger.info('Active polling stopped', MODULE_NAME);
    }
    
    if (this.clientCheckInterval) {
      clearInterval(this.clientCheckInterval);
      this.clientCheckInterval = null;
      replicationLogger.info('Client check interval stopped', MODULE_NAME);
    }
  }

  /**
   * Poll for new changes
   */
  private async pollForChanges(): Promise<WALData[] | null> {
    try {
      const client = getDBClient(this.c);
      await client.connect();
      try {
        // Get current LSN from state manager
        const currentLSN = await this.stateManager.getLSN();

        const result = await client.query(`
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
        `, [this.config.slot, currentLSN]);
        
        // Map changes to our format
        const newChanges = result.rows.map(row => ({
          data: row.data,
          lsn: row.lsn,
          xid: row.xid
        }));

        // If we have changes, update LSN and return them
        if (newChanges.length > 0) {
          const lastLSN = newChanges[newChanges.length - 1].lsn;
          await this.stateManager.setLSN(lastLSN);
          
          replicationLogger.info('Found new WAL changes', {
            event: 'replication.changes.found',
            changeCount: newChanges.length,
            currentLSN: lastLSN,
            previousLSN: currentLSN
          }, MODULE_NAME);
          
          return newChanges;
        } else if (!this.hasCompletedFirstPoll) {
          // Only log no changes during initial poll
          replicationLogger.info('No new changes found during initial poll', {
            event: 'replication.changes.none',
            currentLSN
          }, MODULE_NAME);
        }
        
        return null;
      } finally {
        await client.end();
      }
    } catch (err) {
      replicationLogger.error('Error polling for changes:', err, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Handle DO alarm - check clients and restart polling if needed
   */
  public async handleAlarm(): Promise<void> {
    try {
      replicationLogger.info('Handling hibernation wake-up alarm', {
        event: 'replication.hibernation.wake',
        timestamp: new Date().toISOString()
      }, MODULE_NAME);

      // Reset first poll state since we're waking up
      this.hasCompletedFirstPoll = false;
      this.initialPollPromise = new Promise((resolve) => {
        this.initialPollResolve = resolve;
      });

      // Start polling again - this will check for clients and re-hibernate if none
      await this.startPolling();
      await this.waitForInitialPoll();
    } catch (err) {
      replicationLogger.error('Error handling alarm:', err, MODULE_NAME);
      // Ensure next alarm is set even if this one failed
      const nextCheck = Date.now() + HIBERNATION_CHECK_INTERVAL;
      await this.state.storage.setAlarm(nextCheck);
      replicationLogger.info('Reset hibernation alarm after error', {
        event: 'replication.hibernation.alarm_reset',
        nextCheck: new Date(nextCheck).toISOString(),
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
    }
  }
} 