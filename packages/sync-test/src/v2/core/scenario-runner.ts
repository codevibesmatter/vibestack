import { EventEmitter } from 'events';
import { createLogger } from './logger.ts';
import { TestConfig } from '../types.ts';
import { ClientProfileManager } from './client-profile-manager.ts';
import { ValidationService } from './validation-service.ts';
import { wsClientFactory, WebSocketClientFactory } from './ws-client-factory.ts';
import * as dbService from './db-service.ts';
import fetch, { RequestInit as FetchRequestInit } from 'node-fetch';
import { API_CONFIG } from '../config.ts';

/**
 * Interface defining a test scenario
 */
export interface Scenario {
  name: string;
  description: string;
  config: TestConfig;
  
  // Test steps
  steps: Array<StepDefinition>;
  
  // Optional hooks
  hooks?: {
    beforeScenario?: (context: any) => Promise<void>;
    afterScenario?: (context: any) => Promise<void>;
    beforeStep?: (step: any, context: any) => Promise<void>;
    afterStep?: (step: any, context: any) => Promise<void>;
  };
}

/**
 * Base step definition interface
 */
export interface StepDefinition {
  name: string;
  execution: 'serial' | 'parallel';  // How this step is executed
  actions: Array<Action>;            // Actions to execute (serially or in parallel)
  
  // Optional waiting after all actions complete
  waitFor?: {
    event?: string;        // Event to wait for
    timeout?: number;      // Timeout in ms
  };
}

/**
 * Base action interface - parent type for all actions
 */
export interface Action {
  type: 'api' | 'db' | 'ws' | 'interactive' | 'composite';  // Action type
  name?: string;                                            // Optional name for logging/reference
}

/**
 * API Action - makes HTTP requests
 */
export interface ApiAction extends Action {
  type: 'api';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';  // HTTP method
  endpoint: string;                          // API endpoint
  body?: any;                                // Request body
  headers?: Record<string, string>;          // Request headers
}

/**
 * Database Action - performs database operations
 */
export interface DbAction extends Action {
  type: 'db';
  operation: string;       // Operation name (createChanges, etc.)
  params?: any;            // Operation parameters or function for 'exec' operation
}

/**
 * WebSocket Action - performs WebSocket operations
 */
export interface WSAction extends Action {
  type: 'ws';
  operation: string;       // Operation name (createClient, connect, send, etc.)
  clientId?: string;       // Target client ID (if applicable)
  params?: any;            // Operation parameters
  
  // Optional waiting for response
  waitFor?: {
    type: string;          // Message type to wait for
    timeout?: number;      // Timeout in ms
  };
}

/**
 * Interactive Protocol - complex back-and-forth message handling
 */
export interface InteractiveAction extends Action {
  type: 'interactive';
  protocol: string;            // Protocol name for logging
  maxTimeout: number;          // Maximum time to wait for completion
  
  // Optional initial action
  initialAction?: ApiAction | DbAction | WSAction;
  
  // Message handlers
  handlers: Record<string, (message: any, context: any, operations: any) => Promise<boolean> | boolean>;
}

/**
 * Composite Action - nest parallel and serial executions
 */
export interface CompositeAction extends Action {
  type: 'composite';
  execution: 'serial' | 'parallel';  // How sub-actions are executed
  actions: Array<Action>;            // Sub-actions to execute
}

// Create a type for DB operations
type DbServiceType = typeof dbService & {
  [key: string]: (...args: any[]) => Promise<any>;
};

// Type for dynamic WS client operations
type WsClientFactoryType = WebSocketClientFactory & {
  [key: string]: (...args: any[]) => Promise<any>;
};

// Cast services to indexable types
const typedDbService = dbService as DbServiceType;
const typedWsClientFactory = wsClientFactory as WsClientFactoryType;

/**
 * Context type for operations
 */
export interface OperationContext {
  runner: ScenarioRunner;
  config: TestConfig;
  state: Record<string, any>;
  logger: any;
  operations: Record<string, any>;
}

/**
 * ScenarioRunner - Orchestrates the execution of test scenarios
 */
export class ScenarioRunner extends EventEmitter {
  protected logger = createLogger('Runner');
  protected validationService: ValidationService;
  protected profileManager: ClientProfileManager;
  
  constructor() {
    super(); // Initialize EventEmitter
    
    // Initialize validation service with default options
    this.validationService = new ValidationService();
    this.profileManager = new ClientProfileManager();
    
    this.logger.info('ScenarioRunner created with direct implementation');
  }
  
