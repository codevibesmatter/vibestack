import { messageDispatcher } from './core/message-dispatcher.ts';
import { wsClientFactory } from './core/ws-client-factory.ts';
import { createLogger } from './core/logger.ts';

const logger = createLogger('connection-test');

// Simple test to see how long we can keep a WebSocket connection open
async function testConnection() {
  logger.info('Starting minimal WebSocket connection test...');
  
  try {
    // Create a client
    const clientId = await wsClientFactory.createClient(1); // Use profile 1
    logger.info(`Created client: ${clientId}`);
    
    // Connect the client with a specific LSN to avoid initial sync
    const specificLSN = '0/BFF4000'; // Use a specific LSN to avoid initial sync
    await wsClientFactory.connectClient(clientId, undefined, { lsn: specificLSN });
    logger.info(`Client connected successfully with LSN: ${specificLSN} (to avoid initial sync)`);
    
    const startTime = Date.now();
    let isRunning = true;
    
    // Register a message handler for disconnection
    const disconnectHandler = (message: any) => {
      if (message.type === 'connection_closed' && message.clientId === clientId) {
        const disconnectTime = Math.floor((Date.now() - startTime) / 1000);
        logger.warn(`⚠️ Client DISCONNECTED after ${disconnectTime} seconds with code: ${message.code}, reason: ${message.reason || 'unknown'}`);
        
        isRunning = false;
        clearInterval(statusInterval);
        
        // Exit the process after reporting disconnect
        setTimeout(() => {
          process.exit(1);
        }, 1000);
      }
      return true;
    };
    
    // Register the handlers
    messageDispatcher.registerHandler('connection_closed', disconnectHandler);
    
    // Log connection status every 10 seconds
    const statusInterval = setInterval(() => {
      if (!isRunning) return;
      
      const status = wsClientFactory.getClientStatus(clientId);
      const uptimeSecs = Math.floor((Date.now() - startTime) / 1000);
      
      logger.info(`Connection status after ${uptimeSecs} seconds: ${status}`);
      
      // If disconnected, attempt a simple reconnect
      if (status === 'disconnected' && isRunning) {
        logger.warn(`Client ${clientId} is disconnected - attempting reconnect...`);
        
        // Try to reconnect with the same LSN
        wsClientFactory.connectClient(clientId, undefined, { lsn: specificLSN })
          .then(() => {
            logger.info(`Successfully reconnected client ${clientId}`);
          })
          .catch(err => {
            logger.error(`Failed to reconnect client ${clientId}: ${err}`);
          });
      }
    }, 10000);
    
    // Wait for Ctrl+C
    logger.info('Press Ctrl+C to exit');
    
    // Handle exit signals
    process.on('SIGINT', async () => {
      isRunning = false;
      clearInterval(statusInterval);
      
      const totalTime = Math.floor((Date.now() - startTime) / 1000);
      logger.info(`Test completed. Connection remained open for ${totalTime} seconds`);
      
      try {
        await wsClientFactory.disconnectClient(clientId);
        logger.info('Client disconnected gracefully');
      } catch (err) {
        logger.error(`Failed to disconnect: ${err}`);
      }
      
      process.exit(0);
    });
    
  } catch (error) {
    logger.error(`Test failed: ${error}`);
    process.exit(1);
  }
}

// Run the test
testConnection().catch(error => {
  logger.error(`Unhandled error: ${error}`);
  process.exit(1);
}); 