import type { DurableObjectState } from '../types/cloudflare';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import { getDBClient, sql } from '../lib/db';
import type { InitialSyncState } from './types';

const MODULE_NAME = 'state-manager';

// Simplified sync state based on LSN comparison
export type SyncState = 'initial' | 'catchup' | 'live';

interface SyncMetrics {
  messagesReceived: number;
  messagesSent: number;
  changesProcessed: number;
  errors: Error[];
  lastWakeTime?: number;
}

export interface StateManager {
  registerClient(clientId: string): Promise<void>;
  updateClientLSN(clientId: string, lsn: string): Promise<void>;
  initializeConnection(): Promise<void>;
  cleanupConnection(): Promise<void>;
  determineStateFromLSN(clientLSN: string, serverLSN: string): SyncState;
  getLSN(): string | null;
  getClientId(): string | null;
  getMetrics(): SyncMetrics;
  getErrors(): Error[];
  trackError(error: Error): void;
  saveInitialSyncProgress(clientId: string, state: InitialSyncState): Promise<void>;
  getInitialSyncProgress(clientId: string): Promise<InitialSyncState | null>;
  getServerLSN(): Promise<string>;
}

export class SyncStateManager implements StateManager {
  protected clientId: string | null = null;
  private clientLSN: string | null = null;
  private metrics: SyncMetrics = {
    messagesReceived: 0,
    messagesSent: 0,
    changesProcessed: 0,
    errors: []
  };

  constructor(
    private context: MinimalContext,
    private durableObjectState: DurableObjectState
  ) {
    // Track wake-up time
    this.trackWakeTime();
  }

  /**
   * Track when the DO wakes up
   */
  private async trackWakeTime() {
    const now = Date.now();
    const lastWake = await this.durableObjectState.storage.get<number>('lastWakeTime');
    
    if (lastWake) {
      const sleepDuration = now - lastWake;
      syncLogger.info('🌅 SyncDO woken up', {
        sleepDurationMs: sleepDuration,
        sleepDurationSec: Math.round(sleepDuration / 1000)
      }, MODULE_NAME);
    }
    
    await this.durableObjectState.storage.put('lastWakeTime', now);
    this.metrics.lastWakeTime = now;
  }

  /**
   * Determine sync state based on LSN comparison
   */
  determineStateFromLSN(clientLSN: string, serverLSN: string): SyncState {
    // Initial state when client LSN is 0/0
    if (clientLSN === '0/0') {
      return 'initial';
    }
    
    // Compare LSNs (simple string comparison works for Postgres LSN format X/Y)
    // If client LSN is less than server LSN, we need catchup
    if (clientLSN < serverLSN) {
      return 'catchup';
    }
    
    // Client is up to date with server
    return 'live';
  }