  /**
   * Run a scenario
   */
  async runScenario(scenario: Scenario): Promise<void> {
    this.logger.info(`Running scenario: ${scenario.name}`);
    
    try {
      // Create context for sharing state
      const context = {
        runner: this,
        config: scenario.config,
        state: {
          clients: new Map(), // Store client IDs
          lsn: null           // Current LSN
        },
        logger: this.logger,
        validationService: this.validationService,
        operations: {
          // API operations
          api: {
            get: this.apiGet.bind(this),
            post: this.apiPost.bind(this),
            put: this.apiPut.bind(this),
            delete: this.apiDelete.bind(this)
          },
          // DB operations
          db: {
            initialize: dbService.initializeDatabase.bind(dbService),
            initializeReplication: dbService.initializeReplication.bind(dbService),
            getCurrentLSN: dbService.getCurrentLSN.bind(dbService),
            createChanges: dbService.createChanges.bind(dbService),
            createChangeBatch: dbService.createChangeBatch.bind(dbService),
            clearDatabase: dbService.clearDatabase.bind(dbService)
          },
          // WebSocket operations
          ws: {
            createClient: wsClientFactory.createClient.bind(wsClientFactory),
            connectClient: wsClientFactory.connectClient.bind(wsClientFactory),
            setupClient: wsClientFactory.setupClient.bind(wsClientFactory),
            sendMessage: wsClientFactory.sendMessage.bind(wsClientFactory),
            disconnectClient: wsClientFactory.disconnectClient.bind(wsClientFactory),
            addMessageHandler: wsClientFactory.addMessageHandler.bind(wsClientFactory),
            removeMessageHandler: wsClientFactory.removeMessageHandler.bind(wsClientFactory),
            waitForCatchup: wsClientFactory.waitForCatchup.bind(wsClientFactory)
          }
        }
      };
      
      // Reset validation service for this scenario
      this.validationService.reset();
      
      // Run before scenario hook if defined
      if (scenario.hooks?.beforeScenario) {
        await scenario.hooks.beforeScenario(context);
      }
      
      // Execute each step in sequence
      for (const step of scenario.steps) {
        await this.executeStep(step, context);
      }
      
      // Run after scenario hook if defined
      if (scenario.hooks?.afterScenario) {
        await scenario.hooks.afterScenario(context);
      }
      
      this.logger.info(`Scenario completed: ${scenario.name}`);
      
    } catch (error) {
      this.logger.error(`Scenario failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  
  /**
   * Execute a step
   */
  async executeStep(step: StepDefinition, context: any): Promise<void> {
    this.logger.info(`Executing step: ${step.name} (${step.execution})`);
    
    try {
      // Run before step hook if defined
      if (context.runner && context.runner.hooks?.beforeStep) {
        await context.runner.hooks.beforeStep(step, context);
      }
      
      // Execute actions based on execution mode
      if (step.execution === 'parallel') {
        await this.executeParallelActions(step.actions, context);
      } else {
        await this.executeSerialActions(step.actions, context);
      }
      
      // Wait for event if specified
      if (step.waitFor && step.waitFor.event) {
        await this.waitForEvent(step.waitFor.event, step.waitFor.timeout || 5000, context);
      }
      
      // Run after step hook if defined
      if (context.runner && context.runner.hooks?.afterStep) {
        await context.runner.hooks.afterStep(step, context);
      }
      
      this.logger.info(`Step completed: ${step.name}`);
    } catch (error) {
      this.logger.error(`Step failed: ${step.name} - ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  
  /**
   * Execute actions in parallel
   */
  async executeParallelActions(actions: Action[], context: any): Promise<void> {
    this.logger.info(`Executing ${actions.length} actions in parallel`);
    
    const promises = actions.map(action => this.executeAction(action, context));
    await Promise.all(promises);
  }
  
  /**
   * Execute actions serially
   */
  async executeSerialActions(actions: Action[], context: any): Promise<void> {
    this.logger.info(`Executing ${actions.length} actions serially`);
    
    for (const action of actions) {
      await this.executeAction(action, context);
    }
  }
  
  /**
   * Execute a single action
   */
  async executeAction(action: Action, context: any): Promise<any> {
    this.logger.info(`Executing action: ${action.name || action.type}`);
    
    try {
      switch (action.type) {
        case 'api':
          return await this.executeApiAction(action as ApiAction, context);
        
        case 'db':
          return await this.executeDbAction(action as DbAction, context);
        
        case 'ws':
          return await this.executeWSAction(action as WSAction, context);
        
        case 'interactive':
          return await this.executeInteractiveAction(action as InteractiveAction, context);
        
        case 'composite':
          return await this.executeCompositeAction(action as CompositeAction, context);
        
        default:
          throw new Error(`Unsupported action type: ${(action as any).type}`);
      }
    } catch (error) {
      this.logger.error(`Action failed: ${action.name || action.type} - ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  
  /**
   * Execute an API action
   */
  async executeApiAction(action: ApiAction, context: any): Promise<any> {
    const { method, endpoint, body, headers = {} } = action;
    const url = endpoint.startsWith('http') ? endpoint : `${API_CONFIG.BASE_URL}${endpoint}`;
    
    this.logger.info(`Executing API ${method} request to ${url}`);
    
    const options: FetchRequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };
    
    if (body && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(body);
    }
    
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    try {
      return await response.json();
    } catch (e) {
      return await response.text();
    }
  }
  
  /**
   * Execute a database action
   */
  async executeDbAction(action: DbAction, context: OperationContext): Promise<any> {
    const { operation, params } = action;
    
    this.logger.info(`Executing DB operation: ${operation}`);
    
    // Special case for 'exec' operation which takes a function
    if (operation === 'exec' && typeof params === 'function') {
      try {
        return await params(context, context.operations);
      } catch (error) {
        this.logger.error(`Error in custom DB execution: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
    
    // Handle standard DB operations
    if (!typedDbService[operation] || typeof typedDbService[operation] !== 'function') {
      throw new Error(`Unknown DB operation: ${operation}`);
    }
    
    return await typedDbService[operation](this.processParams(params, context));
  }
  
  /**
   * Execute a WebSocket action
   */
  async executeWSAction(action: WSAction, context: any): Promise<any> {
    const { operation, clientId, params, waitFor } = action;
    
    this.logger.info(`Executing WebSocket operation: ${operation}`);
    
    // Handle client ID references
    let resolvedClientId = clientId || '';
    if (clientId && clientId.startsWith('$')) {
      // Extract client ID from context state
      const clientIdPath = clientId.substring(1).split('.');
      let value = context;
      for (const part of clientIdPath) {
        value = value[part];
      }
      resolvedClientId = value;
    }
    
    if (!typedWsClientFactory[operation] || typeof typedWsClientFactory[operation] !== 'function') {
      throw new Error(`Unknown WebSocket operation: ${operation}`);
    }
    
    const result = await typedWsClientFactory[operation](
      resolvedClientId,
      ...this.processParamsArray(params, context)
    );
    
    // If there's a waitFor condition
    if (waitFor && waitFor.type) {
      await this.waitForWSMessage(resolvedClientId, waitFor.type, waitFor.timeout || 5000);
    }
    
    return result;
  }
  
  /**
   * Execute an interactive action
   */
  async executeInteractiveAction(action: InteractiveAction, context: any): Promise<any> {
    const { protocol, initialAction, handlers, maxTimeout } = action;
    
    this.logger.info(`Starting interactive protocol: ${protocol}`);
    
    // Set up message handlers
    const messagePromise = new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Interactive protocol timed out after ${maxTimeout}ms`));
      }, maxTimeout);
      
      // Track whether protocol is complete
      let isComplete = false;
      
      // Create wrapper for handlers to provide context and operations
      const handlerWrappers = new Map();
      
      // Define operations object for handlers
      const operations = {
        api: context.operations.api,
        db: context.operations.db,
        ws: context.operations.ws
      };
      
      // Set up handlers
      for (const [eventType, handler] of Object.entries(handlers)) {
        const wrappedHandler = async (message: any) => {
          if (isComplete) return;
          
          try {
            const result = await handler(message, context, operations);
            
            // If handler returns true, protocol is complete
            if (result === true) {
              clearTimeout(timeoutId);
              isComplete = true;
              resolve();
            }
          } catch (error) {
            clearTimeout(timeoutId);
            isComplete = true;
            reject(error);
          }
        };
        
        // Store in map for cleanup
        handlerWrappers.set(eventType, wrappedHandler);
        
        // Register handler with appropriate component
        if (eventType.startsWith('ws_')) {
          // WebSocket message handlers
          for (const clientId of context.state.clients.values()) {
            wsClientFactory.addMessageHandler(clientId, wrappedHandler);
          }
        } else {
          // Other event handlers
          this.on(eventType, wrappedHandler);
        }
      }
      
      // Cleanup function to remove handlers
      context.cleanup = () => {
        clearTimeout(timeoutId);
        for (const [eventType, handler] of handlerWrappers.entries()) {
          if (eventType.startsWith('ws_')) {
            for (const clientId of context.state.clients.values()) {
              wsClientFactory.removeMessageHandler(clientId, handler);
            }
          } else {
            this.removeListener(eventType, handler);
          }
        }
      };
    });
    
    try {
      // Execute initial action if specified
      if (initialAction) {
        await this.executeAction(initialAction, context);
      }
      
      // Wait for protocol to complete
      await messagePromise;
      
      this.logger.info(`Interactive protocol completed: ${protocol}`);
    } finally {
      // Clean up handlers
      if (context.cleanup) {
        context.cleanup();
        delete context.cleanup;
      }
    }
  }
  
  /**
   * Execute a composite action
   */
  async executeCompositeAction(action: CompositeAction, context: any): Promise<void> {
    const { execution, actions } = action;
    
    this.logger.info(`Executing composite action with ${actions.length} sub-actions (${execution})`);
    
    if (execution === 'parallel') {
      await this.executeParallelActions(actions, context);
    } else {
      await this.executeSerialActions(actions, context);
    }
  }
  
  /**
   * Wait for a specific event
   */
  async waitForEvent(eventName: string, timeout: number, context: any): Promise<void> {
    this.logger.info(`Waiting for event: ${eventName} (timeout: ${timeout}ms)`);
    
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.removeListener(eventName, eventHandler);
        reject(new Error(`Timeout waiting for event: ${eventName}`));
      }, timeout);
      
      const eventHandler = (data: any) => {
        clearTimeout(timeoutId);
        this.removeListener(eventName, eventHandler);
        resolve();
      };
      
      this.once(eventName, eventHandler);
    });
  }
  
  /**
   * Wait for a WebSocket message
   */
  async waitForWSMessage(clientId: string, messageType: string, timeout: number): Promise<any> {
    this.logger.info(`Waiting for WebSocket message: ${messageType} from client ${clientId} (timeout: ${timeout}ms)`);
    
    return new Promise<any>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        wsClientFactory.removeMessageHandler(clientId, messageHandler);
        reject(new Error(`Timeout waiting for message: ${messageType}`));
      }, timeout);
      
      const messageHandler = (message: any) => {
        if (message.type === messageType) {
          clearTimeout(timeoutId);
          wsClientFactory.removeMessageHandler(clientId, messageHandler);
          resolve(message);
        }
      };
      
      wsClientFactory.addMessageHandler(clientId, messageHandler);
    });
  }
  
  /**
   * Process parameters, resolving references to context values
   */
  processParams(params: any, context: any): any {
    if (!params) return params;
    
    if (typeof params === 'string' && params.startsWith('$')) {
      // Handle string references like $context.state.value
      const path = params.substring(1).split('.');
      let value = context;
      for (const part of path) {
        value = value[part];
      }
      return value;
    }
    
    if (Array.isArray(params)) {
      return params.map(item => this.processParams(item, context));
    }
    
    if (typeof params === 'object' && params !== null) {
      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(params)) {
        result[key] = this.processParams(value, context);
      }
      return result;
    }
    
    return params;
  }
  
  /**
   * Process parameters array, resolving references to context values
   */
  processParamsArray(params: any, context: any): any[] {
    if (!params) return [];
    
    if (Array.isArray(params)) {
      return params.map(item => this.processParams(item, context));
    }
    
    return [this.processParams(params, context)];
  }
  
  // API helper methods
  async apiGet(url: string, headers?: any): Promise<any> {
    return this.executeApiAction({ 
      type: 'api', 
      method: 'GET', 
      endpoint: url, 
      headers 
    }, {});
  }
  
  async apiPost(url: string, body?: any, headers?: any): Promise<any> {
    return this.executeApiAction({ 
      type: 'api', 
      method: 'POST', 
      endpoint: url, 
      body, 
      headers 
    }, {});
  }
  
  async apiPut(url: string, body?: any, headers?: any): Promise<any> {
    return this.executeApiAction({ 
      type: 'api', 
      method: 'PUT', 
      endpoint: url, 
      body, 
      headers 
    }, {});
  }
  
  async apiDelete(url: string, headers?: any): Promise<any> {
    return this.executeApiAction({ 
      type: 'api', 
      method: 'DELETE', 
      endpoint: url, 
      headers 
    }, {});
  }
} 