import type { Env } from '../types/env';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { ExecutionContext } from '@cloudflare/workers-types';
import type { ReplicationConfig, ReplicationMetrics } from './types';
import { 
  getSlotStatus, 
  DEFAULT_REPLICATION_CONFIG,
  peekSlotHistory
} from './index';
import { performHealthCheck, performInitialCleanup, verifyChanges } from './health-check';
import { ClientManager } from './client-manager';
import { replicationLogger } from '../middleware/logger';
import { StateManager } from './state-manager';
import { PollingManager } from './polling';
import { getDBClient } from '../lib/db';
import { SERVER_DOMAIN_TABLES } from '@repo/typeorm/server-entities';
import { AppBindings, createMinimalContext, MinimalContext } from '../types/hono';

export class ReplicationDO implements DurableObject {
  private durableObjectState: DurableObjectState;
  private env: Env;
  private stateManager: StateManager;
  private clientManager: ClientManager;
  private pollingManager: PollingManager;
  private metrics: ReplicationMetrics;
  private config: ReplicationConfig = DEFAULT_REPLICATION_CONFIG;
  private static readonly LAST_ACTIVE_KEY = 'last_active_timestamp';

  constructor(state: DurableObjectState, env: Env) {
    this.durableObjectState = state;
    this.env = env;
    
    // Initialize managers
    this.stateManager = new StateManager(state);
    this.clientManager = new ClientManager(env);
    
    // Log wake-up - constructor is called when DO wakes from hibernation
    this.durableObjectState.blockConcurrencyWhile(async () => {
      const lastActive = await state.storage.get<number>(ReplicationDO.LAST_ACTIVE_KEY);
      if (lastActive) {
        const hibernationDuration = Date.now() - lastActive;
        replicationLogger.info('DO waking from hibernation', {
          event: 'do.wake',
          lastActiveAt: new Date(lastActive).toISOString(),
          hibernationDuration,
          hibernationDurationSeconds: (hibernationDuration / 1000).toFixed(1),
          trigger: 'constructor'
        });
      } else {
        replicationLogger.info('DO starting for first time', {
          event: 'do.start',
          trigger: 'constructor'
        });
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
    
    this.pollingManager = new PollingManager(
      this.stateManager,
      this.clientManager,
      this.config,
      createMinimalContext(env, executionCtx),
      state
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

    replicationLogger.info('ReplicationDO handling request:', {
      path,
      method: request.method
    });

    // Handle all replication endpoints
    if (path.startsWith('/api/replication')) {
      const endpoint = path.replace('/api/replication', '');
      
      switch (endpoint) {
        case '/init':
          return this.handleInit();
        case '/health':
          return this.handleHealthCheck(request);
        case '/cleanup':
          return this.handleInitialCleanup(request);
        case '/verify':
          return this.handleVerifyChanges(request);
        case '/status':
          return this.handleStatus();
        case '/clients':
          return this.handleClients();
        case '/clients/cleanup':
          return this.handleClientsCleanup();
        case '/peek': {
          const fromLSN = url.searchParams.get('from_lsn') || '0/0';
          const limit = parseInt(url.searchParams.get('limit') || '100', 10);
          
          try {
            const history = await peekSlotHistory(ctx, this.config.slot, fromLSN, limit);
            return Response.json(history);
          } catch (error) {
            replicationLogger.error('Peek history failed:', error);
            return Response.json({
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }, { status: 500 });
          }
        }
      }
    }

    replicationLogger.warn('No matching endpoint:', { path });
    return new Response('Not found', { status: 404 });
  }

  /**
   * Core initialization logic for the replication system
   */
  private async initializeReplication(): Promise<{success: boolean, error?: string, slotStatus?: any}> {
    try {
      // Check if we're already initialized
      if (this.pollingManager?.hasCompletedFirstPoll) {
        replicationLogger.info('Replication system already initialized');
        const c = this.getContext();
        const slotStatus = await getSlotStatus(c, this.config.slot);
        return {
          success: true,
          slotStatus
        };
      }

      // High level lifecycle event
      replicationLogger.info('Starting replication system');
      
      // Let the modules handle their own logging
      const c = this.getContext();
      const slotStatus = await getSlotStatus(c, this.config.slot);
      
      // Initialize polling manager if not already done
      if (!this.pollingManager) {
        this.pollingManager = new PollingManager(
          this.stateManager,
          this.clientManager,
          this.config,
          c,
          this.durableObjectState
        );
      }
      
      // Start polling and wait for initial poll to complete
      await this.pollingManager.startPolling();
      await this.pollingManager.waitForInitialPoll();
      
      return {
        success: true,
        slotStatus
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      replicationLogger.error('Failed to start replication system:', { error: errorMessage });
      
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

      // Get final state
      const state = await this.stateManager.loadState();
      
      return new Response(JSON.stringify({
        success: true,
        slotStatus: result.slotStatus,
        state
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replicationLogger.error('Error during initialization:', { error: errorMessage });
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
      const slotStatus = await getSlotStatus(c, this.config.slot);
      
      return new Response(JSON.stringify({
        slot: {
          name: this.config.slot,
          status: slotStatus
        },
        metrics: this.metrics
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replicationLogger.error('Error getting replication status:', { error: errorMessage });
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
    try {
      const result = await performHealthCheck(this.getContext());
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replicationLogger.error('Error performing health check:', { error: errorMessage });
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
   * Handle verify changes request
   */
  private async handleVerifyChanges(request: Request): Promise<Response> {
    try {
      const result = await verifyChanges(this.getContext());
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replicationLogger.error('Error verifying changes:', { error: errorMessage });
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
   * Handle initial cleanup request
   */
  private async handleInitialCleanup(request: Request): Promise<Response> {
    try {
      const result = await performInitialCleanup(this.getContext());
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replicationLogger.error('Error performing initial cleanup:', { error: errorMessage });
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
   * Clean up resources when the Durable Object is about to hibernate
   */
  private async cleanup(): Promise<void> {
    try {
      // Update last active timestamp before hibernation
      const now = Date.now();
      await this.durableObjectState.storage.put(ReplicationDO.LAST_ACTIVE_KEY, now);
      
      // High level lifecycle event
      replicationLogger.info('DO preparing for hibernation', {
        event: 'do.hibernate',
        lastActiveAt: new Date(now).toISOString()
      });

      // Let polling manager handle its own cleanup logging
      await this.pollingManager.stopPolling();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      replicationLogger.error('Failed to hibernate DO', {
        event: 'do.hibernate.error',
        error: error.message,
        stack: error.stack
      });
      throw err;
    }
  }

  /**
   * Handle DO alarm - called when waking from hibernation
   */
  async alarm(): Promise<void> {
    try {
      // Log wake-up from alarm - this is a DO lifecycle event
      const lastActive = await this.durableObjectState.storage.get<number>(ReplicationDO.LAST_ACTIVE_KEY);
      const now = Date.now();
      
      if (lastActive) {
        const hibernationDuration = now - lastActive;
        replicationLogger.info('DO waking from hibernation', {
          event: 'do.wake',
          lastActiveAt: new Date(lastActive).toISOString(),
          hibernationDuration,
          hibernationDurationSeconds: (hibernationDuration / 1000).toFixed(1),
          trigger: 'alarm'
        });
      }
      
      // Update last active timestamp
      await this.durableObjectState.storage.put(ReplicationDO.LAST_ACTIVE_KEY, now);
      
      // Let the initialization process handle its own logging
      const initResult = await this.initializeReplication();
      
      if (!initResult.success) {
        replicationLogger.error('Failed to initialize DO after wake-up:', { error: initResult.error });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      replicationLogger.error('Error in DO alarm handler', {
        event: 'do.alarm.error',
        error: error.message,
        stack: error.stack
      });
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
   * Get list of active clients
   */
  private async handleClients(): Promise<Response> {
    try {
      const clients = await this.clientManager.getClients();
      return Response.json(clients);
    } catch (error) {
      replicationLogger.error('Error getting clients:', error);
      return Response.json({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }, { status: 500 });
    }
  }

  /**
   * Clean up all clients by marking them as inactive
   */
  private async handleClientsCleanup(): Promise<Response> {
    try {
      const result = await this.clientManager.cleanupClients();
      return Response.json({
        success: true,
        ...result
      });
    } catch (error) {
      replicationLogger.error('Error cleaning up clients:', error);
      return Response.json({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }, { status: 500 });
    }
  }
} 