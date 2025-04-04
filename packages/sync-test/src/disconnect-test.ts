import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

// Create a simple logger
const log = (message: string) => {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - ${message}`);
};

async function runDisconnectTest() {
  log('Starting disconnect test - testing clean disconnection...');
  
  // Generate a random client ID
  const clientId = `disconnect-test-${uuidv4().substring(0, 8)}`;
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
      
      // When we receive the catchup completed message, start the disconnect sequence
      if (message.type === 'srv_catchup_completed') {
        log('Catchup completed, waiting 5 seconds before disconnecting...');
        
        // Wait 5 seconds and then disconnect
        setTimeout(() => {
          log('Sending disconnect message...');
          try {
            ws.send(JSON.stringify({
              type: 'clt_disconnect',
              clientId,
              timestamp: Date.now(),
              message: 'Clean disconnect test'
            }));
            
            log('Disconnect message sent, closing connection in 1 second...');
            
            // Wait 1 second after sending disconnect message before closing
            setTimeout(() => {
              log('Closing connection with clean code 1000...');
              ws.close(1000, 'Clean disconnect test completed');
            }, 1000);
          } catch (e) {
            log(`Error during disconnect: ${e}`);
          }
        }, 5000);
      }
    } catch (error) {
      log(`Error parsing message: ${error}`);
    }
  });
  
  ws.on('close', (code: number, reason: string) => {
    const duration = Math.floor((Date.now() - startTime) / 1000);
    log(`WebSocket closed after ${duration} seconds. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
    
    // Exit after a clean disconnect
    setTimeout(() => {
      log('Test completed, exiting...');
      process.exit(0);
    }, 1000);
  });
  
  ws.on('error', (error: Error) => {
    log(`WebSocket error: ${error.message}`);
  });
  
  // Log status every 5 seconds
  const statusInterval = setInterval(() => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const readyState = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState];
    log(`Connection status after ${uptime} seconds: ${readyState}`);
    
    // Clear the interval if connection is closed
    if (ws.readyState === WebSocket.CLOSED) {
      clearInterval(statusInterval);
    }
  }, 5000);
  
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
runDisconnectTest().catch(error => {
  log(`Unhandled error: ${error}`);
  process.exit(1);
}); 