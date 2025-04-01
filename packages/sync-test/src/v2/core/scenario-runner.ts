import { EventEmitter } from 'events';
import { createLogger } from './logger.ts';
import { TestConfig } from '../types.ts';
import { ClientProfileManager } from './client-profile-manager.ts';
import { ValidationService } from './validation-service.ts';
import { MessageProcessor, MessageProcessorOptions } from './message-processor.ts';
import { wsClientFactory, WebSocketClientFactory } from './ws-client-factory.ts';
import { messageDispatcher } from './message-dispatcher.ts';
import * as apiService from './api-service.ts';
import * as entityChanges from './entity-changes.ts';
import fetch, { RequestInit as FetchRequestInit } from 'node-fetch';
import { API_CONFIG } from '../config.ts';
import type { ServerChangesMessage, SrvMessageType } from '@repo/sync-types';

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
  type: 'api' | 'changes' | 'ws' | 'interactive' | 'composite' | 'validation';  // Changed from 'db' to 'changes'
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
 * Changes Action - performs database operations (formerly DbAction)
 */
export interface ChangesAction extends Action {
  type: 'changes';
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
  params?: any | ((context: OperationContext, operations: Record<string, any>) => Promise<any>);  // Updated
  
  // Optional waiting for response
  waitFor?: {
    type: string;          // Message type to wait for
    timeout?: number;      // Timeout in ms
  };
}

/**
 * Validation Action - performs validation operations
 */
export interface ValidationAction extends Action {
  type: 'validation';
  operation: string;       // Operation name (validate, verifyChanges, etc.)
  params?: any | ((context: OperationContext, operations: Record<string, any>) => Promise<any>);
}

/**
 * Interactive Protocol - complex back-and-forth message handling
 */
export interface InteractiveAction extends Action {
  type: 'interactive';
  protocol: string;            // Protocol name for logging
  maxTimeout: number;          // Maximum time to wait for completion
  
  // Optional initial action
  initialAction?: ApiAction | ChangesAction | WSAction | ValidationAction;
  
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

// Define service types for dynamic operations
type ApiServiceType = typeof apiService & {
  [key: string]: (...args: any[]) => Promise<any>;
};

type EntityChangesType = typeof entityChanges & {
  [key: string]: (...args: any[]) => Promise<any>;
};

// Replace this line
const typedApiService = apiService as ApiServiceType;
const typedEntityChanges = entityChanges as EntityChangesType;

// Type for dynamic WS client operations
type WsClientFactoryType = WebSocketClientFactory & {
  [key: string]: (...args: any[]) => Promise<any>;
};

// Cast services to indexable types
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
  protected messageProcessor: MessageProcessor;
  protected profileManager: ClientProfileManager;
  
