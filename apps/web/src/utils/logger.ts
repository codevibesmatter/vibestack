/**
 * Structured logger for client-side logging
 */

// Log levels
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4
}

// Default configuration
const DEFAULT_CONFIG = {
  minLevel: process.env.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.INFO,
  enableConsole: true,
  disableServiceEvents: false
};

// Allow temporary disabling of service events (for initialization)
export function setServiceEventsEnabled(enabled: boolean): void {
  DEFAULT_CONFIG.disableServiceEvents = !enabled;
}

// Main logger object
export const logger = {
  debug(message: string, data?: any, context?: string): void {
    if (DEFAULT_CONFIG.minLevel <= LogLevel.DEBUG) {
      console.debug(`[${context || 'app'}] ${message}`, data);
    }
  },
  
  info(message: string, data?: any, context?: string): void {
    if (DEFAULT_CONFIG.minLevel <= LogLevel.INFO) {
      console.log(`[${context || 'app'}] ${message}`, data);
    }
  },
  
  warn(message: string, data?: any, context?: string): void {
    if (DEFAULT_CONFIG.minLevel <= LogLevel.WARN) {
      console.warn(`[${context || 'app'}] ${message}`, data);
    }
  },
  
  error(message: string, error?: any, data?: any, context?: string): void {
    if (DEFAULT_CONFIG.minLevel <= LogLevel.ERROR) {
      console.error(`[${context || 'app'}] ${message}`, error, data);
    }
  },
  
  // Create a context-specific logger
  withContext(context: string) {
    return {
      debug: (message: string, data?: any) => this.debug(message, data, context),
      info: (message: string, data?: any) => this.info(message, data, context),
      warn: (message: string, data?: any) => this.warn(message, data, context),
      error: (message: string, error?: any, data?: any) => this.error(message, error, data, context)
    };
  }
};

// Specialized loggers for different modules
export const syncLogger = logger.withContext('sync');
export const connectionLogger = logger.withContext('connection');
export const dbLogger = logger.withContext('db');
export const uiLogger = logger.withContext('ui');

/**
 * ChangesLogger provides centralized logging for all change-related operations
 */
export class ChangesLogger {
  private logger = logger.withContext('changes');
  
  /**
   * Log a change being recorded
   */
  public logChangeRecorded(change: {
    id: string;
    entity_type: string;
    entity_id: string;
    operation: string;
  }): void {
    this.logger.info(
      `Change recorded: [${change.id}] ${change.operation} ${change.entity_type}:${change.entity_id}`,
      { change }
    );
  }
  
  /**
   * Log a change being processed
   */
  public logChangeProcessing(changeId: string): void {
    this.logger.info(`Processing change: ${changeId}`);
  }
  
  /**
   * Log a change successfully processed
   */
  public logChangeProcessed(change: {
    id: string;
    entity_type: string;
    entity_id: string;
    operation: string;
  }): void {
    this.logger.info(
      `Change processed: [${change.id}] ${change.operation} ${change.entity_type}:${change.entity_id}`,
      { change }
    );
  }
  
  /**
   * Log a change processing failure
   */
  public logChangeProcessingFailed(changeId: string, error: string): void {
    this.logger.error(`Change processing failed: ${changeId}`, error);
  }
  
  /**
   * Log a batch of changes being processed
   */
  public logBatchProcessing(count: number): void {
    this.logger.debug(`Processing ${count} changes`);
  }
  
  /**
   * Log sync operations
   */
  public logSync(operation: string, details?: any): void {
    this.logger.info(`Sync operation: ${operation}`, details);
  }
  
  /**
   * Log worker lifecycle events
   */
  public logWorkerEvent(event: string): void {
    this.logger.debug(`Worker event: ${event}`);
  }
  
  /**
   * Log worker errors
   */
  public logWorkerError(message: string, error: any): void {
    this.logger.error(`Worker error: ${message}`, error);
  }
  
  /**
   * Log service event
   * @param event The event to log
   */
  public logServiceEvent(event: string): void {
    if (!DEFAULT_CONFIG.disableServiceEvents) {
      this.logger.info(`Service event: ${event}`);
    }
  }
  
  /**
   * Log service errors
   */
  public logServiceError(message: string, error: any): void {
    this.logger.error(`Service error: ${message}`, error);
  }
}

// Create singleton instance
export const changesLogger = new ChangesLogger(); 