import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Context } from 'hono';
import type { ReplicationState } from './types';
import type { Env } from '../types/env';
import { replicationLogger } from '../middleware/logger';
import type { ReplicationConfig } from './types';
import { PollingManager } from './polling';
import { getAllClients } from '../sync/client-registry';
import { Client } from '@neondatabase/serverless';
import { getSlotStatus } from './slot';
import { getDBClient } from '../lib/db';
import type { MinimalContext } from '../types/hono';

// Add connect_timeout to URL if not present
function addConnectTimeout(url: string): string {
  const dbUrl = new URL(url);
  if (!dbUrl.searchParams.has('connect_timeout')) {
    dbUrl.searchParams.set('connect_timeout', '10');
  }
  if (!dbUrl.searchParams.has('sslmode')) {
    dbUrl.searchParams.set('sslmode', 'require');
  }
  return dbUrl.toString();
}

// Create a database client for DurableObjects
function createDBClient(databaseURL: string): Client {
  const urlWithTimeout = addConnectTimeout(databaseURL);
  return new Client({
    connectionString: urlWithTimeout,
    ssl: true
  });
}

/**
 * Manages the state persistence for the replication system
 */
export class StateManager {
  private state: DurableObjectState;
  private stateKey = 'replication_state';

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  /**
   * Loads the current replication state from storage
   * @returns The current replication state
   */
  public async loadState(): Promise<ReplicationState> {
    try {
      const state = await this.state.storage.get<ReplicationState>(this.stateKey);
      return state || {
        confirmedLSN: '0/0'
      };
    } catch (err) {
      replicationLogger.error('Failed to load replication state:', err);
      // Return default state on error
      return {
        confirmedLSN: '0/0'
      };
    }
  }

  /**
   * Updates the replication state with the provided values
   * @param updates Partial state updates to apply
   */
  public async updateState(updates: Partial<ReplicationState>): Promise<void> {
    try {
      const currentState = await this.loadState();
      const newState = {
        ...currentState,
        ...updates
      };
      
      replicationLogger.debug('Updating state', {
        event: 'replication.state.update',
        changes: updates,
        currentLSN: updates.confirmedLSN || currentState.confirmedLSN
      });
      
      await this.state.storage.put(this.stateKey, newState);
    } catch (err) {
      replicationLogger.error('Failed to update state', {
        event: 'replication.state.error',
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  }

  /**
   * Resets the replication state to default values
   */
  public async resetState(): Promise<void> {
    try {
      const defaultState: ReplicationState = {
        confirmedLSN: '0/0'
      };
      
      replicationLogger.warn('Resetting replication state to defaults');
      await this.state.storage.put(this.stateKey, defaultState);
    } catch (err) {
      replicationLogger.error('Failed to reset replication state:', err);
      throw err;
    }
  }
}

