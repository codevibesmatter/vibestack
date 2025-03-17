import { EventEmitter } from 'events';
import { syncLogger, changesLogger } from '../../utils/logger';
import { ChangesMessage, ServerChange } from '../message-types';

/**
 * Interface between the sync worker and the changes module
 */
export class ChangesInterface extends EventEmitter {
  private static instance: ChangesInterface;
  private worker: Worker | null = null;

  private constructor() {
    super();
    changesLogger.logServiceEvent('Changes interface initialized');
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): ChangesInterface {
    if (!ChangesInterface.instance) {
      ChangesInterface.instance = new ChangesInterface();
    }
    return ChangesInterface.instance;
  }

  /**
   * Set the worker instance
   */
  public setWorker(worker: Worker): void {
    this.worker = worker;
    changesLogger.logServiceEvent('Changes interface connected to sync worker');
  }

  /**
   * Process changes received from the worker
   */
  public async processChanges(message: ChangesMessage): Promise<void> {
    try {
      const { changes, lsn } = message;

      // Log received changes
      syncLogger.info('Changes received in main thread:', {
        lsn,
        changeCount: changes?.length,
        firstChange: changes?.[0],
        rawChanges: JSON.stringify(changes)
      });

      // Validate changes before processing
      if (!Array.isArray(changes)) {
        throw new Error('Changes must be an array');
      }

      // Validate each change matches server format
      const validatedChanges = changes.map((change, index) => {
        if (!change || typeof change !== 'object') {
          const error = `Change at index ${index} must be an object, got ${typeof change}`;
          syncLogger.error('Change validation failed:', {
            error,
            change,
            changeType: typeof change
          });
          throw new Error(error);
        }
        if (!change.table || typeof change.table !== 'string') {
          const error = `Change at index ${index} must have a table string`;
          syncLogger.error('Change validation failed:', {
            error,
            change,
            table: change.table,
            tableType: typeof change.table
          });
          throw new Error(error);
        }
        if (!change.operation || !['insert', 'update', 'delete'].includes(change.operation)) {
          const error = `Change at index ${index} must have a valid operation (insert, update, delete)`;
          syncLogger.error('Change validation failed:', {
            error,
            change,
            operation: change.operation
          });
          throw new Error(error);
        }
        return change;
      });

      // Create a promise that resolves when changes are processed
      const processPromise = new Promise<void>((resolve, reject) => {
        const handler = (response: { changes: ServerChange[]; lsn?: string; error?: string }) => {
          this.off('changes_processed', handler);
          if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve();
          }
        };

        this.once('changes_processed', handler);

        // Emit changes event for the changes module to handle
        this.emit('changes', {
          changes: changes as ServerChange[],
          lsn,
          callback: handler
        });

        // Set timeout
        setTimeout(() => {
          this.off('changes_processed', handler);
          reject(new Error('Timeout waiting for changes to be processed'));
        }, 30000); // 30 second timeout
      });

      // Wait for changes to be processed
      await processPromise;

      // Send acknowledgment back to worker
      if (this.worker) {
        this.worker.postMessage({
          type: 'changes_processed',
          payload: { lsn }
        });
      }

      syncLogger.debug('Changes processed successfully', { 
        changeCount: changes.length,
        lsn 
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      syncLogger.error('Failed to process changes', { error: errorMessage });
      
      // Send error back to worker
      if (this.worker) {
        this.worker.postMessage({
          type: 'changes_processed',
          payload: { 
            lsn: message.lsn,
            error: {
              message: errorMessage,
              details: error instanceof Error ? error.stack : error
            }
          }
        });
      }
    }
  }

  /**
   * Subscribe to changes events
   */
  public onChanges(callback: (data: { 
    changes: ServerChange[]; 
    lsn?: string;
    callback: (response: { error?: string }) => void;
  }) => void): void {
    this.on('changes', callback);
  }

  /**
   * Unsubscribe from changes events
   */
  public offChanges(callback: (data: { 
    changes: ServerChange[]; 
    lsn?: string;
    callback: (response: { error?: string }) => void;
  }) => void): void {
    this.off('changes', callback);
  }
} 