  /**
   * Initialize connection and register client
   */
  async initializeConnection(): Promise<void> {
    syncLogger.info('Initializing connection in state manager', {
      clientId: this.clientId,
      currentLSN: this.clientLSN
    }, MODULE_NAME);
    
    try {
      const serverLSN = await this.getServerLSN();
      syncLogger.info('Current server LSN', { serverLSN }, MODULE_NAME);
      
      // Only register client existence
      if (this.clientId) {
        const clientData = { 
          active: true,
          lastSeen: Date.now(),
          lastLSN: this.clientLSN || '0/0'
        };
        const key = `client:${this.clientId}`;
        
        syncLogger.info('Registering client existence in KV store (no expiration)', {
          clientId: this.clientId,
          key,
          data: clientData
        }, MODULE_NAME);
        
        // Register with NO expiration time - client will stay in registry until explicitly removed
        await this.context.env.CLIENT_REGISTRY.put(
          key,
          JSON.stringify(clientData)
          // No expirationTtl - client stays in registry until removed
        );
        
        // Verify registration
        const verifyData = await this.context.env.CLIENT_REGISTRY.get(key);
        syncLogger.info('Verification of client registration', {
          clientId: this.clientId,
          exists: !!verifyData,
          data: verifyData ? verifyData : null
        }, MODULE_NAME);
      } else {
        syncLogger.error('Cannot register client - no clientId available', undefined, MODULE_NAME);
      }
    } catch (err) {
      syncLogger.error('Error initializing connection', {
        clientId: this.clientId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      }, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Clean up connection and mark client as inactive
   */
  async cleanupConnection(): Promise<void> {
    // Save clientId before clearing it
    const clientIdToRemove = this.clientId;
    
    // Clear instance state
    this.clientId = null;
    this.clientLSN = null;
    
    // Mark client as inactive in registry
    if (clientIdToRemove) {
      const key = `client:${clientIdToRemove}`;
      syncLogger.info('Marking client as inactive', { 
        clientId: clientIdToRemove,
        key,
        lastLSN: this.clientLSN
      }, MODULE_NAME);
      
      try {
        // Get current state
        const existingData = await this.context.env.CLIENT_REGISTRY.get(key);
        if (existingData) {
          const data = JSON.parse(existingData);
          // Just mark as inactive - ClientManager will handle cleanup
          await this.context.env.CLIENT_REGISTRY.put(
            key,
            JSON.stringify({
              ...data,
              active: false,
              lastSeen: Date.now(),
              disconnectedAt: Date.now()
            })
          );
          
          syncLogger.info('Client marked as inactive', { 
            clientId: clientIdToRemove,
            lastLSN: data.lastLSN,
            disconnectedAt: new Date().toISOString()
          }, MODULE_NAME);
        }
      } catch (err) {
        syncLogger.error('Failed to mark client as inactive', {
          clientId: clientIdToRemove,
          error: err instanceof Error ? err.message : String(err)
        }, MODULE_NAME);
      }
    }
  }

  /**
   * Register a new client
   */
  async registerClient(clientId: string): Promise<void> {
    syncLogger.info('Registering client in state manager', { clientId }, MODULE_NAME);
    
    try {
      this.clientId = clientId;
      
      // Register client in KV registry
      const clientData = { 
        active: true,
        lastSeen: Date.now(),
        lastLSN: '0/0'
      };
      const key = `client:${clientId}`;
      
      syncLogger.info('Registering client in KV store', {
        clientId,
        key,
        data: clientData
      }, MODULE_NAME);
      
      await this.context.env.CLIENT_REGISTRY.put(
        key,
        JSON.stringify(clientData)
      );
      
      // Verify registration
      const verifyData = await this.context.env.CLIENT_REGISTRY.get(key);
      syncLogger.info('Verification of client registration', {
        clientId,
        exists: !!verifyData,
        data: verifyData ? verifyData : null
      }, MODULE_NAME);
    } catch (err) {
      syncLogger.error('Error registering client', {
        clientId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      }, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Update client's LSN
   */
  async updateClientLSN(clientId: string, lsn: string): Promise<void> {
    this.clientLSN = lsn;
    
    // Store this in memory and update client registry
    if (this.clientId) {
      const key = `client:${this.clientId}`;
      try {
        const existingData = await this.context.env.CLIENT_REGISTRY.get(key);
        if (existingData) {
          const data = JSON.parse(existingData);
          await this.context.env.CLIENT_REGISTRY.put(
            key,
            JSON.stringify({
              ...data,
              lastLSN: lsn,
              lastSeen: Date.now()
            })
          );
        }
      } catch (err) {
        syncLogger.error('Failed to update client LSN in registry', {
          clientId,
          lsn,
          error: err instanceof Error ? err.message : String(err)
        }, MODULE_NAME);
      }
    }
  }

  /**
   * Track errors for monitoring
   */
  trackError(error: Error): void {
    this.metrics.errors.push(error);
    syncLogger.error('Sync error', {
      clientId: this.clientId,
      error: error.message
    }, MODULE_NAME);
  }

  /**
   * Get metrics
   */
  getMetrics(): SyncMetrics {
    return {
      ...this.metrics,
    };
  }

  /**
   * Get errors
   */
  getErrors(): Error[] {
    return this.metrics.errors;
  }

  /**
   * Get client ID
   */
  getClientId(): string | null {
    return this.clientId;
  }

  /**
   * Get client LSN
   */
  getLSN(): string | null {
    return this.clientLSN;
  }

  /**
   * Get current server LSN
   */
  async getServerLSN(): Promise<string> {
    try {
      const result = await sql<{ lsn: string }>(this.context, 'SELECT pg_current_wal_lsn() as lsn');
      return result[0].lsn;
    } catch (err) {
      syncLogger.error('Failed to get server LSN', {
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Save initial sync progress to persistent storage
   */
  async saveInitialSyncProgress(clientId: string, state: InitialSyncState): Promise<void> {
    try {
      syncLogger.debug('Saving initial sync progress', { 
        clientId, 
        state: {
          ...state,
          status: state.status
        }
      }, MODULE_NAME);
      
      // Use DO storage instead of database
      await this.durableObjectState.storage.put('initial_sync_state', state);
      
      syncLogger.debug('Saved initial sync progress', { clientId }, MODULE_NAME);
    } catch (error) {
      syncLogger.error('Error saving initial sync progress', {
        clientId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }, MODULE_NAME);
      throw error;
    }
  }

  /**
   * Get initial sync progress from Durable Object storage
   */
  async getInitialSyncProgress(clientId: string): Promise<InitialSyncState | null> {
    try {
      syncLogger.debug('Retrieving initial sync progress', { clientId }, MODULE_NAME);
      
      // Use DO storage instead of database
      const syncState = await this.durableObjectState.storage.get<InitialSyncState>('initial_sync_state');
      
      syncLogger.debug('Retrieved initial sync state', { 
        clientId, 
        found: !!syncState,
        syncState: syncState ? JSON.stringify(syncState) : 'null'
      }, MODULE_NAME);
      
      return syncState || null;
    } catch (error) {
      syncLogger.error('Error retrieving initial sync progress', {
        clientId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }, MODULE_NAME);
      return null;
    }
  }
} 