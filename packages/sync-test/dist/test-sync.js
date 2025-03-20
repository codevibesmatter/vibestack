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
    currentState;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.clientId = uuidv4();
        this.connected = false;
        this.messageLog = [];
        this.messageId = 0;
        this.ws = null;
        this.currentState = 'initial';
    }
    async connect() {
        if (this.connected) {
            throw new Error('Already connected');
        }
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.config.wsUrl);
            this.ws.on('open', () => {
                this.connected = true;
                resolve();
            });
            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
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
    handleMessage(message) {
        // Only log the message and track basic state
        this.messageLog.push(message);
        if ('type' in message && message.type === 'srv_state_change') {
            this.currentState = message.state;
        }
    }
    // Helper methods for tests
    getMessagesByType(type) {
        return this.messageLog.filter(msg => msg.type === type);
    }
    getLastMessage(type) {
        const messages = this.messageLog.filter((msg) => msg.type === type);
        return messages[messages.length - 1];
    }
    getCurrentState() {
        return this.currentState;
    }
    clearMessageLog() {
        this.messageLog = [];
    }
    getMessageLog() {
        return this.messageLog;
    }
    nextMessageId() {
        return `clt_${Date.now()}_${this.messageId++}`;
    }
    /**
     * Run the test scenario
     */
    async runTest() {
        // Wait for initial sync to complete
        await this.waitForState('live');
        // Run basic validation
        await this.validateSync();
        // Disconnect cleanly
        await this.disconnect(1000, 'Test complete');
    }
    /**
     * Wait for a specific sync state
     */
    async waitForState(targetState, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const checkState = () => {
                if (this.currentState === targetState) {
                    resolve();
                }
                else if (Date.now() - start > timeout) {
                    reject(new Error(`Timeout waiting for state ${targetState}`));
                }
                else {
                    setTimeout(checkState, 100);
                }
            };
            checkState();
        });
    }
    /**
     * Validate the sync process
     */
    async validateSync() {
        // Basic validation that we received messages in order
        const initStart = this.messageLog.find(m => m.type === 'srv_init_start');
        const initComplete = this.messageLog.find(m => m.type === 'srv_init_complete');
        const stateChange = this.messageLog.find(m => m.type === 'srv_state_change');
        if (!initStart)
            throw new Error('Missing srv_init_start message');
        if (!initComplete)
            throw new Error('Missing srv_init_complete message');
        if (!stateChange)
            throw new Error('Missing srv_state_change message');
        // Validate message order
        const initStartIndex = this.messageLog.indexOf(initStart);
        const initCompleteIndex = this.messageLog.indexOf(initComplete);
        const stateChangeIndex = this.messageLog.indexOf(stateChange);
        if (initStartIndex > initCompleteIndex) {
            throw new Error('srv_init_start received after srv_init_complete');
        }
        if (initCompleteIndex > stateChangeIndex) {
            throw new Error('srv_init_complete received after srv_state_change');
        }
    }
}
