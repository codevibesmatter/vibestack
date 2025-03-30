import { EventEmitter } from 'events';
import { createLogger } from './logger.ts';

/**
 * Message handler function type
 */
export type MessageHandler = (message: any) => Promise<boolean> | boolean;

/**
 * MessageDispatcher serves as a central hub for all message routing
 * It connects different message sources (WebSocket, API, etc.) to message handlers
 */
export class MessageDispatcher extends EventEmitter {
  private logger = createLogger('MsgDispatcher');
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  
  constructor() {
    super(); // Initialize EventEmitter
    this.logger.info('MessageDispatcher initialized');
  }
  
  /**
   * Register a handler for a specific message type
   */
  public registerHandler(messageType: string, handler: MessageHandler): void {
    if (!this.handlers.has(messageType)) {
      this.handlers.set(messageType, new Set());
    }
    
    this.handlers.get(messageType)!.add(handler);
    this.logger.debug(`Registered handler for message type: ${messageType}`);
  }
  
  /**
   * Remove a handler for a specific message type
   */
  public removeHandler(messageType: string, handler: MessageHandler): void {
    if (this.handlers.has(messageType)) {
      const handlers = this.handlers.get(messageType)!;
      handlers.delete(handler);
      
      if (handlers.size === 0) {
        this.handlers.delete(messageType);
      }
      
      this.logger.debug(`Removed handler for message type: ${messageType}`);
    }
  }
  
  /**
   * Remove all handlers for a specific message type
   */
  public removeAllHandlers(messageType: string): void {
    if (this.handlers.has(messageType)) {
      this.handlers.delete(messageType);
      this.logger.debug(`Removed all handlers for message type: ${messageType}`);
    }
  }
  
  /**
   * Dispatch a message to all registered handlers of its type
   * Returns true if the message was handled by at least one handler
   */
  public async dispatchMessage(message: any): Promise<boolean> {
    if (!message || !message.type) {
      this.logger.warn('Received invalid message without type');
      return false;
    }
    
    const messageType = message.type;
    
    // Log all incoming messages for debugging (reduce to debug level)
    this.logger.debug(`Received message of type: ${messageType}`);
    
    // Emit the message as an event (for EventEmitter compatibility)
    this.emit(messageType, message);
    
    // If no handlers are registered for this message type, return false
    if (!this.handlers.has(messageType)) {
      // Only log at debug level to reduce noise
      this.logger.debug(`No handlers registered for message type: ${messageType}`);
      return false;
    }
    
    // Call all registered handlers
    const handlers = Array.from(this.handlers.get(messageType)!);
    this.logger.debug(`Dispatching message ${messageType} to ${handlers.length} handlers`);
    
    let handled = false;
    
    for (const handler of handlers) {
      try {
        const result = await handler(message);
        handled = handled || !!result;
      } catch (error) {
        this.logger.error(`Error in message handler for ${messageType}: ${error}`);
      }
    }
    
    return handled;
  }
  
  /**
   * Check if there are any handlers registered for a message type
   */
  public hasHandlers(messageType: string): boolean {
    return this.handlers.has(messageType) && this.handlers.get(messageType)!.size > 0;
  }
}

// Export singleton instance
export const messageDispatcher = new MessageDispatcher(); 