import type { Client } from '@neondatabase/serverless';
import type { Env } from '../types/env';
import type { ReplicationConfig } from './types';
import { replicationLogger } from '../middleware/logger';
import { getDBClient, sql } from '../lib/db';
import type { MinimalContext } from '../types/hono';
import type { TableChange } from '@repo/sync-types';
import { processChanges } from './process-changes';
import { StateManager } from './state-manager';
import type { DurableObjectState } from '../types/cloudflare';
import type { WALData } from '../types/wal';
import { compareLSN } from '../lib/sync-common';

// ====== Types and Interfaces ======
const MODULE_NAME = 'polling';

// ====== Constants ======
const DEFAULT_POLL_INTERVAL = 1000; // 1 second
const DEFAULT_BATCH_SIZE = 2000;    // Maximum changes to peek per cycle
const DEFAULT_CONSUME_SIZE = 2000;  // Maximum changes to consume per cycle
const HEARTBEAT_INTERVAL = 60;      // Log a heartbeat every 60 polls (approx 1 minute)

// ====== Helper Functions ======
function compareLSNs(lsn1: string, lsn2: string): boolean {
  return compareLSN(lsn1, lsn2) > 0;
}

// ====== Core Polling Class ======
export class PollingManager {
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  public hasCompletedFirstPoll = false;
  private isPolling = false;
  private pollCounter = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly config: ReplicationConfig,
    private readonly c: MinimalContext,
    private readonly env: Env,
    private readonly stateManager: StateManager
  ) {}

  // ====== Public Interface ======
  public getPollCount(): number {
    return this.pollCounter;
  }

  public async startPolling(): Promise<void> {
    try {
      if (this.pollingInterval) {
        replicationLogger.debug('Polling already active, no action needed', {}, MODULE_NAME);
        return;
      }
      
      this.pollCounter = 0;
      replicationLogger.info('Starting polling process', {}, MODULE_NAME);
      
      this.hasCompletedFirstPoll = true;
      this.startContinuousPolling();
    } catch (err) {
      replicationLogger.error('Start polling error', {
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      this.pollCounter = 0;
      replicationLogger.info('Polling stopped', {}, MODULE_NAME);
    }
  }

  // ====== Private Polling Methods ======
  private startContinuousPolling(): void {
    const pollInterval = this.config.pollingInterval || DEFAULT_POLL_INTERVAL;
    
    this.pollingInterval = setInterval(async () => {
      if (this.isPolling) {
        return;
      }
      
      this.isPolling = true;
      
      try {
        this.pollCounter++;
        
        if (this.pollCounter % HEARTBEAT_INTERVAL === 0) {
          const currentLSN = await this.stateManager.getLSN();
          replicationLogger.info('Polling heartbeat', {
            counter: this.pollCounter,
            intervalMs: pollInterval,
            currentLSN
          }, MODULE_NAME);
        }
        
        await this.pollAndProcess();
      } catch (error) {
        replicationLogger.error('Polling error', {
          error: error instanceof Error ? error.message : String(error)
        }, MODULE_NAME);
      } finally {
        this.isPolling = false;
      }
    }, pollInterval);
    
    replicationLogger.debug('Polling interval started', { intervalMs: pollInterval }, MODULE_NAME);
  }

  private async pollAndProcess(): Promise<void> {
    try {
      const changes = await this.pollForChanges();
      
      if (changes && changes.length > 0) {
        try {
          // Extract basic info about the WAL entries
          const firstLSN = changes[0].lsn;
          const lastLSN = changes[changes.length - 1].lsn;
          
          // Remove redundant parsing - this is already done in processChanges
          // Let processChanges handle the actual parsing and counting
          replicationLogger.info('WAL changes found', {
            walEntries: changes.length,
            lsnRange: {
              first: firstLSN,
              last: lastLSN
            }
          }, MODULE_NAME);

          // Process the changes and get accurate counts from the result
          const result = await processChanges(
            changes,
            this.env,
            this.c,
            this.stateManager,
            this.config.storeBatchSize
          );
          
          replicationLogger.debug('Polling cycle completed', {
            walEntriesProcessed: changes.length,
            entityChangesProcessed: result.changeCount || 0,
            entityChangesFiltered: result.filteredCount || 0,
            storedSuccessfully: result.storedChanges,
            lastLSN: result.lastLSN,
            nextPollIn: this.config.pollingInterval || DEFAULT_POLL_INTERVAL
          }, MODULE_NAME);
          
        } catch (processError) {
          const errorMsg = processError instanceof Error ? processError.message : String(processError);
          replicationLogger.error('Change processing error', {
            error: errorMsg,
            walEntries: changes.length
          }, MODULE_NAME);
        }
      }
    } catch (error) {
      replicationLogger.error('Poll and process error', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
    }
  }

  private async pollForChanges(): Promise<WALData[] | null> {
    const client = getDBClient(this.c);
    
    try {
      const currentLSN = await this.stateManager.getLSN();
      await client.connect();
      
      const batchSize = this.config.walBatchSize || DEFAULT_BATCH_SIZE;
      
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
      
      const result = await client.query(query, [this.config.slot, currentLSN]);
      
      const newChanges = result.rows.map(row => ({
        data: row.data as string,
        lsn: row.lsn as string,
        xid: row.xid as string
      }));
      
      return newChanges.length > 0 ? newChanges : null;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      
      if (errorMsg.includes('replication slot') && errorMsg.includes('is active for PID')) {
        replicationLogger.warn('Replication slot in use by another process during poll', {
          error: errorMsg,
          slot: this.config.slot
        }, MODULE_NAME);
        
        return null;
      } else {
        replicationLogger.error('Polling error', {
          error: errorMsg
        }, MODULE_NAME);
        
        throw err;
      }
    } finally {
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