  constructor() {
    super(); // Initialize EventEmitter
    
    // Initialize services with default options
    this.validationService = new ValidationService();
    this.messageProcessor = new MessageProcessor();
    this.profileManager = new ClientProfileManager();
    
    this.logger.info('ScenarioRunner created with validation and message processing capabilities');
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
          clients: [], // Store client IDs as an array
          lsn: null,   // Current LSN
          clientChanges: {} // Track changes per client
        },
        logger: this.logger,
        validationService: this.validationService,
        messageProcessor: this.messageProcessor,
        operations: {
          // API operations
          api: {
            get: this.apiGet.bind(this),
            post: this.apiPost.bind(this),
            put: this.apiPut.bind(this),
            delete: this.apiDelete.bind(this)
          },
          // Changes operations (formerly DB operations)
          changes: {
            // API operations - use api-service directly
            initializeReplication: apiService.initializeReplication.bind(apiService),
            getCurrentLSN: apiService.getCurrentLSN.bind(apiService),
            
            // Entity operations - use entity-changes directly
            initialize: entityChanges.initialize.bind(entityChanges),
            createBulkEntityChanges: entityChanges.createEntities.bind(entityChanges),
            updateBulkEntityChanges: entityChanges.updateEntities.bind(entityChanges),
            deleteBulkEntityChanges: entityChanges.deleteEntities.bind(entityChanges),
            createMixedEntityChanges: entityChanges.generateAndApplyChanges.bind(entityChanges),
            generateMixedChangesInMemory: entityChanges.generateChanges.bind(entityChanges),
            applyChangeBatch: entityChanges.applyChangeBatch.bind(entityChanges),
            generateAndApplyChanges: entityChanges.generateAndApplyChanges.bind(entityChanges)
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
            waitForCatchup: wsClientFactory.waitForCatchup.bind(wsClientFactory),
            sendChangesAcknowledgment: wsClientFactory.sendChangesAcknowledgment.bind(wsClientFactory),
            removeAllMessageHandlers: wsClientFactory.removeAllMessageHandlers?.bind(wsClientFactory),
            updateLSN: wsClientFactory.updateLSN?.bind(wsClientFactory),
            getClientStatus: wsClientFactory.getClientStatus?.bind(wsClientFactory)
          },
          // Message processing operations
          messages: {
            process: this.messageProcessor.processWebSocketMessages.bind(this.messageProcessor),
            processServerMessage: this.messageProcessor.processServerChangesMessage.bind(this.messageProcessor),
            createSyntheticIds: this.messageProcessor.createSyntheticIdMapping.bind(this.messageProcessor),
            processTableChanges: this.messageProcessor.processTableChanges.bind(this.messageProcessor)
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
        // For parallel execution, just log at debug level
        this.logger.debug(`Executing ${step.actions.length} actions in parallel`);
        await this.executeParallelActions(step.actions, context);
      } else {
        // For serial execution, just log at debug level
        this.logger.debug(`Executing ${step.actions.length} actions serially`);
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
      
      // Check for exit flag after step completion
      if (context.state.shouldExit) {
        this.logger.error(`Critical error detected in step '${step.name}', forcing exit`);
        process.exit(1);
      }
      
      this.logger.info(`Step completed: ${step.name}`);
    } catch (error) {
      this.logger.error(`Step failed: ${step.name} - ${error instanceof Error ? error.message : String(error)}`);
      
      // Force exit if shouldExit is set
      if (context.state.shouldExit) {
        this.logger.error(`Critical error detected in step '${step.name}', forcing exit`);
        process.exit(1);
      }
      
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
    // Log at debug level to reduce verbosity
    this.logger.debug(`Executing action: ${action.name || action.type}`);
    
    try {
      switch (action.type) {
        case 'api':
          return await this.executeApiAction(action as ApiAction, context);
        
        case 'changes':
          this.logger.debug(`Executing database operation: ${(action as ChangesAction).operation}`);
          return await this.executeChangesAction(action as ChangesAction, context);
        
        case 'ws':
          this.logger.debug(`Executing WebSocket operation: ${(action as WSAction).operation}`);
          return await this.executeWSAction(action as WSAction, context);
        
        case 'interactive':
          return await this.executeInteractiveAction(action as InteractiveAction, context);
        
        case 'composite':
          return await this.executeCompositeAction(action as CompositeAction, context);
        
        case 'validation':
          this.logger.debug(`Executing validation operation: ${(action as ValidationAction).operation}`);
          return await this.executeValidationAction(action as ValidationAction, context);
        
        default:
          throw new Error(`Unknown action type: ${action.type}`);
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
  async executeChangesAction(action: ChangesAction, context: OperationContext): Promise<any> {
    const { operation, params } = action;
    
    this.logger.info(`Executing DB operation: ${operation}`);
    
    // Special case for 'exec' operation which takes a function
    if (operation === 'exec' && typeof params === 'function') {
      try {
        return await params(context, context.operations);
      } catch (error) {
        this.logger.error(`Error in custom DB execution: ${error instanceof Error ? error.message : String(error)}`);
        
        // Force exit on critical errors if shouldExit flag is set
        if (context.state.shouldExit) {
          this.logger.error('CRITICAL ERROR DETECTED - Forcing exit');
          process.exit(1);
        }
        
        throw error;
      }
    }
    
    // Check if this is an API operation
    if (operation === 'initializeReplication' || operation === 'getCurrentLSN') {
      if (!typedApiService[operation] || typeof typedApiService[operation] !== 'function') {
        this.logger.error(`CRITICAL ERROR: Unsupported API operation: ${operation}`);
        process.exit(1); // Force exit on missing operation
      }
      
      try {
        // These API functions don't take parameters
        return await typedApiService[operation]();
      } catch (error) {
        this.logger.error(`Error in API operation ${operation}: ${error instanceof Error ? error.message : String(error)}`);
        
        // Force exit on critical errors if shouldExit flag is set
        if (context.state.shouldExit) {
          this.logger.error('CRITICAL ERROR DETECTED - Forcing exit');
          process.exit(1);
        }
        
        throw error;
      }
    }
    
    // Otherwise, try entity changes operations
    if (!typedEntityChanges[operation] || typeof typedEntityChanges[operation] !== 'function') {
      this.logger.error(`CRITICAL ERROR: Unsupported entity operation: ${operation}`);
      process.exit(1); // Force exit on missing operation
    }
    
    try {
      return await typedEntityChanges[operation](params);
    } catch (error) {
      this.logger.error(`Error in entity operation ${operation}: ${error instanceof Error ? error.message : String(error)}`);
      
      // Force exit on critical errors if shouldExit flag is set
      if (context.state.shouldExit) {
        this.logger.error('CRITICAL ERROR DETECTED - Forcing exit');
        process.exit(1);
      }
      
      throw error;
    }
  }
  
  /**
   * Execute a WebSocket action
   */
  async executeWSAction(action: WSAction, context: any): Promise<any> {
    const { operation, clientId, params, waitFor } = action;
    
    this.logger.info(`Executing WebSocket operation: ${operation}`);
    
    // Handle custom function execution
    if (operation === 'exec' && typeof params === 'function') {
      try {
        return await params(context, context.operations);
      } catch (error) {
        this.logger.error(`Error in WebSocket operation: ${error}`);
        throw error;
      }
    }
    
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
    
    // Handle standard WS operations
    if (!typedWsClientFactory[operation] || typeof typedWsClientFactory[operation] !== 'function') {
      throw new Error(`Unsupported WS operation: ${operation}`);
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
   * Execute a validation action
   */
  async executeValidationAction(action: ValidationAction, context: any): Promise<any> {
    const { operation, params } = action;
    
    this.logger.info(`Executing validation operation: ${operation}`);
    
    // Handle custom function execution
    if (operation === 'exec' && typeof params === 'function') {
      try {
        return await params(context, context.operations);
      } catch (error) {
        this.logger.error(`Error in validation operation: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
    
    // If we get here, we're expecting a standard operation
    throw new Error(`Validation operations currently only support 'exec' with function parameters`);
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
   * Execute an interactive action with protocol-based handlers
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
        ws: context.operations.ws,
        messages: context.operations.messages
      };
      
      // Set up handlers
      for (const [eventType, handler] of Object.entries(handlers)) {
        this.logger.info(`Registering handler for message type: ${eventType}`);
        
        const wrappedHandler = async (message: any) => {
          if (isComplete) return false;
          
          try {
            this.logger.debug(`Executing handler for message type: ${eventType}`);
            const result = await handler(message, context, operations);
            
            // If handler returns true, protocol is complete
            if (result === true) {
              this.logger.info(`Protocol ${protocol} completed by handler for ${eventType}`);
              clearTimeout(timeoutId);
              isComplete = true;
              resolve();
              return true;
            }
            return false;
          } catch (error) {
            this.logger.error(`Error in handler for ${eventType}: ${error}`);
            clearTimeout(timeoutId);
            isComplete = true;
            reject(error);
            return false;
          }
        };
        
        // Store in map for cleanup
        handlerWrappers.set(eventType, wrappedHandler);
        
        // Register handler with the central message dispatcher
        messageDispatcher.registerHandler(eventType, wrappedHandler);
        
        // Log that we're now listening for this event type
        this.logger.info(`Registered handler for message type: ${eventType}`);
      }
      
      // Cleanup function to remove handlers
      context.cleanup = () => {
        clearTimeout(timeoutId);
        for (const [eventType, handler] of handlerWrappers.entries()) {
          this.logger.info(`Removing handler for message type: ${eventType}`);
          messageDispatcher.removeHandler(eventType, handler);
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
   * Execute a composite action (nested actions)
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
}