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
  private static readonly CLIENT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Get all clients from KV registry
   */
  public async getClients(): Promise<ClientState[]> {
    try {
      replicationLogger.info('Fetching all clients from registry', undefined, MODULE_NAME);
      const { keys } = await this.env.CLIENT_REGISTRY.list({ prefix: 'client:' });
      replicationLogger.info('Client keys found in registry', { count: keys.length, keys: keys.map((k: any) => k.name) }, MODULE_NAME);
      
      const clients: ClientState[] = [];
      
      for (const key of keys) {
        replicationLogger.debug('Retrieving client data', { key: key.name }, MODULE_NAME);
        const value = await this.env.CLIENT_REGISTRY.get(key.name);
        
        if (!value) {
          replicationLogger.warn('Client key exists but no value found', { key: key.name }, MODULE_NAME);
          continue;
        }
        
        try {
          const state = JSON.parse(value);
          replicationLogger.debug('Client data retrieved', {
            clientId: key.name.replace('client:', ''),
            active: state.active,
            lastSeen: state.lastSeen
          }, MODULE_NAME);
          
          clients.push({
            clientId: key.name.replace('client:', ''),
            active: !!state.active,
            lastSeen: state.lastSeen || 0
          });
        } catch (err) {
          replicationLogger.error('Failed to parse client state', {
            key: key.name,
            value,
            error: err instanceof Error ? err.message : String(err)
          }, MODULE_NAME);
        }
      }
      
      replicationLogger.info('Clients retrieved from registry', {
        totalFound: clients.length,
        activeCount: clients.filter(c => c.active).length
      }, MODULE_NAME);
      
      return clients;
    } catch (error) {
      replicationLogger.error('Failed to get clients:', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      return [];
    }
  }

  /**
   * Check if there are any active clients
   */
  public async hasActiveClients(): Promise<boolean> {
    try {
      replicationLogger.info('Checking for active clients', undefined, MODULE_NAME);
      const { keys } = await this.env.CLIENT_REGISTRY.list({ prefix: 'client:' });
      replicationLogger.info('Client keys found in registry', { count: keys.length }, MODULE_NAME);
      
      if (keys.length === 0) {
        replicationLogger.warn('No client keys found in registry', undefined, MODULE_NAME);
        return false;
      }
      
      let hasActive = false;
      const now = Date.now();
      
      // Check each client's state and clean up stale ones
      for (const key of keys) {
        replicationLogger.debug('Checking client state', { key: key.name }, MODULE_NAME);
        const value = await this.env.CLIENT_REGISTRY.get(key.name);
        
        if (!value) {
          replicationLogger.warn('Client key exists but no value found', { key: key.name }, MODULE_NAME);
          // Clean up empty key
          await this.env.CLIENT_REGISTRY.delete(key.name);
          continue;
        }

        try {
          const state = JSON.parse(value);
          const lastSeen = state.lastSeen || 0;
          const isStale = now - lastSeen > ClientManager.CLIENT_TIMEOUT;
          
          replicationLogger.debug('Client state parsed', { 
            key: key.name,
            active: state.active,
            lastSeen,
            isStale,
            timeSinceLastSeen: now - lastSeen
          }, MODULE_NAME);
          
          if (state.active && !isStale) {
            replicationLogger.info('Found active client', { 
              clientId: key.name.replace('client:', ''),
              lastSeen: state.lastSeen
            }, MODULE_NAME);
            hasActive = true;
          } else if (isStale) {
            // Remove stale client
            replicationLogger.info('Removing stale client', {
              clientId: key.name.replace('client:', ''),
              lastSeen: state.lastSeen,
              timeSinceLastSeen: now - lastSeen
            }, MODULE_NAME);
            await this.env.CLIENT_REGISTRY.delete(key.name);
          }
        } catch (err) {
          replicationLogger.error('Failed to parse client state', {
            key: key.name,
            error: err instanceof Error ? err.message : String(err)
          }, MODULE_NAME);
        }
      }
      
      if (!hasActive) {
        replicationLogger.info('No active clients found after cleanup', undefined, MODULE_NAME);
      }
      
      return hasActive;
    } catch (error) {
      replicationLogger.error('Failed to check for active clients:', {
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
          replicationLogger.info('Successfully notified clients:', {
            event: 'replication.notify.success',
            notifiedCount,
            totalClients: clientsToNotify.length
          });
        }
      }
    } catch (error) {
      replicationLogger.error('Failed to handle changes:', error);
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
      replicationLogger.info('Attempting to wake up client', { clientId });
      
      // Get the client state from KV
      const clientKey = `client:${clientId}`;
      replicationLogger.debug('Looking up client in registry', { clientKey });
      
      const value = await this.env.CLIENT_REGISTRY.get(clientKey);
      if (!value) {
        replicationLogger.warn('Client not found in KV registry', { 
          clientId,
          clientKey
        });
        return false;
      }

      try {
        const state = JSON.parse(value);
        replicationLogger.debug('Client state retrieved', { 
          clientId, 
          active: state.active,
          lastSeen: state.lastSeen
        });
        
        if (!state.active) {
          replicationLogger.debug('Client is inactive, skipping notification', { clientId });
          return false;
        }
        
        // Get the SyncDO instance
        const id = this.env.SYNC.idFromName(`client:${clientId}`);
        replicationLogger.debug('Created SyncDO ID for client', { 
          clientId, 
          syncDoId: id.toString() 
        });
        
        const syncDO = this.env.SYNC.get(id);
        
        // Send changes to the client
        replicationLogger.info('Sending changes to client', { 
          clientId, 
          changeCount: changes.length 
        });
        
        const response = await syncDO.fetch('http://internal/new-changes', {
          method: 'POST',
          body: JSON.stringify({ changes })
        });
        
        if (!response.ok) {
          replicationLogger.warn('Failed to notify client:', { 
            clientId, 
            status: response.status,
            statusText: response.statusText
          });
          return false;
        }
        
        replicationLogger.info('Client successfully notified of changes', { 
          clientId, 
          changeCount: changes.length 
        });
        return true;
      } catch (parseErr) {
        replicationLogger.error('Failed to parse client state', { 
          clientId, 
          value, 
          error: parseErr instanceof Error ? parseErr.message : String(parseErr) 
        });
        return false;
      }
    } catch (err) {
      replicationLogger.error('Error notifying client:', {
        clientId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      return false;
    }
  }
} 