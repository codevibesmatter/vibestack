import type { Env, ExecutionContext } from '../types/env';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { 
  DurableObjectState, 
  DurableObjectId,
  DurableObjectStorage,
  DurableObjectTransaction,
  WebSocket 
} from '../types/cloudflare';
import type { ReplicationConfig, ReplicationMetrics } from './types';
import { DEFAULT_REPLICATION_CONFIG } from './types';
import { ClientManager } from './client-manager';
import { replicationLogger } from '../middleware/logger';
import { PollingManager, HIBERNATION_CHECK_INTERVAL } from './polling';
import { getDBClient } from '../lib/db';
import { SERVER_DOMAIN_TABLES } from '@repo/dataforge/server-entities';
import { AppBindings, createMinimalContext, MinimalContext } from '../types/hono';
import { StateManager } from './state-manager';

const MODULE_NAME = 'DO';

export class ReplicationDO implements DurableObject {
  private durableObjectState: DurableObjectState;
  private env: Env;
  private clientManager: ClientManager;
  private pollingManager: PollingManager;
  private stateManager: StateManager;
  private metrics: ReplicationMetrics;
  private config: ReplicationConfig = DEFAULT_REPLICATION_CONFIG;
  private static readonly LAST_ACTIVE_KEY = 'last_active_timestamp';

  constructor(state: DurableObjectState, env: Env) {
    this.durableObjectState = state;
    this.env = env;
    
    // Initialize managers
    this.clientManager = new ClientManager(env);
    this.stateManager = new StateManager(state, this.config);
    
    // Log wake-up - constructor is called when DO wakes from hibernation
    this.durableObjectState.blockConcurrencyWhile(async () => {
      const lastActive = await state.storage.get<number>(ReplicationDO.LAST_ACTIVE_KEY);
      if (lastActive) {
        const hibernationDuration = Date.now() - lastActive;
        replicationLogger.info('DO waking', {
          lastActiveAt: new Date(lastActive).toISOString(),
          hibernationSecs: Math.round(hibernationDuration / 1000)
        }, MODULE_NAME);
      } else {
        replicationLogger.info('DO starting', {}, MODULE_NAME);
      }
      // Update last active timestamp
      await state.storage.put(ReplicationDO.LAST_ACTIVE_KEY, Date.now());
    });

    this.metrics = {
      changes: {
        processed: 0,
        failed: 0
      },
      errors: new Map(),
      notifications: {
        totalNotificationsSent: 0
      }
    };

    const executionCtx: ExecutionContext = {
      waitUntil: (promise: Promise<any>) => this.durableObjectState.waitUntil(promise),
      passThroughOnException: () => {},
      props: undefined
    };
    
    // Create initial context
    const ctx = createMinimalContext(env, executionCtx);
    
    this.pollingManager = new PollingManager(
      this.clientManager,
      this.stateManager,
      this.config,
      ctx,
      this.durableObjectState
    );
  }

  private getContext(): MinimalContext {
    const executionCtx: ExecutionContext = {
      waitUntil: (promise: Promise<any>) => this.durableObjectState.waitUntil(promise),
      passThroughOnException: () => {},
      // Required by ExecutionContext but not used in our case
      props: undefined
    };

    return createMinimalContext(this.env, executionCtx);
  }

