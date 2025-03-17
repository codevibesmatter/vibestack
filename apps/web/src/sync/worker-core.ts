/**
 * Sync Worker
 * 
 * Web worker that handles WebSocket connections and sync operations.
 * Acts as the central coordinator for sync state and operations.
 */

import { ConnectionManager } from './connection-manager';
import { MessageProcessor } from './message-processor';
import { getLSNManager } from './lsn-manager';
import { MessagePayload, ConnectionState } from './message-types';
import { syncLogger } from '../utils/logger';
import { config } from '../config';
import { ClientChangeHandler } from './changes/client-changes';

// Generate a UUID v4
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Initialize state
const state: ConnectionState = {
  isConnected: false,
  isConnecting: false,
  clientId: null,
  wsUrl: config.wsUrl,
  lastLSN: '0/0'
};

// Initialize managers
const lsnManager = getLSNManager();

// Create connection manager first without client change handler
const connectionManager = new ConnectionManager(
  state,
  (data) => {
    // Forward server messages to message processor
    messageProcessor.handleServerMessage(data);
  },
  (newState) => {
    syncLogger.debug('Connection state changed', newState);
    Object.assign(state, newState);
    self.postMessage({ type: 'status', payload: newState });
  },
  (message, details) => {
    syncLogger.error('Connection error', { message, details });
    self.postMessage({ type: 'error', payload: { message, details } });
  }
);

// Create client change handler
const clientChangeHandler = new ClientChangeHandler(connectionManager, lsnManager);

// Set client change handler on connection manager
connectionManager.setClientChangeHandler(clientChangeHandler);

const messageProcessor = new MessageProcessor(connectionManager, lsnManager);

// Initialize sync state and connect
async function initialize() {
  try {
    // Initialize LSN manager
    await lsnManager.initialize();

    // Get or generate client ID
    let clientId = await lsnManager.getClientId();
    if (!clientId) {
      clientId = generateUUID();
      await lsnManager.setClientId(clientId);
      syncLogger.info('Generated new client ID', { clientId });
    } else {
      syncLogger.info('Using existing client ID', { clientId });
    }

    // Get last LSN
    const lastLSN = await lsnManager.getLSN();
    syncLogger.info('Retrieved last LSN', { lastLSN });

    // Update state
    state.clientId = clientId;
    state.wsUrl = config.wsUrl;

    // Connect to sync server
    connectionManager.connect(state.wsUrl!, state.clientId, lastLSN);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    syncLogger.error('Failed to initialize sync worker', { error: errorMessage });
    self.postMessage({
      type: 'error',
      payload: { message: 'Failed to initialize sync worker', details: errorMessage }
    });
  }
}

// Start initialization
initialize();

// Set up message handler
self.onmessage = async ({ data }) => {
  try {
    const { type, payload } = data;
    
    switch (type) {
      case 'connect':
        await messageProcessor.processMessage({ type, payload });
        break;
        
      case 'disconnect':
        await messageProcessor.processMessage({ type, payload });
        break;
        
      case 'send_message':
        await messageProcessor.processMessage({ type, payload });
        break;
        
      case 'get_status':
        await messageProcessor.processMessage({ type, payload });
        break;
        
      case 'set_latest_lsn':
        await messageProcessor.processMessage({ type, payload });
        break;
        
      case 'update_lsn':
        await messageProcessor.processMessage({ type, payload });
        break;
        
      case 'client_change':
        syncLogger.info('Received client change:', { 
          type: payload.type,
          table: payload.change?.table,
          operation: payload.change?.operation
        });
        await messageProcessor.processMessage({ type, payload });
        break;
        
      default:
        syncLogger.warn('Unknown message type:', { type });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    syncLogger.error('Error processing message:', { error: errorMessage });
    self.postMessage({
      type: 'error',
      payload: { message: 'Error processing message', details: errorMessage }
    });
  }
}; 