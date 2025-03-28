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
import { getAllClientIds } from './process-changes';

const MODULE_NAME = 'DO';

export class ReplicationDO implements DurableObject {
  private durableObjectState: DurableObjectState;
  private env: Env;
  private pollingManager: PollingManager;
  private stateManager: StateManager;
  private metrics: ReplicationMetrics;
  private config: ReplicationConfig = DEFAULT_REPLICATION_CONFIG;

  constructor(state: DurableObjectState, env: Env) {
    this.durableObjectState = state;
    this.env = env;
    
    // Initialize managers
    this.stateManager = new StateManager(state, this.config);
    
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
    
    // Create initial context and polling manager
    const ctx = createMinimalContext(env, {
      waitUntil: (promise: Promise<any>) => this.durableObjectState.waitUntil(promise),
      passThroughOnException: () => {},
      props: undefined
    });
    
    this.pollingManager = new PollingManager(
      this.durableObjectState,
      this.config,
      ctx,
      this.env,
      this.stateManager
    );
    
    // Initialize the replication system in the background
    // This will check if the slot exists and start polling immediately
    this.durableObjectState.waitUntil(
      this.initializeAndStartPolling()
    );
  }

  private getContext(): MinimalContext {
    return createMinimalContext(this.env, {
      waitUntil: (promise: Promise<any>) => this.durableObjectState.waitUntil(promise),
      passThroughOnException: () => {},
      props: undefined
    });
  }

  /**
   * Initialize replication and start polling immediately
   * This ensures polling is active as soon as the DO is created
   */
  private async initializeAndStartPolling(): Promise<void> {
    try {
      replicationLogger.info('Auto-initializing replication system', {}, MODULE_NAME);
      
      // Check if slot exists or create it
      const c = this.getContext();
      const slotStatus = await this.stateManager.checkSlotStatus(c);
      
      // Use debug instead of info to reduce duplicate logs
      replicationLogger.debug('Replication slot check completed', {
        slotExists: slotStatus.exists
      }, MODULE_NAME);
      
      // Start polling immediately - the polling manager will log its own status
      await this.pollingManager.startPolling();
      
      // Log successful initialization at debug level only
      replicationLogger.debug('Auto-initialization completed', {}, MODULE_NAME);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      replicationLogger.error('Failed to auto-initialize replication', { 
        error: errorMessage 
      }, MODULE_NAME);
      
      // Even on error, attempt to start polling
      // This provides resilience - polling will skip problematic slots
      try {
        await this.pollingManager.startPolling();
      } catch (pollErr) {
        replicationLogger.error('Failed to start polling after initialization error', {
          error: pollErr instanceof Error ? pollErr.message : String(pollErr)
        }, MODULE_NAME);
      }
    }
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
        case '/lsn':
          return this.handleLSN();
      }
    }

    // Handle internal endpoints (accessed by other DOs)
    if (path.startsWith('/internal') || path === '/lsn') {
      const internalPath = path === '/lsn' ? '/lsn' : path.replace('/internal', '');
      
      switch (internalPath) {
        case '/lsn':
          return this.handleLSN();
      }
    }

    replicationLogger.warn('Unknown endpoint', { path }, MODULE_NAME);
    return new Response('Not found', { status: 404 });
  }

  /**
   * Core initialization logic for the replication system
   * Only checks if the slot exists, doesn't start polling
   */
  private async initializeReplication(): Promise<{success: boolean, error?: string, slotStatus?: any}> {
    try {
      // Check if slot exists or create it if needed
      replicationLogger.info('Starting replication slot check', {}, MODULE_NAME);
      const c = this.getContext();
      const slotStatus = await this.stateManager.checkSlotStatus(c);
      
      replicationLogger.info('Replication slot check completed', {
        slotExists: slotStatus.exists
      }, MODULE_NAME);

      return {
        success: true, 
        slotStatus
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      replicationLogger.error('Replication slot check failed', { error: errorMessage }, MODULE_NAME);
      
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Initialize the replication system - HTTP endpoint handler
   * First checks slot, then starts polling
   */
  private async handleInit(): Promise<Response> {
    try {
      // Check if polling is already initialized and active first - this is a very fast check
      // since it just checks memory state, no database calls needed
      const isAlreadyPolling = this.pollingManager.hasCompletedFirstPoll;
      
      if (isAlreadyPolling) {
        replicationLogger.debug('API: Replication already initialized', {}, MODULE_NAME);
        
        return new Response(JSON.stringify({
          success: true,
          pollingStarted: true,
          alreadyInitialized: true
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // If not already polling, perform full initialization including slot check
      // This is the same flow as the auto-initialization but returns a Response
      try {
        replicationLogger.info('API: Initializing replication', {}, MODULE_NAME);
        
        // Check if slot exists or create it
        const c = this.getContext();
        const slotStatus = await this.stateManager.checkSlotStatus(c);
        
        // Start polling - PollingManager will handle its own logging
        await this.pollingManager.startPolling();
        
        return new Response(JSON.stringify({
          success: true,
          slotStatus,
          pollingStarted: true
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        replicationLogger.error('API: Failed to initialize replication', { 
          error: errorMessage 
        }, MODULE_NAME);
        
        return new Response(JSON.stringify({
          success: false,
          error: errorMessage
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
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
      const currentLSN = await this.stateManager.getLSN();
      
      // Get polling status information
      const pollingActive = this.pollingManager.hasCompletedFirstPoll;
      const pollCount = this.pollingManager.getPollCount ? this.pollingManager.getPollCount() : 0;
      const pollingDuration = pollingActive && pollCount > 0 
        ? `${Math.floor(pollCount / 60)} minutes (${pollCount} polls)` 
        : "inactive";
      
      return new Response(JSON.stringify({
        success: true,
        slotStatus,
        currentLSN,
        polling: {
          active: pollingActive,
          count: pollCount,
          duration: pollingDuration
        }
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
      // Log clean shutdown
      replicationLogger.info('DO shutting down', {}, MODULE_NAME);

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
      const clientIds = await getAllClientIds(this.env);
      
      return new Response(JSON.stringify({
        success: true,
        clients: clientIds.map((id: string) => ({ clientId: id }))
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