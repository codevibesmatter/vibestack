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
import { replicationLogger } from '../middleware/logger';
import { PollingManager } from './polling';
import { getDBClient } from '../lib/db';
import { SERVER_DOMAIN_TABLES } from '@repo/dataforge/server-entities';
import { AppBindings, createMinimalContext, MinimalContext } from '../types/hono';
import { StateManager } from './state-manager';
import { getActiveClients, hasActiveClients } from './process-changes';

const MODULE_NAME = 'DO';

export class ReplicationDO implements DurableObject {
  private durableObjectState: DurableObjectState;
  private env: Env;
  private pollingManager: PollingManager;
  private stateManager: StateManager;
  private metrics: ReplicationMetrics;
  private config: ReplicationConfig = DEFAULT_REPLICATION_CONFIG;
  private static readonly LAST_ACTIVE_KEY = 'last_active_timestamp';

  constructor(state: DurableObjectState, env: Env) {
    this.durableObjectState = state;
    this.env = env;
    
    // Initialize managers
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
      }
      
      // Record wake-up time
      await state.storage.put(ReplicationDO.LAST_ACTIVE_KEY, Date.now());
    });
    
    // Initialize metrics
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
    
    // Create execution context
    const executionCtx: ExecutionContext = {
      waitUntil: (promise: Promise<any>) => this.durableObjectState.waitUntil(promise),
      passThroughOnException: () => {},
      props: undefined
    };
    
    // Create initial context
    const ctx = createMinimalContext(env, executionCtx);
    
    this.pollingManager = new PollingManager(
      this.durableObjectState,
      this.config,
      ctx,
      this.env,
      this.stateManager
    );
    
    // Start polling immediately on construction
    this.durableObjectState.waitUntil(this.initializeReplication(true));
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
        case '/wait-for-initial-poll':
          return this.handleWaitForInitialPoll();
        case '/lsn':
          return this.handleLSN();
      }
    }

    // Handle internal endpoints (accessed by other DOs)
    if (path.startsWith('/internal') || path === '/lsn') {
      const internalPath = path === '/lsn' ? '/lsn' : path.replace('/internal', '');
      
      switch (internalPath) {
        case '/wait-for-initial-poll':
          return this.handleWaitForInitialPoll();
        case '/lsn':
          return this.handleLSN();
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
          this.durableObjectState,
          this.config,
          c,
          this.env,
          this.stateManager
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
   * Clean up resources before the Durable Object shuts down
   */
  private async cleanup(): Promise<void> {
    try {
      // Update last active timestamp 
      const now = Date.now();
      await this.durableObjectState.storage.put(ReplicationDO.LAST_ACTIVE_KEY, now);
      
      // Log clean shutdown
      replicationLogger.info('DO shutting down', {
        lastActiveAt: new Date(now).toISOString()
      }, MODULE_NAME);

      // Stop the polling interval
      await this.pollingManager.stopPolling();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      replicationLogger.error('Cleanup failed', {
        error: error.message
      }, MODULE_NAME);
      throw err;
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
   * Handle client listing request
   */
  private async handleClients(): Promise<Response> {
    const c = this.getContext();
    
    try {
      const clients = await getActiveClients(this.env);
      
      return new Response(JSON.stringify({
        success: true,
        clients
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    } catch (error) {
      replicationLogger.error('Failed to list clients', {
        error: error instanceof Error ? error.message : String(error)
      }, MODULE_NAME);
      
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
  }

  /**
   * Wait for initial poll to complete
   */
  private async handleWaitForInitialPoll(): Promise<Response> {
    try {
      if (!this.pollingManager) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Polling manager not initialized'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      replicationLogger.debug('Waiting for initial poll to complete', {}, MODULE_NAME);
      await this.pollingManager.waitForInitialPoll();
      replicationLogger.info('Initial poll completed', {}, MODULE_NAME);
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Initial poll completed'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replicationLogger.error('Wait for initial poll error', { error: errorMessage }, MODULE_NAME);
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
   * Get current LSN - HTTP endpoint handler
   */
  private async handleLSN(): Promise<Response> {
    try {
      const currentLSN = await this.stateManager.getLSN();
      
      return new Response(JSON.stringify({
        success: true,
        lsn: currentLSN
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replicationLogger.error('LSN fetch error', { error: errorMessage }, MODULE_NAME);
      
      return new Response(JSON.stringify({
        success: false,
        error: errorMessage,
        lsn: '0/0' // Default fallback
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
} 