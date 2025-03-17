import type { DurableObjectState, ExecutionContext } from '@cloudflare/workers-types';
import type { Env } from '../types/env';
import type { MinimalContext } from '../types/hono';
import type { SyncMetrics } from './types';
import { syncLogger } from '../middleware/logger';

const TTL = 86400; // 24-hour TTL as a safety measure

/**
 * Manages state for a SyncDO instance.
 * Each DO instance handles a single client's state.
 */
export class SyncStateManager {
  private state: DurableObjectState;
  private env: Env;
  private executionCtx: ExecutionContext;
  private metrics: SyncMetrics;
  private lastLSN: string;
  private clientId: string | null;

  constructor(context: MinimalContext, state: DurableObjectState) {
    this.state = state;
    this.env = context.env;
    this.executionCtx = context.executionCtx;
    
    // Initialize with default values
    this.metrics = {
      errors: new Map(),
      connections: {
        total: 0,
        active: 0,
        hibernated: 0
      }
    };
    
    // Initialize state from active WebSocket if any
    this.lastLSN = '0/0';
    this.clientId = null;
    
    const websockets: any[] = this.state.getWebSockets();
    if (websockets.length > 0) {
      const ws: any = websockets[0]; // There should only be one
      if (ws?.clientData?.clientId) {
        this.clientId = ws.clientData.clientId;
        this.lastLSN = ws.clientData.lastLSN || '0/0';
      }
    }
  }

  /**
   * Track an error in ephemeral metrics
   */
  trackError(error: Error): void {
    if (!this.clientId) return;

    const errorKey = `${this.clientId}:${error.name}`;
    const existing = this.metrics.errors.get(errorKey) || { 
      count: 0, 
      lastError: '', 
      timestamp: 0 
    };

    this.metrics.errors.set(errorKey, {
      count: existing.count + 1,
      lastError: error.message,
      timestamp: Date.now()
    });
  }

  /**
   * Get current ephemeral metrics
   */
  getMetrics(): SyncMetrics {
    return this.metrics;
  }

  /**
   * Get current LSN
   */
  getLSN(): string {
    return this.lastLSN;
  }

  /**
   * Set current LSN
   */
  setLSN(lsn: string): void {
    this.lastLSN = lsn;
  }

  /**
   * Get current client ID
   */
  getClientId(): string | null {
    return this.clientId;
  }

  /**
   * Set current client ID and update KV registry
   */
  async registerClient(clientId: string): Promise<void> {
    this.clientId = clientId;
    
    try {
      await this.env.CLIENT_REGISTRY.put(
        `client:${clientId}`,
        JSON.stringify({
          lastActive: Date.now(),
          lastLSN: this.lastLSN,
          active: true
        }),
        { expirationTtl: TTL }
      );
      
      syncLogger.debug('Registered client', {
        clientId,
        lastLSN: this.lastLSN
      });
    } catch (err) {
      syncLogger.error('Failed to register client', err);
      throw err;
    }
  }

  /**
   * Update KV registry when client disconnects
   */
  async unregisterClient(): Promise<void> {
    if (!this.clientId) return;
    
    try {
      await this.env.CLIENT_REGISTRY.put(
        `client:${this.clientId}`,
        JSON.stringify({
          lastActive: Date.now(),
          lastLSN: this.lastLSN,
          active: false
        }),
        { expirationTtl: TTL }
      );
      
      syncLogger.debug('Unregistered client', { 
        clientId: this.clientId 
      });
      
      this.clientId = null;
    } catch (err) {
      syncLogger.error('Failed to unregister client', err);
      throw err;
    }
  }
} 