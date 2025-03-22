import type { Message } from '@repo/sync-types';
import type { Config } from './types.js';
export declare class SyncTester {
    protected config: Config;
    protected clientId: string;
    private connected;
    private messageLog;
    private messageId;
    private ws;
    private serverLSN;
    onMessage: ((message: Message) => void) | null;
    constructor(config?: Partial<Config>);
    connect(lsn?: string, clientId?: string): Promise<void>;
    disconnect(code?: number, reason?: string): Promise<void>;
    sendMessage(message: Message): Promise<void>;
    /**
     * Handle an incoming message
     */
    private handleMessage;
    getMessagesByType<T extends Message>(type: string): T[];
    getLastMessage<T extends Message>(type: string): T | undefined;
    getServerLSN(): string;
    clearMessageLog(): void;
    /**
     * Get the message log for analysis
     */
    getMessageLog(): Message[];
    /**
     * Get the client ID
     */
    getClientId(): string;
    /**
     * Generate a unique message ID
     */
    protected nextMessageId(): string;
    /**
     * Check if tester is connected
     */
    isConnected(): boolean;
}
