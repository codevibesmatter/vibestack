import { workerManager } from './worker-manager';
import { syncLogger } from '../utils/logger';

/**
 * Handles sync operations in the main thread
 */
export class SyncInterface {
  private static instance: SyncInterface | null = null;

  private constructor() {}

  public static getInstance(): SyncInterface {
    if (!SyncInterface.instance) {
      SyncInterface.instance = new SyncInterface();
    }
    return SyncInterface.instance;
  }

  /**
   * Reset the LSN and trigger a fresh sync
   */
  public async resetLSN(): Promise<void> {
    syncLogger.info('Initiating LSN reset');
    await workerManager.sendMessage('send_message', {
      type: 'sync',
      payload: {
        resetSync: true
      }
    });
    syncLogger.info('LSN reset initiated');
  }
} 