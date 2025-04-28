import type { DurableObjectState } from '../types/cloudflare';
import type { MinimalContext } from '../types/hono';
import { syncLogger } from '../middleware/logger';
import { getDBClient, sql } from '../lib/db';
import type { InitialSyncState } from './types';
import { compareLSN } from '../lib/sync-common';

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
  updateClientSyncState(clientId: string, state: SyncState): Promise<void>;
  initializeConnection(): Promise<void>;
  cleanupConnection(): Promise<void>;
  determineStateFromLSN(clientLSN: string, serverLSN: string): SyncState;
  getLSN(): Promise<string | null>;
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
    
    // Restore client ID from storage when DO wakes up
    this.restoreClientId();
  }

  /**
   * Track when the DO wakes up
   */
  private async trackWakeTime() {
    const now = Date.now();
    const lastWake = await this.durableObjectState.storage.get<number>('lastWakeTime');
    
    if (lastWake) {
      const sleepDuration = now - lastWake;
      syncLogger.info('SyncDO wakeup', {
        sleepMs: sleepDuration,
        sleepSec: Math.round(sleepDuration / 1000)
      }, MODULE_NAME);
    }
    
    await this.durableObjectState.storage.put('lastWakeTime', now);
    this.metrics.lastWakeTime = now;
  }

  /**
   * Restore client ID from storage when DO wakes from hibernation
   */
  private async restoreClientId(): Promise<void> {
    try {
      const storedClientId = await this.durableObjectState.storage.get<string>('current_client_id');
      
      if (storedClientId) {
        this.clientId = storedClientId;
        syncLogger.info('Restored client ID from storage', {
          clientId: storedClientId
        }, MODULE_NAME);
      }
    } catch (error) {
      syncLogger.error('Failed to restore client ID from storage', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
    }
  }

  /**
   * Determine sync state based on LSN comparison
   */
  determineStateFromLSN(clientLSN: string, serverLSN: string): SyncState {
    // Initial state when client LSN is 0/0
    if (clientLSN === '0/0') {
      return 'initial';
    }
    
    // Use proper compareLSN function instead of string comparison
    // If client LSN is less than server LSN, we need catchup
    if (compareLSN(clientLSN, serverLSN) < 0) {
      return 'catchup';
    }
    
    // Client is up to date with server
    return 'live';
  }

  /**
   * Initialize connection and register client
   */
  async initializeConnection(): Promise<void> {
    syncLogger.info('Connection initializing', {
      clientId: this.clientId
    }, MODULE_NAME);
    
    try {
      // Only register client existence in KV
      if (this.clientId) {
        const clientData = { 
          active: true,
          lastSeen: Date.now()
        };
        const key = `client:${this.clientId}`;
        
        syncLogger.debug('Registering client in KV', {
          clientId: this.clientId
        }, MODULE_NAME);
        
        await this.context.env.CLIENT_REGISTRY.put(
          key,
          JSON.stringify(clientData)
        );
        
        // Verify registration
        const verifyData = await this.context.env.CLIENT_REGISTRY.get(key);
        syncLogger.debug('Registration verified', {
          clientId: this.clientId,
          exists: !!verifyData
        }, MODULE_NAME);
      } else {
        syncLogger.error('Client registration failed', {
          reason: 'No client ID available'
        }, MODULE_NAME);
      }
    } catch (err) {
      syncLogger.error('Connection initialization failed', {
        clientId: this.clientId,
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Clean up connection and mark client as inactive
   */
  async cleanupConnection(): Promise<void> {
    if (!this.clientId) {
      return; // No client ID available, can't cleanup
    }
    
    const clientId = this.clientId;
    
    // Mark client as inactive in KV, but keep the in-memory reference
    const key = `client:${clientId}`;
    syncLogger.debug('Deactivating client', { 
      clientId
    }, MODULE_NAME);
    
    try {
      // Get current state
      const existingData = await this.context.env.CLIENT_REGISTRY.get(key);
      if (existingData) {
        // Parse carefully to handle potential JSON issues
        let data;
        try {
          data = JSON.parse(existingData);
        } catch (jsonError) {
          // Handle JSON parse error by creating a new data object
          syncLogger.warn('Client data parse error, creating new record', {
            clientId,
            error: jsonError instanceof Error ? jsonError.message : String(jsonError)
          }, MODULE_NAME);
          
          data = {
            lastSeen: Date.now()
          };
        }
        
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
        
        syncLogger.debug('Client marked inactive', { 
          clientId
        }, MODULE_NAME);
      }
    } catch (err) {
      syncLogger.error('Failed to deactivate client', {
        clientId,
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
    }
  }

  /**
   * Register a new client
   */
  async registerClient(clientId: string): Promise<void> {
    syncLogger.info('Registering client', { clientId }, MODULE_NAME);
    
    try {
      this.clientId = clientId;
      
      // Store the client ID in the Durable Object's storage for persistence
      // This helps validate that the right client is connecting to the right DO
      await this.durableObjectState.storage.put('current_client_id', clientId);
      
      // Register client in KV registry
      const clientData = { 
        active: true,
        lastSeen: Date.now()
      };
      const key = `client:${clientId}`;
      
      await this.context.env.CLIENT_REGISTRY.put(
        key,
        JSON.stringify(clientData)
      );
      
      // Verify registration
      const verifyData = await this.context.env.CLIENT_REGISTRY.get(key);
      syncLogger.debug('Client registered', {
        clientId,
        registered: !!verifyData
      }, MODULE_NAME);
    } catch (err) {
      syncLogger.error('Client registration failed', {
        clientId,
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Update client's LSN in DO storage
   */
  async updateClientLSN(clientId: string, lsn: string): Promise<void> {
    if (!clientId || !lsn) {
      throw new Error('Client ID and LSN are required');
    }

    try {
      // Store LSN in DO storage
      const key = `client:${clientId}:lsn`;
      await this.durableObjectState.storage.put(key, lsn);
      
      // Verify the LSN was saved
      const savedLSN = await this.durableObjectState.storage.get<string>(key);
      if (savedLSN !== lsn) {
        throw new Error(`Failed to verify LSN save: expected ${lsn}, got ${savedLSN}`);
      }
      
      syncLogger.debug('Updated client LSN', {
        clientId,
        lsn,
        saved: true
      }, MODULE_NAME);
    } catch (err) {
      syncLogger.error('Failed to update client LSN', {
        clientId,
        lsn,
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Get client LSN from DO storage
   */
  async getLSN(): Promise<string | null> {
    if (!this.clientId) {
      return null;
    }

    try {
      const key = `client:${this.clientId}:lsn`;
      const lsn = await this.durableObjectState.storage.get<string>(key);
      
      syncLogger.debug('Retrieved client LSN', {
        clientId: this.clientId,
        lsn,
        found: !!lsn
      }, MODULE_NAME);
      
      return lsn || null;
    } catch (err) {
      syncLogger.error('Failed to get client LSN', {
        clientId: this.clientId,
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      return null;
    }
  }

  /**
   * Update client's sync state in DO storage
   */
  async updateClientSyncState(clientId: string, state: SyncState): Promise<void> {
    // Store state in DO storage
    await this.durableObjectState.storage.put(`client:${clientId}:syncState`, state);
    
    // Update client registry with state info
    const key = `client:${this.clientId}`;
    try {
      const existingData = await this.context.env.CLIENT_REGISTRY.get(key);
      if (existingData) {
        const data = JSON.parse(existingData);
        await this.context.env.CLIENT_REGISTRY.put(
          key,
          JSON.stringify({
            ...data,
            syncState: state,
            lastSeen: Date.now()
          })
        );
        
        syncLogger.debug('Updated client sync state', {
          clientId,
          state
        }, MODULE_NAME);
      }
    } catch (err) {
      syncLogger.error('Failed to update client sync state', {
        clientId,
        state,
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
    }
  }

  /**
   * Track errors for monitoring
   */
  trackError(error: Error): void {
    this.metrics.errors.push(error);
    syncLogger.error('Sync error tracked', {
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
   * Get current server LSN
   */
  async getServerLSN(): Promise<string> {
    try {
      const result = await sql<{ lsn: string }>(this.context, 'SELECT pg_current_wal_lsn() as lsn');
      return result[0].lsn;
    } catch (err) {
      syncLogger.error('Server LSN fetch failed', {
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
      syncLogger.debug('Saving sync progress', { 
        clientId, 
        status: state.status
      }, MODULE_NAME);
      
      // Use DO storage instead of database
      await this.durableObjectState.storage.put('initial_sync_state', state);
      
      syncLogger.debug('Progress saved', { clientId }, MODULE_NAME);
    } catch (error) {
      syncLogger.error('Saving progress failed', {
        clientId,
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      throw error;
    }
  }

  /**
   * Get initial sync progress from Durable Object storage
   */
  async getInitialSyncProgress(clientId: string): Promise<InitialSyncState | null> {
    try {
      syncLogger.debug('Getting sync progress', { clientId }, MODULE_NAME);
      
      // Use DO storage instead of database
      const syncState = await this.durableObjectState.storage.get<InitialSyncState>('initial_sync_state');
      
      syncLogger.debug('Progress retrieved', { 
        clientId, 
        found: !!syncState
      }, MODULE_NAME);
      
      return syncState || null;
    } catch (error) {
      syncLogger.error('Progress retrieval failed', {
        clientId,
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      return null;
    }
  }
} 