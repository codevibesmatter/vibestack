import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

// Create a simple logger
const log = (message: string) => {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - ${message}`);
};

async function runMinimalTest() {
  log('Starting minimal WebSocket test - NO heartbeats...');
  
  // Generate a random client ID
  const clientId = `minimal-test-${uuidv4().substring(0, 8)}`;
  log(`Generated client ID: ${clientId}`);
  
  // Use the same LSN that worked with wscat
  const lsn = '0/BFF4000';
  
  // Create WebSocket URL
  const wsUrl = `ws://localhost:8787/api/sync?clientId=${clientId}&lsn=${lsn}`;
  log(`Connecting to: ${wsUrl}`);
  
  // Create WebSocket with minimal options
  const ws = new WebSocket(wsUrl);
  const startTime = Date.now();
  
  // Set up event handlers
  ws.on('open', () => {
    log('WebSocket connection opened successfully');
  });
  
  ws.on('message', (data: WebSocket.Data) => {
    try {
      const message = JSON.parse(data.toString());
      log(`Received message type: ${message.type}`);
    } catch (error) {
      log(`Error parsing message: ${error}`);
    }
  });
  
  ws.on('close', (code: number, reason: string) => {
    const duration = Math.floor((Date.now() - startTime) / 1000);
    log(`WebSocket closed after ${duration} seconds. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
    process.exit(0);
  });
  
  ws.on('error', (error: Error) => {
    log(`WebSocket error: ${error.message}`);
  });
  
  // Log status every 10 seconds
  const statusInterval = setInterval(() => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const readyState = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState];
    log(`Connection status after ${uptime} seconds: ${readyState}`);
    
    // Disconnect after 60 seconds
    if (uptime >= 60 && ws.readyState === WebSocket.OPEN) {
      log('Test duration reached 60 seconds, closing connection gracefully...');
      clearInterval(statusInterval);
      
      // Send a graceful disconnect message
      try {
        ws.send(JSON.stringify({
          type: 'clt_disconnect',
          clientId,
          timestamp: Date.now(),
          message: 'Client disconnecting after 60 seconds'
        }));
        log('Sent disconnect message');
      } catch (e) {
        log(`Error sending disconnect message: ${e}`);
      }
      
      // Close the WebSocket
      setTimeout(() => {
        log('Closing WebSocket connection...');
        ws.close(1000, 'Test complete');
      }, 500);
    }
  }, 10000);
  
  // Handle Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(statusInterval);
    const duration = Math.floor((Date.now() - startTime) / 1000);
    log(`Test interrupted after ${duration} seconds`);
    
    if (ws.readyState === WebSocket.OPEN) {
      log('Closing WebSocket gracefully...');
      ws.close(1000, 'Test interrupted');
    }
    
    process.exit(0);
  });
}

// Run the test
runMinimalTest().catch(error => {
  log(`Unhandled error: ${error}`);
  process.exit(1);
}); 