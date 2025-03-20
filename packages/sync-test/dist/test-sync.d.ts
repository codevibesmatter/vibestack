import type { Message } from '@repo/sync-types';
import type { Config } from './types.js';
export declare class SyncTester {
    private config;
    private clientId;
    private lastLSN;
    private connected;
    private messageLog;
    private messageId;
    private pendingChunks;
    private ws;
    private currentState;
    private pendingInitialChanges;
    private lsnFile;
    constructor(config?: Partial<Config>);
    private loadLSN;
    private saveLSN;
    private nextMessageId;
    /**
     * Register client with the server before connecting
     * This is needed because the server expects clients to be in the registry
     */
    registerClient(): Promise<void>;
    connect(): Promise<void>;
    private handleMessage;
    private handleInitialChanges;
    private handleInitComplete;
    private handleServerChanges;
    private processChanges;
    private handleStateChange;
    private sendMessage;
    private acknowledgeChanges;
    private confirmChanges;
    /**
     * Request sync from server
     * Note: This is generally not needed in normal operation as the server
     * automatically starts sending changes after connection. This method
     * is kept for manual testing purposes.
     */
    requestSync(): void;
    disconnect(code?: number, reason?: string): Promise<void>;
    getMessageLog(): (Message)[];
    getMessageLog(): (Message)[];
    showMainMenu(): Promise<boolean>;
    private sendSingleChange;
    private sendBulkChanges;
    private handleServerChange;
    private handleServerBulkChanges;
    private sendChanges;
    private showMessageLog;
    getCurrentState(): 'initial' | 'catchup' | 'live';
}
//# sourceMappingURL=test-sync.d.ts.map