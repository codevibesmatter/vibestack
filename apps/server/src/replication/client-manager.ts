import type { Env } from '../types/env';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { TableChange } from '@repo/sync-types';
import { replicationLogger } from '../middleware/logger';

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
 * Client state interface
 */
export interface ClientState {
  id: string;
  active: boolean;
  lastSeen?: string;
  lastLSN?: string;
}

/**
 * Manages client notifications and change filtering
 */
export class ClientManager {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Get all clients and their states
   */
  public async getClients(): Promise<ClientState[]> {
    try {
      const { keys } = await this.env.CLIENT_REGISTRY.list({ prefix: 'client:' });
      const clients: ClientState[] = [];
      
      for (const key of keys) {
        const value = await this.env.CLIENT_REGISTRY.get(key.name);
        if (!value) continue;

        const state = JSON.parse(value);
        clients.push({
          id: key.name.replace('client:', ''),
          active: state.active,
          lastSeen: state.lastSeen,
          lastLSN: state.lastLSN
        });
      }

      return clients;
    } catch (error) {
      replicationLogger.error('Failed to get clients:', error);
      return [];
    }
  }

  /**
   * Check if there are any active clients
   */
  public async hasActiveClients(): Promise<boolean> {
    try {
      const { keys } = await this.env.CLIENT_REGISTRY.list({ prefix: 'client:' });
      
      // Check each client's state until we find an active one
      for (const key of keys) {
        const value = await this.env.CLIENT_REGISTRY.get(key.name);
        if (!value) continue;

        const state = JSON.parse(value);
        if (state.active) {
          return true;
        }
      }

      return false;
    } catch (error) {
      replicationLogger.error('Failed to check for active clients:', error);
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

      // Notify each relevant client
      const firstLSN = changes[0].lsn;
      const lastLSN = changes[changes.length - 1].lsn;

      for (const clientId of clientsToNotify) {
        await this.wakeUpClient(clientId, changes, firstLSN, lastLSN);
      }
      
      replicationLogger.info('Notified clients about changes:', {
        event: 'replication.notify',
        clientCount: clientsToNotify.length,
        changeCount: changes.length,
        firstLSN,
        lastLSN
      });
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
    changes: TableChange[],
    firstLSN?: string,
    lastLSN?: string
  ): Promise<boolean> {
    try {
      // Get the client state from KV
      const value = await this.env.CLIENT_REGISTRY.get(`client:${clientId}`);
      if (!value) {
        replicationLogger.warn('Client not found in KV:', { clientId });
        return false;
      }

      const state = JSON.parse(value);
      if (!state.active) {
        replicationLogger.debug('Client is inactive:', { clientId });
        return false;
      }

      // Get the SyncDO instance
      const id = this.env.SYNC.idFromName(`client:${clientId}`);
      const syncDO = this.env.SYNC.get(id);
      
      // If we don't have LSN values or changes, just check if client is connected
      if (!firstLSN || !lastLSN || !changes) {
        const response = await syncDO.fetch('http://internal/metrics');
        return response.ok;
      }
      
      // Send changes to the client
      const url = new URL('http://internal/new-changes');
      url.searchParams.set('firstLSN', firstLSN);
      url.searchParams.set('lastLSN', lastLSN);
      
      const response = await syncDO.fetch(url.toString(), {
        method: 'POST',
        body: JSON.stringify({ changes })
      });
      
      if (!response.ok) {
        replicationLogger.warn('Failed to notify client:', { 
          clientId, 
          status: response.status
        });
      }
      
      return response.ok;
    } catch (err) {
      replicationLogger.error('Error notifying client:', {
        clientId,
        error: err instanceof Error ? err.message : String(err)
      });
      return false;
    }
  }
} 