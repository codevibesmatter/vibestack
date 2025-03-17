import WebSocket from 'ws';
const DEFAULT_CONFIG = {
    wsUrl: 'ws://localhost:8787',
    connectTimeout: 10000,
    syncWaitTime: 1000,
    changeWaitTime: 2000,
    chunkTimeout: 30000 // 30 seconds timeout for chunks
};
class SyncTester {
    config;
    clientId;
    lastLSN;
    connected;
    messageLog;
    messageId;
    pendingChunks;
    ws;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.clientId = '123e4567-e89b-12d3-a456-426614174000';
        this.lastLSN = '0/0';
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
    nextMessageId() {
        return `msg_${++this.messageId}`;
    }
    connect() {
        return new Promise((resolve, reject) => {
            console.log(`Connecting to ${this.config.wsUrl} with clientId ${this.clientId}`);
            const url = new URL('/api/sync', this.config.wsUrl);
            url.searchParams.set('clientId', this.clientId);
            console.log('WebSocket URL:', url.toString());
            this.ws = new WebSocket(url.toString());
            this.ws.on('open', () => {
                console.log('Connected to sync server');
                this.connected = true;
                resolve();
            });
            this.ws.on('message', (data) => {
                try {
                    console.log('Raw message received:', data.toString());
                    const message = JSON.parse(data.toString());
                    console.log('Parsed message:', JSON.stringify(message, null, 2));
                    this.handleMessage(message);
                }
                catch (error) {
                    console.error('Error handling message:', error);
                    console.error('Raw message data:', data.toString());
                }
            });
            this.ws.on('error', (error) => {
                console.error('WebSocket error:', error.message);
                if ('cause' in error) {
                    console.error('Error cause:', error.cause);
                }
                reject(error);
            });
            this.ws.on('close', (code, reason) => {
                console.log('Disconnected from sync server', { code, reason: reason.toString() });
                this.connected = false;
            });
            // Connection timeout
            setTimeout(() => {
                if (!this.connected) {
                    const error = new Error('Connection timeout');
                    console.error(error);
                    reject(error);
                }
            }, this.config.connectTimeout);
        });
    }
    handleMessage(message) {
        console.log('Processing message:', JSON.stringify(message, null, 2));
        this.messageLog.push(message);
        switch (message.type) {
            case 'srv_sync_init':
                console.log('Handling sync init');
                this.handleSyncInit(message);
                break;
            case 'srv_changes':
                console.log('Handling server changes');
                this.handleServerChanges(message);
                break;
            case 'srv_changes_received':
                console.log('Server received our changes');
                this.handleServerReceived(message);
                break;
            case 'srv_changes_applied':
                console.log('Server applied our changes');
                this.handleServerApplied(message);
                break;
            case 'srv_error':
                console.log('Received error:', message);
                break;
            case 'srv_heartbeat':
                // Ignore heartbeat messages in logs
                break;
            default:
                console.log('Unknown message type:', message.type);
        }
    }
    handleSyncInit(message) {
        console.log('Received sync init:', message);
        if (message.serverLSN) {
            this.lastLSN = message.serverLSN;
            console.log('Updated lastLSN to:', this.lastLSN);
        }
    }
    handleServerChanges(message) {
        const changeCount = message.changes?.length || 0;
        console.log('Received server changes:', {
            count: changeCount,
            chunk: message.sequence?.chunk,
            total: message.sequence?.total,
            lastLSN: message.lastLSN
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
            console.log('Chunk processing metrics:', {
                messageId: key,
                receivedChunks: chunkSet.receivedCount,
                totalChunks: message.sequence.total,
                totalChanges: chunkSet.totalSize,
                timeElapsed: Date.now() - chunkSet.startTime
            });
            // Check if we have all chunks
            if (chunkSet.receivedCount === message.sequence.total) {
                console.log('All chunks received, processing complete change set');
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
                this.processChanges(allChanges, message.lastLSN);
                this.pendingChunks.delete(key);
                console.log('Chunk processing complete:', {
                    messageId: key,
                    totalChanges: allChanges.length,
                    processingTime: Date.now() - chunkSet.startTime
                });
            }
            else {
                console.log(`Waiting for more chunks (${chunkSet.receivedCount}/${message.sequence.total})`);
            }
        }
        else {
            // Handle single chunk
            this.processChanges(message.changes, message.lastLSN);
        }
    }
    processChanges(changes, lastLSN) {
        if (lastLSN) {
            this.lastLSN = lastLSN;
        }
        // First send received acknowledgment
        const receivedAck = {
            type: 'clt_changes_received',
            messageId: this.nextMessageId(),
            timestamp: Date.now(),
            lastLSN: this.lastLSN
        };
        this.sendMessage(receivedAck);
        // Then send applied acknowledgment
        const appliedAck = {
            type: 'clt_changes_applied',
            messageId: this.nextMessageId(),
            timestamp: Date.now(),
            lastLSN: this.lastLSN,
            appliedChanges: changes.map(c => c.lsn)
        };
        this.sendMessage(appliedAck);
    }
    handleServerReceived(message) {
        console.log('Server received changes:', message.changeIds);
    }
    handleServerApplied(message) {
        console.log('Server applied changes:', message.appliedChanges);
        if (!message.success) {
            console.error('Failed to apply changes:', message.error);
        }
    }
    sendMessage(message) {
        if (!this.connected || !this.ws) {
            console.warn('Not connected - cannot send message');
            return;
        }
        const messageStr = JSON.stringify(message, null, 2);
        console.log('Sending message:', messageStr);
        this.ws.send(JSON.stringify(message));
        // Log outgoing messages too
        this.messageLog.push(message);
    }
    requestSync() {
        const syncRequest = {
            type: 'clt_sync_request',
            messageId: this.nextMessageId(),
            timestamp: Date.now(),
            lastLSN: this.lastLSN
        };
        this.sendMessage(syncRequest);
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
}
async function runSyncTest() {
    // Get environment configuration
    const config = {
        wsUrl: process.env.SYNC_WS_URL || DEFAULT_CONFIG.wsUrl,
        connectTimeout: parseInt(process.env.SYNC_CONNECT_TIMEOUT || '') || DEFAULT_CONFIG.connectTimeout,
        syncWaitTime: parseInt(process.env.SYNC_WAIT_TIME || '') || DEFAULT_CONFIG.syncWaitTime,
        changeWaitTime: parseInt(process.env.SYNC_CHANGE_WAIT_TIME || '') || DEFAULT_CONFIG.changeWaitTime
    };
    console.log('Starting sync test with configuration:', config);
    const tester = new SyncTester(config);
    try {
        // Connect and wait for sync init
        await tester.connect();
        console.log('Connected successfully');
        // Wait a bit to ensure we receive the sync init message
        await new Promise(resolve => setTimeout(resolve, config.syncWaitTime));
        // Request initial sync to receive chunked updates
        console.log('Requesting initial sync');
        tester.requestSync();
        // Wait for sync response and chunk processing
        await new Promise(resolve => setTimeout(resolve, config.syncWaitTime * 2));
        // Disconnect
        await tester.disconnect();
        console.log('Test completed successfully');
        // Print message log
        console.log('\nMessage Log:');
        console.log(JSON.stringify(tester.getMessageLog(), null, 2));
    }
    catch (error) {
        console.error('Test failed:', error);
        await tester.disconnect(4000, 'Test failed');
        process.exit(1);
    }
}
// Run the test if this is the main module
if (process.argv[1] === new URL(import.meta.url).pathname) {
    runSyncTest().catch(error => {
        console.error('Unhandled error:', error);
        process.exit(1);
    });
}
