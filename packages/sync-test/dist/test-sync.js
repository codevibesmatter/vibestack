import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { Task, Project, User, Comment } from '@repo/dataforge/server-entities';
import { DEFAULT_CONFIG } from './config.js';
const ENTITY_MAP = {
    tasks: Task,
    projects: Project,
    users: User,
    comments: Comment
};
export class SyncTester {
    config;
    clientId;
    connected;
    messageLog;
    messageId;
    ws;
    serverLSN = '0/0';
    onMessage = null;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.clientId = uuidv4();
        this.connected = false;
        this.messageLog = [];
        this.messageId = 0;
        this.ws = null;
    }
    // Connect with optional LSN and client ID for catchup sync
    async connect(lsn, clientId) {
        if (this.connected) {
            throw new Error('Already connected');
        }
        // Use provided client ID if available
        if (clientId) {
            this.clientId = clientId;
        }
        // Build URL with parameters
        const wsUrl = new URL(this.config.wsUrl);
        wsUrl.searchParams.set('clientId', this.clientId);
        if (lsn) {
            wsUrl.searchParams.set('lsn', lsn);
        }
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(wsUrl.toString());
            this.ws.on('open', () => {
                this.connected = true;
                resolve();
            });
            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    console.log(`Received message: ${message.type}`);
                    this.handleMessage(message);
                }
                catch (err) {
                    console.error('Error parsing message:', err);
                }
            });
            this.ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                reject(error);
            });
            this.ws.on('close', () => {
                this.connected = false;
                this.ws = null;
            });
            // Connection timeout
            setTimeout(() => {
                if (!this.connected) {
                    reject(new Error('Connection timeout'));
                }
            }, this.config.connectTimeout);
        });
    }
    async disconnect(code, reason) {
        if (this.ws) {
            this.ws.close(code, reason);
        }
        this.connected = false;
        this.ws = null;
    }
    async sendMessage(message) {
        if (!this.connected || !this.ws) {
            throw new Error('Not connected');
        }
        await new Promise((resolve, reject) => {
            this.ws.send(JSON.stringify(message), (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    /**
     * Handle an incoming message
     */
    handleMessage(message) {
        // Add message to log
        this.messageLog.push(message);
        // Log all incoming messages with a basic type indicator
        if ('type' in message) {
            const type = message.type;
            const shortType = type.substring(0, 12);
            console.log(`📩 RECEIVED: ${shortType.padEnd(12)} (total messages: ${this.messageLog.length})`);
        }
        // Call the onMessage handler if set
        if (this.onMessage) {
            this.onMessage(message);
        }
        // Store LSN updates for later reference
        if ('type' in message && message.type === 'srv_lsn_update') {
            const lsnUpdateMessage = message;
            this.serverLSN = lsnUpdateMessage.lsn;
        }
    }
    // Helper methods for tests
    getMessagesByType(type) {
        return this.messageLog.filter(msg => 'type' in msg && msg.type === type);
    }
    getLastMessage(type) {
        const messages = this.messageLog.filter((msg) => 'type' in msg && msg.type === type);
        return messages[messages.length - 1];
    }
    getServerLSN() {
        return this.serverLSN;
    }
    clearMessageLog() {
        this.messageLog = [];
    }
    /**
     * Get the message log for analysis
     */
    getMessageLog() {
        return this.messageLog;
    }
    /**
     * Get the client ID
     */
    getClientId() {
        return this.clientId;
    }
    /**
     * Generate a unique message ID
     */
    nextMessageId() {
        return `clt_${Date.now()}_${this.messageId++}`;
    }
    /**
     * Check if tester is connected
     */
    isConnected() {
        return this.connected;
    }
}
