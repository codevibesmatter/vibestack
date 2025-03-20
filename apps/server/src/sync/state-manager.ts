import type { DurableObjectState } from '../types/cloudflare';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import { getDBClient, sql } from '../lib/db';
import type { InitialSyncState } from './types';

const MODULE_NAME = 'state-manager';

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
  getCurrentState(): SyncState;
  setState(state: SyncState): Promise<void>;
  getLSN(): string | null;
  getClientId(): string | null;
  getMetrics(): SyncMetrics;
  getErrors(): Error[];
  trackError(error: Error): void;
  saveInitialSyncProgress(clientId: string, state: InitialSyncState): Promise<void>;
  getInitialSyncProgress(clientId: string): Promise<InitialSyncState | null>;
}

export class SyncStateManager implements StateManager {
  protected clientId: string | null = null;
  private lsn: string | null = null;
  private state: SyncState = 'initial';
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
   * Initialize connection and register client
   */
  async initializeConnection(): Promise<void> {
    syncLogger.info('Initializing connection in state manager', {
      clientId: this.clientId,
      currentLSN: this.lsn
    }, MODULE_NAME);
    
    try {
      const serverLSN = await this.getServerLSN();
      syncLogger.info('Current server LSN', { serverLSN }, MODULE_NAME);
      
      this.state = await this.determineSyncState(serverLSN);
      syncLogger.info('Determined sync state', { 
        state: this.state, 
        clientId: this.clientId,
        clientLSN: this.lsn,
        serverLSN
      }, MODULE_NAME);
      
      // Only register client existence
      if (this.clientId) {
        const clientData = { 
          active: true,
          lastSeen: Date.now() 
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
    this.lsn = null;
    this.state = 'initial';
    
    // Mark client as inactive in registry
    if (clientIdToRemove) {
      const key = `client:${clientIdToRemove}`;
      syncLogger.info('Marking client as inactive', { 
        clientId: clientIdToRemove,
        key,
        lastLSN: this.lsn
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
    if (clientId !== this.clientId) {
      throw new Error('Client ID mismatch');
    }
    this.lsn = lsn;
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
   * Get all tracked errors
   */
  getErrors(): Error[] {
    return this.metrics.errors;
  }

  /**
   * Get current metrics
   */
  getMetrics(): SyncMetrics {
    return this.metrics;
  }

  /**
   * Get current LSN
   */
  getLSN(): string | null {
    return this.lsn;
  }

  /**
   * Get current sync state
   */
  getCurrentState(): SyncState {
    return this.state;
  }

  /**
   * Set new sync state
   */
  async setState(newState: SyncState): Promise<void> {
    this.state = newState;
    syncLogger.info('State changed', { 
      clientId: this.clientId, 
      newState 
    }, MODULE_NAME);
  }

  /**
   * Get client ID
   */
  getClientId(): string | null {
    return this.clientId;
  }

  /**
   * Determine initial sync state based on LSN comparison
   */
  private async determineSyncState(serverLSN: string): Promise<SyncState> {
    if (!this.lsn || this.lsn === '0/0') {
      return 'initial';
    }

    // Check if we have an incomplete initial sync
    const initialState = await this.getInitialSyncProgress(this.clientId!);
    if (initialState && initialState.status !== 'complete') {
      return 'initial';
    }

    return this.lsn === serverLSN ? 'live' : 'catchup';
  }

  /**
   * Get current server LSN
   */
  private async getServerLSN(): Promise<string> {
    try {
      const result = await sql<{ lsn: string }>(this.context, 'SELECT pg_current_wal_lsn() as lsn');
      return result[0].lsn;
    } catch (err) {
      syncLogger.error('Failed to get server LSN', {
        clientId: this.clientId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      }, MODULE_NAME);
      // For one-time syncs, we can use a default LSN since we're not tracking changes
      return '0/0';
    }
  }

  /**
   * Save initial sync progress to persistent storage
   */
  async saveInitialSyncProgress(clientId: string, state: InitialSyncState): Promise<void> {
    if (clientId !== this.clientId) {
      throw new Error('Client ID mismatch');
    }

    const query = `
      INSERT INTO sync_state (client_id, type, state)
      VALUES ($1, 'initial_sync', $2)
      ON CONFLICT (client_id, type)
      DO UPDATE SET state = $2
    `;
    const db = getDBClient(this.context);
    await db.query(query, [clientId, JSON.stringify(state)]);

    // Update in-memory state
    if (state.status === 'complete') {
      await this.setState('catchup');
    }
  }

  /**
   * Get initial sync progress from persistent storage
   */
  async getInitialSyncProgress(clientId: string): Promise<InitialSyncState | null> {
    if (clientId !== this.clientId) {
      throw new Error('Client ID mismatch');
    }

    const query = `
      SELECT state
      FROM sync_state
      WHERE client_id = $1 AND type = 'initial_sync'
    `;
    const db = getDBClient(this.context);
    const result = await db.query(query, [clientId]);
    return result.rows[0]?.state || null;
  }
} 