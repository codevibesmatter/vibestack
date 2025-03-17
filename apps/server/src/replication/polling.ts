import type { Client } from '@neondatabase/serverless';
import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { ReplicationConfig, ReplicationMetrics, ReplicationState } from './types';
import { getSlotStatus } from './slot';
import { processWALChanges } from './changes';
import { ClientManager } from './client-manager';
import { replicationLogger } from '../middleware/logger';
import { StateManager } from './state-manager';
import { getDBClient } from '../lib/db';
import type { MinimalContext } from '../types/hono';
import { handleNewChanges } from '../sync/server-changes';
import { SyncStateManager } from '../sync/state-manager';

// Polling intervals
const ACTIVE_POLL_INTERVAL = 1000; // 1 second
const HIBERNATION_CHECK_INTERVAL = 60000; // 1 minute

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
    private readonly stateManager: StateManager,
    private readonly clientManager: ClientManager,
    private readonly config: ReplicationConfig,
    private readonly c: MinimalContext,
    private readonly state: DurableObjectState
  ) {
    // Create a promise that will resolve when initial poll completes
    this.initialPollPromise = new Promise((resolve) => {
      this.initialPollResolve = resolve;
    });
  }

  /**
   * Wait for the initial polling cycle to complete
   */
  public async waitForInitialPoll(): Promise<void> {
    if (this.hasCompletedFirstPoll) {
      return;
    }
    await this.initialPollPromise;
  }

  /**
   * Start polling for changes
   */
  public async startPolling(): Promise<void> {
    try {
      // Do initial poll to catch up on changes
      const initialPeek = await this.pollForChanges();
      
      // Log initial peek results if we found any changes
      if (initialPeek) {
        replicationLogger.info('Initial WAL peek results:', {
          event: 'replication.init.success',
          ...initialPeek,
          message: initialPeek.hasTableChanges 
            ? 'Found table changes to process'
            : 'No table changes to process, but LSN may advance'
        });
      } else {
        const state = await this.stateManager.loadState();
        replicationLogger.info('Initial WAL peek - no changes found', {
          event: 'replication.init.success',
          message: 'Replication slot is up to date',
          currentLSN: state.confirmedLSN,
          currentLSNHex: state.confirmedLSN.split('/').map(n => parseInt(n, 16).toString(16)).join('/')
        });
      }
      
      // Mark first poll complete and resolve promise - init is done once we've checked for changes
      this.hasCompletedFirstPoll = true;
      if (this.initialPollResolve) {
        this.initialPollResolve();
      }

      // Check if we should start active polling
      await this.checkPollingMode();
    } catch (err) {
      replicationLogger.error('Error starting polling:', err);
      throw err;
    }
  }

  /**
   * Stop active polling
   */
  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      replicationLogger.info('Active polling stopped');
    }
  }

  /**
   * Check if we should be actively polling based on client state
   */
  private async checkPollingMode(): Promise<void> {
    try {
      const hasActiveClients = await this.clientManager.hasActiveClients();
      
      if (hasActiveClients) {
        // Start active polling if not already running
        if (!this.pollingInterval) {
          replicationLogger.info('Starting regular polling', {
            event: 'replication.polling.start',
            interval: `${ACTIVE_POLL_INTERVAL}ms`
          });
          this.pollingInterval = setInterval(() => this.pollForChanges(), ACTIVE_POLL_INTERVAL);
        }
        // Clear any existing alarm since we're actively polling
        await this.state.storage.deleteAlarm();
      } else {
        // No clients - stop active polling and set hibernation check alarm
        this.stopPolling();
        replicationLogger.info('No active clients, setting hibernation check', {
          event: 'replication.hibernation.prepare',
          nextCheck: `${HIBERNATION_CHECK_INTERVAL}ms`
        });
        await this.state.storage.setAlarm(Date.now() + HIBERNATION_CHECK_INTERVAL);
        
        replicationLogger.info('DO entering hibernation state', {
          event: 'replication.hibernation.enter',
          timestamp: new Date().toISOString()
        });
      }
    } catch (err) {
      replicationLogger.error('Error checking polling mode:', {
        event: 'replication.polling.error',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      throw err;
    }
  }

  /**
   * Poll for new changes
   * @returns Peek results if any changes were found
   */
  private async pollForChanges(): Promise<{ count: number, hasTableChanges: boolean, lsns: string[] } | undefined> {
    try {
      const state = await this.stateManager.loadState();
      
      // Get WAL changes
      const client = getDBClient(this.c);
      await client.connect();
      try {
        // Peek at changes without consuming
        const peekResult = await client.query(`
          SELECT data, lsn, xid 
          FROM pg_logical_slot_peek_changes(
            $1,
            NULL,
            NULL,
            'include-xids', '1',
            'include-timestamp', 'true'
          );
        `, [this.config.slot]);

        // Only proceed if we have changes
        if (peekResult.rows.length > 0) {
          // Check if we have actual table changes or just LSN advances
          const hasTableChanges = peekResult.rows.some(row => {
            try {
              const data = JSON.parse(row.data);
              return data.change && Array.isArray(data.change) && data.change.length > 0;
            } catch {
              return false;
            }
          });

          const peekResults = {
            count: peekResult.rows.length,
            hasTableChanges,
            lsns: peekResult.rows.map(r => r.lsn)
          };

          // Log what we found
          replicationLogger.debug('WAL data analysis:', {
            event: 'replication.wal.peek',
            ...peekResults
          });

          if (hasTableChanges) {
            // Process changes directly from peek results
            const walData = peekResult.rows.map(row => ({
              data: row.data,
              lsn: row.lsn,
              xid: row.xid
            }));

            await processWALChanges(this.c, walData, state, this.clientManager, this.stateManager);
            replicationLogger.info('Successfully processed table changes', {
              event: 'replication.changes.success',
              count: walData.length,
              firstLSN: walData[0].lsn,
              lastLSN: walData[walData.length - 1].lsn,
              tables: [...new Set(walData.map(w => {
                try {
                  const data = JSON.parse(w.data);
                  return data.change?.[0]?.table;
                } catch {
                  return null;
                }
              }).filter(Boolean))]
            });
            
            // Return peek results so polling flow continues
            return peekResults;
          }

          // Just update the LSN without consuming changes
          const lastLSN = peekResult.rows[peekResult.rows.length - 1].lsn;
          if (compareLSNs(lastLSN, state.confirmedLSN)) {
            await this.stateManager.updateState({ confirmedLSN: lastLSN });
            replicationLogger.debug('LSN advanced without table changes', {
              event: 'replication.lsn.advance',
              from: state.confirmedLSN,
              to: lastLSN
            });
          }

          return peekResults;
        }
      } finally {
        await client.end();
      }
    } catch (err) {
      replicationLogger.error('Error polling for changes', {
        event: 'replication.poll.error',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      throw err;
    }
  }

  /**
   * Handle DO alarm - check clients and restart polling if needed
   */
  public async handleAlarm(): Promise<void> {
    try {
      await this.checkPollingMode();
    } catch (err) {
      replicationLogger.error('Error handling alarm:', err);
      // Ensure next alarm is set even if this one failed
      await this.state.storage.setAlarm(Date.now() + HIBERNATION_CHECK_INTERVAL);
    }
  }
} 