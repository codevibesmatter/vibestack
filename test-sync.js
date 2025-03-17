const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

class SyncTester {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.clientId = uuidv4();
    this.lastLSN = '0/0';
    this.connected = false;
    this.messageLog = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      console.log(`Connecting to ${this.wsUrl} with clientId ${this.clientId}`);
      
      const url = new URL('/api/sync', this.wsUrl);
      url.searchParams.set('clientId', this.clientId);
      
      this.ws = new WebSocket(url.toString());
      
      this.ws.on('open', () => {
        console.log('Connected to sync server');
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (data) => {
        const message = JSON.parse(data);
        this.handleMessage(message);
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });

      this.ws.on('close', () => {
        console.log('Disconnected from sync server');
        this.connected = false;
      });

      // Connection timeout
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  handleMessage(message) {
    console.log('Received message:', message);
    this.messageLog.push(message);

    switch (message.type) {
      case 'sync_request':
        this.handleSyncRequest();
        break;
      
      case 'sync_ack':
        this.handleSyncAck(message);
        break;
      
      case 'changes':
        this.handleChanges(message);
        break;
      
      case 'client_change_ack':
        this.handleChangeAck(message);
        break;
    }
  }

  handleSyncRequest() {
    console.log('Sending sync response');
    this.sendMessage({
      type: 'sync',
      clientId: this.clientId,
      lastLSN: this.lastLSN
    });
  }

  handleSyncAck(message) {
    console.log('Sync acknowledged:', message);
    if (message.lastLSN) {
      this.lastLSN = message.lastLSN;
    }
  }

  handleChanges(message) {
    console.log('Received changes:', message.changes?.length || 0);
    if (message.lastLSN) {
      this.lastLSN = message.lastLSN;
    }
    
    // Acknowledge changes
    this.sendMessage({
      type: 'sync_ack',
      clientId: this.clientId,
      lastLSN: this.lastLSN,
      timestamp: Date.now()
    });
  }

  handleChangeAck(message) {
    console.log('Change acknowledged:', message);
  }

  sendMessage(message) {
    if (!this.connected) {
      console.warn('Not connected - cannot send message');
      return;
    }
    
    console.log('Sending message:', message);
    this.ws.send(JSON.stringify(message));
  }

  sendChange(table, operation, data) {
    const change = {
      type: 'client_change',
      clientId: this.clientId,
      change: {
        table,
        operation,
        data
      },
      metadata: {
        local_id: uuidv4(),
        timestamp: Date.now()
      }
    };
    
    this.sendMessage(change);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }

  getMessageLog() {
    return this.messageLog;
  }
}

// Test runner
async function runSyncTest() {
  const tester = new SyncTester('ws://localhost:3000');
  
  try {
    // Test 1: Connection
    console.log('\nTest 1: Connection');
    await tester.connect();
    console.log('✓ Connection successful');

    // Test 2: Initial Sync
    console.log('\nTest 2: Initial Sync');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const syncMessages = tester.getMessageLog().filter(m => m.type === 'sync_ack');
    console.log('Sync messages received:', syncMessages.length);
    if (syncMessages.length > 0) {
      console.log('✓ Initial sync successful');
    }

    // Test 3: Send Change
    console.log('\nTest 3: Send Change');
    tester.sendChange('test_table', 'insert', { 
      id: uuidv4(),
      name: 'Test Record',
      created_at: new Date().toISOString()
    });
    
    // Wait for change acknowledgment
    await new Promise(resolve => setTimeout(resolve, 2000));
    const changeAcks = tester.getMessageLog().filter(m => m.type === 'client_change_ack');
    console.log('Change acks received:', changeAcks.length);
    if (changeAcks.length > 0) {
      console.log('✓ Change processing successful');
    }

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    tester.disconnect();
  }
}

// Run the test
if (require.main === module) {
  runSyncTest().catch(console.error);
} 