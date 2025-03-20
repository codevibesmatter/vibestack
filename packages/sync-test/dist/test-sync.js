import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import inquirer from 'inquirer';
import { serverDataSource } from '@repo/typeorm';
import { Task, Project, User, Comment, SERVER_DOMAIN_TABLES } from '@repo/typeorm/server-entities';
import { generateSingleChange, generateBulkChanges } from './changes/client-changes.js';
import { createServerChange, createServerBulkChanges } from './changes/server-changes.js';
import { DEFAULT_CONFIG } from './config.js';
import fs from 'fs';
import path from 'path';
const ENTITY_MAP = {
    tasks: Task,
    projects: Project,
    users: User,
    comments: Comment
};
export class SyncTester {
    config;
    clientId;
    lastLSN;
    connected;
    messageLog;
    messageId;
    pendingChunks;
    ws;
    currentState = 'initial';
    pendingInitialChanges = 0;
    lsnFile;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.clientId = uuidv4();
        this.lsnFile = path.join(process.cwd(), '.sync-test-lsn.json');
        this.lastLSN = this.loadLSN();
        this.connected = false;
        this.messageLog = [];
        this.messageId = 0;
        this.pendingChunks = new Map();
        this.ws = null;
        // Add timestamp to all console logs
        const originalLog = console.log;
        console.log = (...args) => {
            originalLog(`[${new Date().toISOString()}]`, ...args);
        };
    }
    loadLSN() {
        try {
            if (fs.existsSync(this.lsnFile)) {
                const data = JSON.parse(fs.readFileSync(this.lsnFile, 'utf8'));
                console.log('Loaded LSN from file:', data.lsn);
                return data.lsn;
            }
        }
        catch (err) {
            console.warn('Error loading LSN file:', err);
        }
        return '0/0';
    }
    saveLSN(lsn) {
        try {
            fs.writeFileSync(this.lsnFile, JSON.stringify({ lsn }, null, 2));
            console.log('Saved LSN to file:', lsn);
        }
        catch (err) {
            console.error('Error saving LSN file:', err);
        }
    }
    nextMessageId() {
        return `msg_${++this.messageId}`;
    }
    /**
     * Register client with the server before connecting
     * This is needed because the server expects clients to be in the registry
     */
    async registerClient() {
        console.log(`Registering client ${this.clientId} with the server`);
        try {
            // Send a request to register the client
            const url = new URL('/api/register-client', this.config.wsUrl);
            const response = await fetch(url.toString(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    clientId: this.clientId,
                    lsn: this.lastLSN
                })
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to register client: ${response.status} ${errorText}`);
            }
            const data = await response.json();
            console.log('Client registration successful:', data);
        }
        catch (error) {
            console.error('Error registering client:', error instanceof Error ? error.message : String(error));
            console.warn('Continuing with connection anyway - server might handle registration internally');
        }
    }
    async connect() {
        try {
            // Try to register the client first
            await this.registerClient();
        }
        catch (err) {
            console.warn('Client registration failed, but continuing with connection');
        }
        return new Promise((resolve, reject) => {
            console.log(`Connecting to ${this.config.wsUrl} with clientId ${this.clientId} and LSN ${this.lastLSN}`);
            const url = new URL('/api/sync', this.config.wsUrl);
            url.searchParams.set('clientId', this.clientId);
            url.searchParams.set('lsn', this.lastLSN);
            console.log('WebSocket URL:', url.toString());
            this.ws = new WebSocket(url.toString());
            this.ws.on('open', () => {
                console.log('WebSocket connection established');
                this.connected = true;
                resolve();
            });
            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    // Log a summary instead of full message
                    if (message.type === 'srv_send_changes') {
                        console.log('Received message:', {
                            type: message.type,
                            messageId: message.messageId,
                            changeCount: message.changes?.length || 0,
                            sequence: message.sequence,
                            lastLSN: message.lastLSN
                        });
                    }
                    else {
                        console.log('Received message:', {
                            type: message.type,
                            messageId: message.messageId,
                            timestamp: new Date(message.timestamp).toISOString()
                        });
                    }
                    this.handleMessage(message);
                }
                catch (error) {
                    console.error('Error handling message:', error);
                }
            });
            this.ws.on('error', (error) => {
                const state = this.ws?.readyState;
                const stateStr = state === 0 ? 'CONNECTING'
                    : state === 1 ? 'OPEN'
                        : state === 2 ? 'CLOSING'
                            : 'CLOSED';
                console.error('WebSocket error:', {
                    message: error.message,
                    state: stateStr,
                    ...(('cause' in error) && { cause: error.cause })
                });
                reject(error);
            });
            this.ws.on('close', (code, reason) => {
                console.log('WebSocket closed:', {
                    code,
                    reason: reason.toString(),
                    wasConnected: this.connected
                });
                this.connected = false;
            });
            // Connection timeout
            setTimeout(() => {
                if (!this.connected) {
                    console.error('Connection timeout after', this.config.connectTimeout, 'ms');
                    console.error('Final WebSocket readyState:', this.ws?.readyState);
                    const error = new Error('Connection timeout');
                    reject(error);
                }
            }, this.config.connectTimeout);
        });
    }
    handleMessage(message) {
        // Log a summary instead of full JSON
        switch (message.type) {
            case 'srv_init_start':
                this.lastLSN = '0/0'; // Always start initial sync at 0/0
                this.currentState = 'initial';
                console.log('Initial sync started with LSN 0/0');
                break;
            case 'srv_init_changes':
                if (this.currentState === 'initial') {
                    console.log('Processing initial sync chunk');
                    void this.handleInitialChanges(message)
                        .catch(err => {
                        console.error('Error handling initial changes:', err);
                    });
                }
                break;
            case 'srv_init_complete':
                console.log('Initial sync base data completed');
                break;
            case 'srv_state_change':
                const stateMsg = message;
                if (this.currentState === 'initial' && stateMsg.state === 'live') {
                    console.log('Initial sync and catchup complete, saving LSN:', stateMsg.lsn);
                    this.saveLSN(stateMsg.lsn);
                }
                this.lastLSN = stateMsg.lsn;
                this.currentState = stateMsg.state;
                break;
            case 'srv_send_changes':
                const changesMsg = message;
                console.log('Server changes:', {
                    count: changesMsg.changes?.length || 0,
                    chunk: changesMsg.sequence?.chunk,
                    total: changesMsg.sequence?.total,
                    lastLSN: changesMsg.lastLSN
                });
                this.handleServerChanges(changesMsg);
                break;
            case 'srv_changes_received':
                console.log('Server received changes:', {
                    count: message.changeIds.length
                });
                break;
            case 'srv_changes_applied':
                const appliedMsg = message;
                console.log('Server applied changes:', {
                    count: appliedMsg.appliedChanges.length,
                    success: appliedMsg.success,
                    error: appliedMsg.error
                });
                break;
            case 'srv_error':
                console.log('Server error:', message.type);
                break;
            case 'srv_heartbeat':
                console.log('Received heartbeat');
                break;
            default:
                console.log('Unknown message type:', message.type);
        }
        // Add message to log without full JSON
        this.messageLog.push({
            ...message,
            changes: message.type === 'srv_send_changes' || message.type === 'srv_init_changes'
                ? `[${message.changes?.length || 0} changes]`
                : undefined
        });
    }
    async handleInitialChanges(message) {
        if (!message.changes?.length) {
            return;
        }
        // Send received acknowledgment immediately
        const receivedAck = {
            type: 'clt_init_received',
            messageId: this.nextMessageId(),
            timestamp: Date.now(),
            clientId: this.clientId
        };
        await this.sendMessage(receivedAck);
        // Simulate processing time based on number of changes
        const processingTime = Math.min(message.changes.length * 10, 1000);
        await new Promise(resolve => setTimeout(resolve, processingTime));
        // Send processed acknowledgment after processing the chunk
        const processedAck = {
            type: 'clt_init_processed',
            messageId: this.nextMessageId(),
            timestamp: Date.now(),
            clientId: this.clientId
        };
        await this.sendMessage(processedAck);
        console.log('Initial sync chunk processed:', {
            count: message.changes.length,
            processingTime,
            state: this.currentState,
            tables: [...new Set(message.changes.map(c => c.table))]
        });
    }
    handleInitComplete() {
        console.log('Initial sync completed');
        // Any additional completion logic can go here
    }
    handleServerChanges(message) {
        if (!message.changes)
            return;
        // Update LSN and save it
        if (message.lastLSN) {
            this.lastLSN = message.lastLSN;
            this.saveLSN(message.lastLSN);
        }
        // Skip processing during initial sync since we handle that separately
        if (this.currentState === 'initial') {
            console.log('Skipping server changes processing during initial sync');
            return;
        }
        const changeCount = message.changes?.length || 0;
        console.log('Processing server changes:', {
            count: changeCount,
            chunk: message.sequence?.chunk,
            total: message.sequence?.total,
            lastLSN: message.lastLSN,
            currentState: this.currentState
        });
        // Handle chunked changes
        if (message.sequence && message.sequence.total > 1) {
            // Validate chunk number
            if (message.sequence.chunk < 1 || message.sequence.chunk > message.sequence.total) {
                console.error('Invalid chunk number:', message.sequence);
                return;
            }
            const key = message.messageId.split('_')[1]; // Extract timestamp part
            let chunkSet = this.pendingChunks.get(key);
            // Initialize new chunk set if this is the first chunk
            if (!chunkSet) {
                const timer = setTimeout(() => {
                    console.error(`Chunk set ${key} timed out after ${this.config.chunkTimeout}ms`);
                    this.pendingChunks.delete(key);
                }, this.config.chunkTimeout);
                chunkSet = {
                    chunks: new Array(message.sequence.total),
                    timer,
                    startTime: Date.now(),
                    receivedCount: 0,
                    totalSize: 0
                };
                this.pendingChunks.set(key, chunkSet);
            }
            // Store the chunk
            const index = message.sequence.chunk - 1;
            if (chunkSet.chunks[index]) {
                console.warn(`Duplicate chunk received for index ${index}`);
                return;
            }
            chunkSet.chunks[index] = message.changes;
            chunkSet.receivedCount++;
            chunkSet.totalSize += changeCount;
            console.log('Chunk progress:', {
                messageId: key,
                receivedChunks: chunkSet.receivedCount,
                totalChunks: message.sequence.total,
                totalChanges: chunkSet.totalSize,
                timeElapsed: Date.now() - chunkSet.startTime
            });
            // Check if we have all chunks
            if (chunkSet.receivedCount === message.sequence.total) {
                clearTimeout(chunkSet.timer);
                // Validate no missing chunks
                const allChanges = chunkSet.chunks.flat();
                if (allChanges.length !== chunkSet.totalSize) {
                    console.error('Chunk size mismatch:', {
                        expected: chunkSet.totalSize,
                        actual: allChanges.length
                    });
                    this.pendingChunks.delete(key);
                    return;
                }
                // Update LSN and process changes
                if (message.lastLSN) {
                    this.lastLSN = message.lastLSN;
                }
                void this.processChanges(allChanges).catch(err => {
                    console.error('Error processing changes:', err);
                });
                this.pendingChunks.delete(key);
            }
        }
        else {
            // Handle single chunk - process immediately
            if (message.lastLSN) {
                this.lastLSN = message.lastLSN;
            }
            void this.processChanges(message.changes).catch(err => {
                console.error('Error processing changes:', err);
            });
        }
    }
    async processChanges(changes) {
        // For catchup/live sync, include change IDs and LSN
        const receivedAck = {
            type: 'clt_changes_received',
            messageId: this.nextMessageId(),
            timestamp: Date.now(),
            clientId: this.clientId,
            changeIds: changes.map(c => c.lsn || '').filter(Boolean),
            lastLSN: this.lastLSN
        };
        await this.sendMessage(receivedAck);
        // Simulate processing time based on number of changes
        const processingTime = Math.min(changes.length * 10, 1000);
        await new Promise(resolve => setTimeout(resolve, processingTime));
        // Send applied acknowledgment after processing
        const appliedAck = {
            type: 'clt_changes_applied',
            messageId: this.nextMessageId(),
            timestamp: Date.now(),
            clientId: this.clientId,
            changeIds: changes.map(c => c.lsn || '').filter(Boolean),
            lastLSN: this.lastLSN
        };
        await this.sendMessage(appliedAck);
        console.log('Changes processed:', {
            count: changes.length,
            processingTime,
            state: this.currentState,
            lastLSN: this.lastLSN
        });
    }
    handleStateChange(message) {
        const previousState = this.currentState;
        const previousLSN = this.lastLSN;
        this.currentState = message.state;
        this.lastLSN = message.lsn;
        // Save LSN when state changes
        this.saveLSN(message.lsn);
        // Log state transition with LSN comparison
        if (previousState !== message.state) {
            console.log('State transition:', {
                from: previousState,
                to: message.state,
                lsnDelta: `${previousLSN} -> ${message.lsn}`
            });
        }
        // Send heartbeat with our new state and LSN
        const heartbeat = {
            type: 'clt_heartbeat',
            messageId: this.nextMessageId(),
            timestamp: Date.now(),
            clientId: this.clientId,
            state: message.state,
            lsn: message.lsn,
            active: true
        };
        try {
            this.sendMessage(heartbeat);
            console.log('Sent state change heartbeat');
        }
        catch (error) {
            console.error('Failed to send heartbeat', error);
        }
        // State transition logic with LSN context
        if (message.state === 'live' && previousState !== 'live') {
            console.log('🔄 Sync is now live:', {
                startLSN: previousLSN,
                currentLSN: message.lsn,
                message: 'All historical changes have been processed'
            });
        }
        else if (message.state === 'catchup' && previousState === 'initial') {
            console.log('📥 Starting catchup sync:', {
                startLSN: previousLSN,
                targetLSN: message.lsn,
                message: 'Receiving historical changes'
            });
        }
    }
    sendMessage(message) {
        if (!this.connected || !this.ws) {
            throw new Error('Not connected to WebSocket');
        }
        this.ws.send(JSON.stringify(message));
    }
    acknowledgeChanges(changes) {
        const message = {
            type: 'clt_changes_received',
            messageId: this.nextMessageId(),
            timestamp: Date.now(),
            clientId: this.clientId,
            lastLSN: this.lastLSN,
            changeIds: changes.map(c => c.lsn || '').filter((id) => Boolean(id))
        };
        this.sendMessage(message);
    }
    confirmChanges(changes) {
        const message = {
            type: 'clt_changes_applied',
            messageId: this.nextMessageId(),
            timestamp: Date.now(),
            clientId: this.clientId,
            lastLSN: this.lastLSN,
            changeIds: changes.map(c => c.lsn || '').filter((id) => Boolean(id))
        };
        this.sendMessage(message);
    }
    /**
     * Request sync from server
     * Note: This is generally not needed in normal operation as the server
     * automatically starts sending changes after connection. This method
     * is kept for manual testing purposes.
     */
    requestSync() {
        console.log('Manually requesting sync (normally not needed)');
        const message = {
            type: 'clt_sync_request',
            messageId: this.nextMessageId(),
            timestamp: Date.now(),
            clientId: this.clientId
        };
        this.sendMessage(message);
    }
    disconnect(code = 1000, reason = 'Test completed') {
        return new Promise((resolve) => {
            if (!this.ws) {
                resolve();
                return;
            }
            console.log('Disconnecting...', { code, reason });
            // Listen for close before initiating close
            this.ws.once('close', (code, reason) => {
                console.log('WebSocket closed:', { code, reason: reason.toString() });
                resolve();
            });
            // Use code 4000 for test failures, 1000 for normal closure
            this.ws.close(code, reason);
        });
    }
    getMessageLog() {
        return this.messageLog;
    }
    async showMainMenu() {
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'What would you like to do?',
                choices: [
                    { name: 'Request Server Sync (Manual Override)', value: 'sync' },
                    { name: 'Send Single Client Change', value: 'single' },
                    { name: 'Send 200 Client Changes', value: 'bulk' },
                    { name: 'Create Single Server Change', value: 'server_single' },
                    { name: 'Create 100 Server Changes', value: 'server_bulk' },
                    { name: 'View Message Log', value: 'log' },
                    { name: 'View Current Sync State', value: 'state' },
                    { name: 'Disconnect', value: 'disconnect' },
                    { name: 'Exit', value: 'exit' }
                ]
            }
        ]);
        switch (action) {
            case 'sync':
                console.log('Manually requesting server sync (usually not needed)...');
                this.requestSync();
                break;
            case 'single':
                await this.sendSingleChange();
                break;
            case 'bulk':
                await this.sendBulkChanges();
                break;
            case 'server_single':
                await this.handleServerChange();
                break;
            case 'server_bulk':
                await this.handleServerBulkChanges();
                break;
            case 'log':
                this.showMessageLog();
                break;
            case 'state':
                console.log(`Current sync state: ${this.currentState}`);
                break;
            case 'disconnect':
                await this.disconnect();
                return false;
            case 'exit':
                return false;
        }
        return true;
    }
    async sendSingleChange() {
        const { table } = await inquirer.prompt([
            {
                type: 'list',
                name: 'table',
                message: 'Select table:',
                choices: SERVER_DOMAIN_TABLES
            }
        ]);
        const entityClass = ENTITY_MAP[table];
        const change = await generateSingleChange(entityClass);
        await this.sendChanges([change]);
    }
    async sendBulkChanges() {
        const { table } = await inquirer.prompt([
            {
                type: 'list',
                name: 'table',
                message: 'Select table:',
                choices: SERVER_DOMAIN_TABLES
            }
        ]);
        const entityClass = ENTITY_MAP[table];
        const changes = await generateBulkChanges(entityClass, 200);
        await this.sendChanges(changes);
    }
    async handleServerChange() {
        const { table, operation } = await inquirer.prompt([
            {
                type: 'list',
                name: 'table',
                message: 'Select table:',
                choices: SERVER_DOMAIN_TABLES
            },
            {
                type: 'list',
                name: 'operation',
                message: 'Select operation:',
                choices: ['insert', 'update', 'delete']
            }
        ]);
        const entityClass = ENTITY_MAP[table];
        await createServerChange(serverDataSource, entityClass, operation);
    }
    async handleServerBulkChanges() {
        const { table } = await inquirer.prompt([
            {
                type: 'list',
                name: 'table',
                message: 'Select table:',
                choices: SERVER_DOMAIN_TABLES
            }
        ]);
        const entityClass = ENTITY_MAP[table];
        await createServerBulkChanges(serverDataSource, entityClass, 100);
    }
    async sendChanges(changes) {
        if (!this.connected || !this.ws) {
            throw new Error('Not connected to WebSocket');
        }
        const message = {
            type: 'clt_send_changes',
            messageId: this.nextMessageId(),
            timestamp: Date.now(),
            clientId: this.clientId,
            changes
        };
        this.ws.send(JSON.stringify(message));
    }
    showMessageLog() {
        console.log('\nMessage Log:');
        this.messageLog.forEach((msg, i) => {
            console.log(`${i + 1}. ${msg.type} (${new Date(msg.timestamp).toISOString()})`);
        });
        console.log();
    }
    getCurrentState() {
        return this.currentState;
    }
}
// Run the interactive menu if this is the main module
if (process.argv[1] === new URL(import.meta.url).pathname) {
    const config = {
        wsUrl: process.env.SYNC_WS_URL || DEFAULT_CONFIG.wsUrl,
        connectTimeout: parseInt(process.env.SYNC_CONNECT_TIMEOUT || '') || DEFAULT_CONFIG.connectTimeout,
        syncWaitTime: parseInt(process.env.SYNC_WAIT_TIME || '') || DEFAULT_CONFIG.syncWaitTime,
        changeWaitTime: parseInt(process.env.SYNC_CHANGE_WAIT_TIME || '') || DEFAULT_CONFIG.changeWaitTime
    };
    console.log('Starting interactive sync tester with config:', config);
    const tester = new SyncTester(config);
    tester.connect().then(async () => {
        console.log('Connected to sync server');
        let keepRunning = true;
        while (keepRunning) {
            keepRunning = await tester.showMainMenu();
        }
        console.log('Exiting...');
        process.exit(0);
    }).catch(error => {
        console.error('Error:', error);
        process.exit(1);
    });
}
