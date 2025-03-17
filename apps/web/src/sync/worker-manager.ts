/**
 * Sync Worker Manager
 * 
 * This class manages the sync worker lifecycle and provides an interface for 
 * sending commands to the worker.
 */

import { syncLogger } from '../utils/logger';
import { ChangesInterface } from './changes/changes-interface';
import { 
  MainToWorkerMessage, 
  MessagePayload, 
  WorkerToMainMessage,
  ConnectCommand,
  DisconnectCommand,
  SendMessageCommand,
  ChangesMessage,
  ErrorMessage,
  ConnectionState,
  SyncEvent
} from './message-types';

/**
 * SyncWorkerManager class
 * 
 * Manages the sync worker lifecycle and provides an interface for
 * sending commands to the worker.
 */
export class SyncWorkerManager {
  private static instance: SyncWorkerManager;
  private worker: Worker | null = null;
  private isInitialized = false;
  private messageQueue: Array<MessagePayload> = [];
  private changesInterface: ChangesInterface;

  private constructor() {
    this.changesInterface = ChangesInterface.getInstance();
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): SyncWorkerManager {
    if (!SyncWorkerManager.instance) {
      SyncWorkerManager.instance = new SyncWorkerManager();
    }
    return SyncWorkerManager.instance;
  }

  /**
   * Initialize the worker
   */
  public initialize(): boolean {
    if (this.isInitialized) {
      return true;
    }

    try {
      // Create a new worker
      this.worker = new Worker(new URL('./worker-core.ts', import.meta.url), { type: 'module' });
      
      // Set worker in changes interface
      this.changesInterface.setWorker(this.worker);
      
      // Set up message handler
      this.worker.onmessage = (event) => this.handleWorkerMessage(event.data);
      
      // Set up error handler
      this.worker.onerror = (error) => {
        syncLogger.error('Worker error:', error);
        this.emit('error', { message: 'Worker error', details: error });
      };
      
      // Process any queued messages
      this.processMessageQueue();
      
      this.isInitialized = true;
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      syncLogger.error('Failed to initialize worker:', { error: errorMessage });
      return false;
    }
  }

  /**
   * Connect to the sync server
   */
  public async connect(wsUrl: string): Promise<boolean> {
    if (!this.ensureInitialized()) {
      return false;
    }
    
    // Send connect command to worker
    this.sendMessage('connect', { wsUrl } as ConnectCommand);
    
    return true;
  }

  /**
   * Disconnect from the sync server
   */
  public disconnect(reason?: string): boolean {
    if (!this.ensureInitialized()) {
      return false;
    }

    // Send disconnect command to worker
    this.sendMessage('disconnect', { reason } as DisconnectCommand);
    
    return true;
  }

  /**
   * Send a message to the worker
   */
  public sendMessage(type: MainToWorkerMessage, payload: any = null): void {
    const message: MessagePayload = { type, payload };

    if (!this.worker || !this.isInitialized) {
      this.messageQueue.push(message);
      return;
    }

    try {
      this.worker.postMessage(message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      syncLogger.error('Failed to send message to worker:', { error: errorMessage, message });
    }
  }

  /**
   * Get the status of the sync worker
   */
  public getStatus(): boolean {
    if (!this.ensureInitialized()) {
      return false;
    }

    this.sendMessage('get_status');
    return true;
  }

  /**
   * Process any queued messages
   */
  private processMessageQueue(): void {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message) {
        this.sendMessage(message.type as MainToWorkerMessage, message.payload);
      }
    }
  }

  /**
   * Handle messages from the worker
   */
  private handleWorkerMessage(message: MessagePayload): void {
    const { type, payload } = message;

    try {
      switch (type as WorkerToMainMessage) {
        case 'changes':
          this.changesInterface.processChanges(payload as ChangesMessage);
          break;

        case 'error':
          this.emit('error', payload as ErrorMessage);
          break;

        case 'status':
          this.emit('status_changed', payload as ConnectionState);
          break;

        case 'message':
          syncLogger.debug('Received message from worker:', payload);
          break;

        default:
          syncLogger.debug('Unhandled worker message:', { type, payload });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      syncLogger.error('Failed to handle worker message:', { error: errorMessage, message });
    }
  }

  /**
   * Ensure the worker is initialized
   */
  private ensureInitialized(): boolean {
    if (!this.isInitialized) {
      return this.initialize();
    }
    return true;
  }

  /**
   * Terminate the worker
   */
  public terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
    }
  }

  /**
   * Event emitter methods
   */
  private listeners: { [key in SyncEvent]?: Array<(data: any) => void> } = {};

  public on(event: SyncEvent, callback: (data: any) => void): void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event]?.push(callback);
  }

  public off(event: SyncEvent, callback: (data: any) => void): void {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event]?.filter(cb => cb !== callback);
  }

  private emit(event: SyncEvent, data: any): void {
    if (!this.listeners[event]) return;
    this.listeners[event]?.forEach(callback => callback(data));
  }
}

// Export the singleton instance
export const workerManager = SyncWorkerManager.getInstance(); 