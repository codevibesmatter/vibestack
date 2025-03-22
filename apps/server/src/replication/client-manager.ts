import type { DurableObjectState } from '../types/cloudflare';
import type { TableChange } from '@repo/sync-types';
import { replicationLogger } from '../middleware/logger';
import type { Env } from '../types/env';
import type { MinimalContext } from '../types/hono';

const MODULE_NAME = 'client-manager';

/**
 * Interface for notification results
 */
export interface NotificationResult {
  total: number;
  notified: number;
  wokenUp: number;
  failed: number;
  skipped: number;
}

/**
 * Client state persisted in KV storage
 */
export interface ClientState {
  clientId: string;
  active: boolean;
  lastSeen: number;
}

// Extend TableChange for our internal use to include LSN
interface ReplicationTableChange extends TableChange {
  lsn: string;
}

/**
 * Manages client notifications and change filtering
 */
export class ClientManager {
  private env: Env;
  private static readonly CLIENT_TIMEOUT = 10 * 60 * 1000; // 10 minutes (increased from 5)
  private lastFullCleanupTime: number = 0;
  private readonly FULL_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // Once per day

  constructor(env: Env) {
    this.env = env;
    this.lastFullCleanupTime = Date.now();
  }

  /**
   * Perform a full cleanup of the client registry
   */
  public async purgeStaleClients(): Promise<number> {
    try {
      const { keys } = await this.env.CLIENT_REGISTRY.list({ prefix: 'client:' });
      
      replicationLogger.info('Client registry cleanup started', { 
        clientCount: keys.length 
      }, MODULE_NAME);
      
      let removedCount = 0;
      const now = Date.now();
      
      for (const key of keys) {
        const value = await this.env.CLIENT_REGISTRY.get(key.name);
        if (!value) {
          await this.env.CLIENT_REGISTRY.delete(key.name);
          removedCount++;
          continue;
        }
        
        try {
          const state = JSON.parse(value);
          const lastSeen = state.lastSeen || 0;
          const timeSinceLastSeen = now - lastSeen;
          const clientId = key.name.replace('client:', '');
          
          // Remove if inactive or stale
          if (!state.active || timeSinceLastSeen > ClientManager.CLIENT_TIMEOUT) {
            const reason = !state.active ? 'inactive' : 'stale';
            replicationLogger.debug('Purging client', { 
              clientId, 
              reason,
              idleSecs: Math.round(timeSinceLastSeen / 1000)
            }, MODULE_NAME);
            
            await this.env.CLIENT_REGISTRY.delete(key.name);
            removedCount++;
          }
        } catch (err) {
          // If we can't parse the state, just remove the client
          await this.env.CLIENT_REGISTRY.delete(key.name);
          removedCount++;
        }
      }
      
      replicationLogger.info('Cleanup completed', { 
        removedCount,
        totalClients: keys.length
      }, MODULE_NAME);
      
      this.lastFullCleanupTime = now;
      return removedCount;
    } catch (error) {
      replicationLogger.error('Purge failed', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      return 0;
    }
  }

  /**
   * Check if there are any active clients
   */
  public async hasActiveClients(): Promise<boolean> {
    try {
      // Check if we should do a full cleanup
      const now = Date.now();
      if (now - this.lastFullCleanupTime > this.FULL_CLEANUP_INTERVAL) {
        await this.purgeStaleClients();
      }
      
      const { keys } = await this.env.CLIENT_REGISTRY.list({ prefix: 'client:' });
      
      replicationLogger.debug('Checking active clients', { 
        clientCount: keys.length 
      }, MODULE_NAME);
      
      if (keys.length === 0) {
        replicationLogger.debug('No clients in registry', {}, MODULE_NAME);
        return false;
      }
      
      let hasActive = false;
      
      // Check each client's state and clean up inactive or stale ones
      for (const key of keys) {
        const value = await this.env.CLIENT_REGISTRY.get(key.name);
        
        if (!value) {
          replicationLogger.warn('Empty client record', { 
            clientKey: key.name 
          }, MODULE_NAME);
          // Clean up empty key
          await this.env.CLIENT_REGISTRY.delete(key.name);
          continue;
        }

        try {
          const state = JSON.parse(value);
          const lastSeen = state.lastSeen || 0;
          const timeSinceLastSeen = now - lastSeen;
          const clientId = key.name.replace('client:', '');
          
          // Should remove client if:
          // 1. It's explicitly marked as inactive, or
          // 2. It hasn't been seen recently (stale)
          if (!state.active || timeSinceLastSeen > ClientManager.CLIENT_TIMEOUT) {
            const reason = !state.active ? 'inactive' : 'stale';
            replicationLogger.info('Removing client', {
              clientId,
              reason,
              idleSecs: Math.round(timeSinceLastSeen / 1000)
            }, MODULE_NAME);
            await this.env.CLIENT_REGISTRY.delete(key.name);
          } else {
            // Client is active and was seen recently
            hasActive = true;
          }
        } catch (err) {
          replicationLogger.error('Client state parse error', {
            key: key.name,
            error: err instanceof Error ? err.message : String(err)
          }, MODULE_NAME);
          // Remove invalid entry
          await this.env.CLIENT_REGISTRY.delete(key.name);
        }
      }
      
      if (!hasActive) {
        replicationLogger.info('No active clients', {}, MODULE_NAME);
      }
      
      return hasActive;
    } catch (error) {
      replicationLogger.error('Active clients check failed', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      return false;
    }
  }

  /**
   * Broadcast changes to all connected clients
   */
  async broadcastChanges(changes: TableChange[]): Promise<void> {
    try {
      replicationLogger.info('Broadcasting', {
        count: changes.length,
        tables: Object.keys(
          changes.reduce((acc: Record<string, boolean>, c) => {
            acc[c.table] = true;
            return acc;
          }, {})
        ).length
      }, MODULE_NAME);
      
      // NOTE: Client notification has been refactored
      // Previously, this code attempted to notify clients in real-time via the Sync DO,
      // but that approach was replaced with a more reliable pull-based model where
      // clients query the change_history table directly when they reconnect.
      //
      // Changes are now stored in the change_history table by the replication system,
      // and clients will retrieve them on their next sync cycle based on their last known LSN.
      
      return;
    } catch (error) {
      replicationLogger.error('Broadcast failed', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      throw error;
    }
  }

  /**
   * Wake up a client with changes
   */
  private async wakeUpClient(
    clientId: string,
    changes: TableChange[]
  ): Promise<boolean> {
    try {
      replicationLogger.debug('Waking client', { clientId }, MODULE_NAME);
      
      // Get the client state from KV
      const clientKey = `client:${clientId}`;
      const value = await this.env.CLIENT_REGISTRY.get(clientKey);
      
      if (!value) {
        replicationLogger.warn('Client not found', { clientId }, MODULE_NAME);
        return false;
      }

      try {
        const state = JSON.parse(value);
        if (!state.active) {
          replicationLogger.debug('Skipping inactive client', { clientId }, MODULE_NAME);
          return false;
        }
        
        // Get the SyncDO instance
        const id = this.env.SYNC.idFromName(`client:${clientId}`);
        const syncDO = this.env.SYNC.get(id);
        
        // Send changes to the client
        replicationLogger.info('Sending changes', { 
          clientId, 
          count: changes.length 
        }, MODULE_NAME);
        
        // Create the URL with required parameters
        const url = new URL('http://internal/new-changes');
        url.searchParams.set('clientId', clientId);
        url.searchParams.set('lsn', '0/0'); // Default value when we don't have LSN info
        
        const response = await syncDO.fetch(url.toString(), {
          method: 'POST',
          body: JSON.stringify({ changes })
        });
        
        if (!response.ok) {
          replicationLogger.warn('Notification failed', { 
            clientId, 
            status: response.status
          }, MODULE_NAME);
          return false;
        }
        
        replicationLogger.debug('Notification sent', { 
          clientId, 
          count: changes.length 
        }, MODULE_NAME);
        return true;
      } catch (parseErr) {
        replicationLogger.error('State parse error', { 
          clientId,
          error: parseErr instanceof Error ? parseErr.message : String(parseErr) 
        }, MODULE_NAME);
        return false;
      }
    } catch (err) {
      replicationLogger.error('Notification error', {
        clientId,
        error: err instanceof Error ? err.message : String(err)
      }, MODULE_NAME);
      return false;
    }
  }

  /**
   * Compare two LSNs (Logical Sequence Numbers)
   * Returns true if lsn1 > lsn2, false otherwise
   */
  private compareLSNs(lsn1: string, lsn2: string): boolean {
    if (lsn1 === lsn2) return false;
    if (lsn2 === '0/0') return true;
    if (lsn1 === '0/0') return false;
    
    // Parse LSNs (format: "X/Y")
    const [major1, minor1] = lsn1.split('/').map(Number);
    const [major2, minor2] = lsn2.split('/').map(Number);
    
    // Compare major parts
    if (major1 !== major2) {
      return major1 > major2;
    }
    
    // If major parts are equal, compare minor parts
    return minor1 > minor2;
  }

  /**
   * List all clients in the registry
   */
  public async listClients(): Promise<ClientState[]> {
    try {
      const { keys } = await this.env.CLIENT_REGISTRY.list({ prefix: 'client:' });
      const clients: ClientState[] = [];
      
      for (const key of keys) {
        const value = await this.env.CLIENT_REGISTRY.get(key.name);
        if (!value) continue;
        
        try {
          const state = JSON.parse(value);
          clients.push({
            clientId: key.name.replace('client:', ''),
            active: state.active || false,
            lastSeen: state.lastSeen || 0
          });
        } catch (err) {
          replicationLogger.error('Client parse error', {
            key: key.name,
            error: err instanceof Error ? err.message : String(err)
          }, MODULE_NAME);
        }
      }
      
      replicationLogger.debug('Client listing complete', { 
        count: clients.length
      }, MODULE_NAME);
      
      return clients;
    } catch (error) {
      replicationLogger.error('Client listing failed', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      return [];
    }
  }

  /**
   * Get a client by ID
   */
  public async getClientById(clientId: string): Promise<ClientState | null> {
    try {
      const clientKey = `client:${clientId}`;
      const value = await this.env.CLIENT_REGISTRY.get(clientKey);
      
      if (!value) {
        return null;
      }
      
      try {
        const state = JSON.parse(value);
        return {
          clientId,
          active: state.active || false,
          lastSeen: state.lastSeen || 0
        };
      } catch (err) {
        replicationLogger.error('Client parse error', {
          clientId,
          error: err instanceof Error ? err.message : String(err)
        }, MODULE_NAME);
        return null;
      }
    } catch (error) {
      replicationLogger.error('Client retrieval failed', {
        clientId,
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      return null;
    }
  }

  /**
   * Attempt to wake a client via its DO
   */
  async wakeClient(clientId: string): Promise<boolean> {
    try {
      // Check if the client is in our registry
      const client = await this.getClientById(clientId);
      if (!client) {
        replicationLogger.warn('Client not found', { clientId }, MODULE_NAME);
        return false;
      }
      
      // Check if the client is still active
      if (!client.lastSeen || Date.now() - client.lastSeen > 300000) { // 5 minutes
        replicationLogger.debug('Skipping inactive client', { clientId }, MODULE_NAME);
        return false;
      }
      
      replicationLogger.debug('Waking client', { clientId }, MODULE_NAME);
      
      // Client should wake up on its next polling cycle
      return true;
    } catch (error) {
      replicationLogger.error('Wake failed', {
        clientId,
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      return false;
    }
  }
} 