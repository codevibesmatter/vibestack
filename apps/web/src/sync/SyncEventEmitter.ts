/**
 * SyncEventEmitter
 * 
 * A simple event emitter for the sync system.
 * Allows components to subscribe to and publish events.
 */
export class SyncEventEmitter {
  private handlers: Record<string, Array<(data: any) => void>> = {};
  private emitterId: string;

  constructor() {
    this.emitterId = Math.random().toString(36).substring(2, 10);
  }

  /**
   * Register a handler for an event
   * @param eventType The event type to listen for
   * @param handler The handler function
   */
  public on(eventType: string, handler: (data: any) => void): void {
    if (!this.handlers[eventType]) {
      this.handlers[eventType] = [];
    }
    this.handlers[eventType].push(handler);
  }

  /**
   * Remove a handler for an event
   * @param eventType The event type
   * @param handler The handler to remove (if undefined, removes all handlers)
   */
  public off(eventType: string, handler?: (data: any) => void): void {
    if (!this.handlers[eventType]) {
      return;
    }

    if (!handler) {
      delete this.handlers[eventType];
      return;
    }

    const index = this.handlers[eventType].indexOf(handler);
    if (index !== -1) {
      this.handlers[eventType].splice(index, 1);
    }

    if (this.handlers[eventType].length === 0) {
      delete this.handlers[eventType];
    }
  }

  /**
   * Emit an event to all registered handlers
   * @param eventType The event type to emit
   * @param data The data to pass to handlers
   */
  public emit(eventType: string, data?: any): void {
    const hasKey = Object.prototype.hasOwnProperty.call(this.handlers, eventType);
    const handlerArray = this.handlers[eventType];
    const arrayExists = Array.isArray(handlerArray);
    const arrayLength = arrayExists ? handlerArray.length : 0;

    if (!arrayExists || arrayLength === 0) {
      return;
    }

    const handlers = [...this.handlers[eventType]];

    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in event handler for ${eventType}:`, error);
      }
    }
  }

  /**
   * Get all registered event types
   */
  public getEventTypes(): string[] {
    return Object.keys(this.handlers);
  }

  /**
   * Get the count of handlers for a specific event type
   */
  public getHandlerCount(eventType: string): number {
    return this.handlers[eventType]?.length || 0;
  }

  /**
   * Remove all event handlers
   */
  public removeAllListeners(): void {
    this.handlers = {};
  }
} 