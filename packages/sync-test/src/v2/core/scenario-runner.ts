import { EventEmitter } from 'events';
import { createLogger } from './logger.ts';
import { TestConfig } from '../types.ts';
import { ClientProfileManager } from './client-profile-manager.ts';
import { ValidationService } from './validation-service.ts';
import { wsClientFactory, WebSocketClientFactory } from './ws-client-factory.ts';
import { messageDispatcher } from './message-dispatcher.ts';
import * as apiService from './api-service.ts';
import * as entityChanges from './entity-changes/index.ts';
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
  protected profileManager: ClientProfileManager;
  
  constructor() {
    super(); // Initialize EventEmitter
    
    // Initialize services with default options
    this.validationService = new ValidationService();
    this.profileManager = new ClientProfileManager();
    
    this.logger.info('ScenarioRunner created with validation capabilities');
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
        operations: {
          // API operations
          api: {
            get: this.apiGet.bind(this),
            post: this.apiPost.bind(this),
            put: this.apiPut.bind(this),
            delete: this.apiDelete.bind(this)
          },
          
          // WS operations
          ws: {
            createClient: wsClientFactory.createClient.bind(wsClientFactory),
            connectClient: wsClientFactory.connectClient.bind(wsClientFactory),
            disconnectClient: wsClientFactory.disconnectClient.bind(wsClientFactory),
            setupClient: wsClientFactory.setupClient.bind(wsClientFactory),
            sendMessage: wsClientFactory.sendMessage.bind(wsClientFactory),
            registerHandler: wsClientFactory.registerMessageHandler.bind(wsClientFactory),
            getClientStatus: wsClientFactory.getClientStatus.bind(wsClientFactory),
            waitForCatchup: wsClientFactory.waitForCatchup.bind(wsClientFactory),
            sendChangesAcknowledgment: wsClientFactory.sendChangesAcknowledgment.bind(wsClientFactory),
            updateLSN: wsClientFactory.updateLSN.bind(wsClientFactory),
            getCurrentLSN: wsClientFactory.getCurrentLSN.bind(wsClientFactory)
          },
          
          // Changes operations (formerly DB operations)
          changes: {
            // API operations - use api-service directly
            initializeReplication: apiService.initializeReplication.bind(apiService),
            getCurrentLSN: apiService.getCurrentLSN.bind(apiService),
            
            // Entity operations - use entity-changes directly
            initialize: entityChanges.initialize.bind(entityChanges),
            generateChanges: entityChanges.generateChanges.bind(entityChanges),
            convertToTableChanges: entityChanges.convertToTableChanges.bind(entityChanges),
            applyBatchChanges: entityChanges.applyBatchChanges.bind(entityChanges),
            generateAndApplyChanges: entityChanges.generateAndApplyChanges.bind(entityChanges),
            createChangeTracker: entityChanges.createChangeTracker.bind(entityChanges),
            generateAndTrackChanges: entityChanges.generateAndTrackChanges.bind(entityChanges),
            seedDatabase: entityChanges.seedDatabase.bind(entityChanges)
          },
          
          // Message dispatcher operations
          messages: {
            registerHandler: messageDispatcher.registerHandler.bind(messageDispatcher),
            removeHandler: messageDispatcher.removeHandler.bind(messageDispatcher),
            processTableChanges: messageDispatcher.processTableChanges.bind(messageDispatcher),
            updateClientLSN: messageDispatcher.updateClientLSN.bind(messageDispatcher),
            getClientLSN: messageDispatcher.getClientLSN.bind(messageDispatcher)
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
    
    // Special case for 'exec' operation which takes a function
    if (operation === 'exec' && typeof params === 'function') {
      try {
        return await params(context, context.operations);
      } catch (error) {
        this.logger.error(`Error in custom validation execution: ${error instanceof Error ? error.message : String(error)}`);
        
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
   * API GET request helper
   */
  async apiGet(endpoint: string, headers?: Record<string, string>): Promise<any> {
    return this.executeApiAction({
      type: 'api',
      method: 'GET',
      endpoint,
      headers
    }, {});
  }

  /**
   * API POST request helper
   */
  async apiPost(endpoint: string, body?: any, headers?: Record<string, string>): Promise<any> {
    return this.executeApiAction({
      type: 'api',
      method: 'POST',
      endpoint,
      body,
      headers
    }, {});
  }

  /**
   * API PUT request helper
   */
  async apiPut(endpoint: string, body?: any, headers?: Record<string, string>): Promise<any> {
    return this.executeApiAction({
      type: 'api',
      method: 'PUT',
      endpoint,
      body,
      headers
    }, {});
  }

  /**
   * API DELETE request helper
   */
  async apiDelete(endpoint: string, headers?: Record<string, string>): Promise<any> {
    return this.executeApiAction({
      type: 'api',
      method: 'DELETE',
      endpoint,
      headers
    }, {});
  }

  /**
   * Wait for an event to occur
   */
  async waitForEvent(eventName: string, timeout: number, context: any): Promise<void> {
    this.logger.info(`Waiting for event: ${eventName} (timeout: ${timeout}ms)`);
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.removeListener(eventName, eventHandler);
        reject(new Error(`Timeout waiting for event: ${eventName}`));
      }, timeout);
      
      const eventHandler = (...args: any[]) => {
        clearTimeout(timeoutId);
        this.removeListener(eventName, eventHandler);
        resolve();
      };
      
      this.on(eventName, eventHandler);
    });
  }

  /**
   * Execute an interactive action
   * This runs an asynchronous protocol with message handlers
   * @param action The interactive action
   * @param context The operation context
   * @returns The result of the action
   */
  private async executeInteractiveAction(action: InteractiveAction, context: any): Promise<any> {
    const protocol = action.protocol || 'generic';
    const logPrefix = `[${protocol}] `;
    const maxTimeout = action.maxTimeout || 60000;
    const handlerMap = action.handlers || {};
    
    this.logger.info(`${logPrefix}Starting interactive protocol`);
    
    // First, run the initial action if specified
    if (action.initialAction) {
      this.logger.info(`${logPrefix}Running initial action for protocol ${protocol}`);
      await this.executeAction(action.initialAction, context);
    }
    
    return new Promise((resolveProtocol, rejectProtocol) => {
      // Create a timeout for the entire protocol
      const timeoutHandler = setTimeout(() => {
        this.logger.warn(`${logPrefix}Protocol timed out after ${maxTimeout}ms`);
        
        if (typeof handlerMap['timeout'] === 'function') {
          // Call the timeout handler if available
          try {
            const timeoutResult = handlerMap['timeout']({ type: 'timeout' }, context, context.operations || {});
            
            // Handle promise or direct result
            if (timeoutResult instanceof Promise) {
              timeoutResult
                .then(result => {
                  // If the timeout handler returns true, resolve the protocol
                  if (result === true) {
                    resolveProtocol({ success: false, timedOut: true });
                  }
                })
                .catch(err => {
                  this.logger.error(`${logPrefix}Error in timeout handler: ${err}`);
                  rejectProtocol(err);
                });
            } else if (timeoutResult === true) {
              // Direct true result
              resolveProtocol({ success: false, timedOut: true });
            }
          } catch (err) {
            this.logger.error(`${logPrefix}Error in timeout handler: ${err}`);
            rejectProtocol(err);
          }
        } else {
          // No timeout handler, just resolve with timeout error
          resolveProtocol({ success: false, timedOut: true });
        }
      }, maxTimeout);
      
      // Register protocol message handlers that will resolve the promise
      // when the protocol completes
      const registeredHandlers: Array<{type: string, handler: Function}> = [];
      
      Object.entries(handlerMap).forEach(([messageType, handler]) => {
        if (typeof handler !== 'function') {
          this.logger.warn(`${logPrefix}Skipping invalid handler for message type ${messageType}`);
          return;
        }
        
        // Create a wrapper handler that will be registered with the message dispatcher
        const wrapperHandler = async (message: any) => {
          try {
            // Call the original handler
            const result = await handler(message, context, context.operations || {});
            
            // IMPORTANT: The result determines if the PROTOCOL should complete,
            // not whether the message was handled. We always consider the message handled
            // by our protocol handler, but only complete the protocol if true is returned.
            if (result === true) {
              // Protocol is complete, clean up and resolve
              clearTimeout(timeoutHandler);
              
              // Log that we're unregistering handlers
              this.logger.info(`${logPrefix}Protocol completed, unregistering all handlers`);
              
              // Unregister all handlers
              registeredHandlers.forEach(({type, handler}) => {
                this.logger.debug(`${logPrefix}Unregistering handler for: ${type}`);
                // messageDispatcher.unregisterHandler is not implemented yet
                // For now just log it
              });
              
              resolveProtocol({ success: true });
            }
            
            // Always return true to indicate the message was handled,
            // even if the protocol is not yet complete
            return true;
          } catch (err) {
            this.logger.error(`${logPrefix}Error in handler for ${messageType}: ${err}`);
            
            // Don't fail the entire protocol on a single handler error,
            // but do mark the message as handled
            return true;
          }
        };
        
        // Register the wrapper handler with the message dispatcher
        messageDispatcher.registerHandler(messageType, wrapperHandler);
        
        // Keep track of registered handlers for cleanup
        registeredHandlers.push({ type: messageType, handler: wrapperHandler });
        
        this.logger.debug(`${logPrefix}Registered handler for message type: ${messageType}`);
      });
      
      this.logger.info(`${logPrefix}Registered ${registeredHandlers.length} protocol handlers`);
    });
  }

  /**
   * Execute a composite action
   */
  async executeCompositeAction(action: CompositeAction, context: any): Promise<any> {
    const { execution, actions } = action;
    
    this.logger.info(`Executing composite action with ${actions.length} sub-actions in ${execution} mode`);
    
    if (execution === 'parallel') {
      return this.executeParallelActions(actions, context);
    } else {
      return this.executeSerialActions(actions, context);
    }
  }

  /**
   * Process parameters for WebSocket operations
   */
  processParamsArray(params: any, context: any): any[] {
    if (!params) {
      return [];
    }
    
    if (Array.isArray(params)) {
      return params;
    }
    
    // If it's an object, convert to array
    if (typeof params === 'object') {
      return [params];
    }
    
    // Otherwise, wrap in array
    return [params];
  }

  /**
   * Wait for a WebSocket message
   */
  async waitForWSMessage(clientId: string, messageType: string, timeout: number): Promise<any> {
    this.logger.info(`Waiting for WebSocket message type: ${messageType} from client: ${clientId} (timeout: ${timeout}ms)`);
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        messageDispatcher.removeHandler(messageType, messageHandler);
        reject(new Error(`Timeout waiting for WebSocket message: ${messageType}`));
      }, timeout);
      
      const messageHandler = (message: any) => {
        // Only handle messages for the specific client
        if (message.clientId === clientId) {
          clearTimeout(timeoutId);
          messageDispatcher.removeHandler(messageType, messageHandler);
          this.logger.info(`Received expected message type: ${messageType} from client: ${clientId}`);
          resolve(message);
          return true; // Message was handled
        }
        return false; // Message was not handled
      };
      
      // Register with the central message dispatcher
      messageDispatcher.registerHandler(messageType, messageHandler);
    });
  }
}