  /**
   * Main fetch handler for the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Create execution context
    const executionCtx: ExecutionContext = {
      waitUntil: (promise: Promise<any>) => this.durableObjectState.waitUntil(promise),
      passThroughOnException: () => {},
      props: undefined
    };
    
    const ctx = createMinimalContext(this.env, executionCtx);

    replicationLogger.debug('Request received', {
      path,
      method: request.method
    }, MODULE_NAME);

    // Handle all replication endpoints
    if (path.startsWith('/api/replication')) {
      const endpoint = path.replace('/api/replication', '');
      
      switch (endpoint) {
        case '/init':
          return this.handleInit();
        case '/status':
          return this.handleStatus();
        case '/clients':
          return this.handleClients();
      }
    }

    replicationLogger.warn('Unknown endpoint', { path }, MODULE_NAME);
    return new Response('Not found', { status: 404 });
  }

  /**
   * Core initialization logic for the replication system
   */
  private async initializeReplication(forceInit: boolean = false): Promise<{success: boolean, error?: string, slotStatus?: any}> {
    try {
      // Check if we're already initialized, unless forcing init
      if (!forceInit && this.pollingManager?.hasCompletedFirstPoll) {
        replicationLogger.info('Replication already initialized', {}, MODULE_NAME);
        const c = this.getContext();
        const slotStatus = await this.stateManager.checkSlotStatus(c);
        return {
          success: true,
          slotStatus
        };
      }

      // High level lifecycle event
      replicationLogger.info('Starting replication', {}, MODULE_NAME);
      
      // Let the modules handle their own logging
      const c = this.getContext();
      const slotStatus = await this.stateManager.checkSlotStatus(c);
      
      // Initialize polling manager if not already done
      if (!this.pollingManager) {
        this.pollingManager = new PollingManager(
          this.clientManager,
          this.stateManager,
          this.config,
          c,
          this.durableObjectState
        );
      }
      
      // Start polling and wait for initial poll to complete
      await this.pollingManager.startPolling();
      await this.pollingManager.waitForInitialPoll();

      // Even if we entered hibernation, initialization was successful
      return {
        success: true,
        slotStatus
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      replicationLogger.error('Replication start failed', { error: errorMessage }, MODULE_NAME);
      
      this.pollingManager.stopPolling();
      
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Initialize the replication system - HTTP endpoint handler
   */
  private async handleInit(): Promise<Response> {
    try {
      // Start initialization
      const result = await this.initializeReplication();
      if (!result.success) {
        return new Response(JSON.stringify(result), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        slotStatus: result.slotStatus
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replicationLogger.error('Init error', { error: errorMessage }, MODULE_NAME);
      return new Response(JSON.stringify({
        success: false,
        error: errorMessage
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Get replication status
   */
  private async handleStatus(): Promise<Response> {
    try {
      const c = this.getContext();
      const slotStatus = await this.stateManager.checkSlotStatus(c);
      
      return new Response(JSON.stringify({
        success: true,
        slotStatus
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replicationLogger.error('Status error', { error: errorMessage }, MODULE_NAME);
      return new Response(JSON.stringify({
        success: false,
        error: errorMessage
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Handle health check request
   */
  private async handleHealthCheck(request: Request): Promise<Response> {
    return new Response(JSON.stringify({
      success: true,
      message: 'Health check functionality removed'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Clean up resources when the Durable Object is about to hibernate
   */
  private async cleanup(): Promise<void> {
    try {
      // Update last active timestamp before hibernation
      const now = Date.now();
      await this.durableObjectState.storage.put(ReplicationDO.LAST_ACTIVE_KEY, now);
      
      // High level lifecycle event
      replicationLogger.info('Hibernation prep', {
        lastActiveAt: new Date(now).toISOString()
      }, MODULE_NAME);

      // Let polling manager handle its own cleanup logging
      await this.pollingManager.stopPolling();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      replicationLogger.error('Hibernation failed', {
        error: error.message
      }, MODULE_NAME);
      throw err;
    }
  }

  /**
   * Handle DO alarm - required for hibernation
   */
  async alarm(): Promise<void> {
    try {
      replicationLogger.info('Alarm triggered', {}, MODULE_NAME);

      // Force initialization on wake-up
      await this.initializeReplication(true);
    } catch (err) {
      replicationLogger.error('Alarm error', { 
        error: err instanceof Error ? err.message : String(err) 
      }, MODULE_NAME);
      // Ensure next alarm is set even if this one failed
      const nextCheck = Date.now() + HIBERNATION_CHECK_INTERVAL;
      await this.durableObjectState.storage.setAlarm(nextCheck);
      replicationLogger.info('Alarm reset', {
        nextCheck: new Date(nextCheck).toISOString()
      }, MODULE_NAME);
    }
  }

  private async handleTestNotify(): Promise<Response> {
    return new Response('Test notifications removed - clients manage their own state', { status: 200 });
  }

  private async handleWALConnection(request: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  private async handleSubscribeConnection(request: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  private async handleProcessChanges(request: Request): Promise<Response> {
    try {
      const body = await request.json();
      await this.pollingManager.startPolling();
      return new Response('Changes processed', { status: 200 });
    } catch (error) {
      return new Response('Failed to process changes', { status: 500 });
    }
  }

  private async handleCleanup(): Promise<Response> {
    try {
      await this.cleanup();
      return new Response('Cleaned up', { status: 200 });
    } catch (error) {
      return new Response('Cleanup failed', { status: 500 });
    }
  }

  private async handleStartPolling(): Promise<Response> {
    try {
      await this.pollingManager.startPolling();
      return new Response('Polling started', { status: 200 });
    } catch (error) {
      return new Response('Failed to start polling', { status: 500 });
    }
  }

  private async handleStopPolling(): Promise<Response> {
    try {
      this.pollingManager.stopPolling();
      return new Response('Polling stopped', { status: 200 });
    } catch (error) {
      return new Response('Failed to stop polling', { status: 500 });
    }
  }

  /**
   * Get list of clients via ClientManager
   */
  private async handleClients(): Promise<Response> {
    try {
      const clients = await this.clientManager.listClients();
      return Response.json(clients);
    } catch (error) {
      replicationLogger.error('Client listing failed', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      return Response.json({ error: 'Failed to get clients' }, { status: 500 });
    }
  }
} 