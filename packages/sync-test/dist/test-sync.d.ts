import type { Message } from '@repo/sync-types';
import type { Config } from './types.js';
export declare class SyncTester {
    protected config: Config;
    protected clientId: string;
    private connected;
    private messageLog;
    private messageId;
    private ws;
    private currentState;
    constructor(config?: Partial<Config>);
    connect(): Promise<void>;
    disconnect(code?: number, reason?: string): Promise<void>;
    sendMessage(message: Message): Promise<void>;
    private handleMessage;
    getMessagesByType<T extends Message>(type: string): T[];
    getLastMessage<T extends Message>(type: string): T | undefined;
    getCurrentState(): 'initial' | 'catchup' | 'live';
    clearMessageLog(): void;
    getMessageLog(): Message[];
    protected nextMessageId(): string;
    /**
     * Run the test scenario
     */
    runTest(): Promise<void>;
    /**
     * Wait for a specific sync state
     */
    private waitForState;
    /**
     * Validate the sync process
     */
    private validateSync;
}
//# sourceMappingURL=test-sync.d.ts.map