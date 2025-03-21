import { replicationLogger } from '../middleware/logger';
import type { Env } from '../types/env';
import type { DurableObjectState } from '../types/cloudflare';
import type { TableChange } from '@repo/sync-types';

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
   * Handle changes and notify relevant clients
   */
  async handleChanges(changes: TableChange[]): Promise<void> {
    try {
      // Get all active clients from KV
      const { keys } = await this.env.CLIENT_REGISTRY.list({ prefix: 'client:' });
      const clientsToNotify: string[] = [];

      // Check each client's state
      for (const key of keys) {
        const value = await this.env.CLIENT_REGISTRY.get(key.name);
        if (!value) continue;

        const state = JSON.parse(value);
        if (!state.active) continue;

        const clientId = key.name.replace('client:', '');
        
        // Filter out clients that originated all the changes
        const clientChanges = changes.filter(change => 
          change.data?.client_id === clientId
        );

        if (clientChanges.length !== changes.length) {
          clientsToNotify.push(clientId);
        }
      }

      // Only proceed with notifications if we have clients to notify
      if (clientsToNotify.length > 0) {
        // Notify each relevant client
        let notifiedCount = 0;
        for (const clientId of clientsToNotify) {
          const success = await this.wakeUpClient(clientId, changes);
          if (success) notifiedCount++;
        }
        
        if (notifiedCount > 0) {
          replicationLogger.info('Clients notified', {
            notifiedCount,
            totalClients: clientsToNotify.length
          }, MODULE_NAME);
        }
      }
    } catch (error) {
      replicationLogger.error('Changes handling failed', {
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
        
        const response = await syncDO.fetch('http://internal/new-changes', {
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
} 