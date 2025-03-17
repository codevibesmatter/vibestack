import { ConnectionManager } from './connection-manager';
import { LSNManager } from './lsn-manager';
import { ClientChangeHandler } from './changes/client-changes';
import { 
  MessagePayload, 
  ConnectCommand, 
  DisconnectCommand, 
  SendMessageCommand,
  MainToWorkerMessage,
  WorkerToMainMessage,
  ConnectionState,
  ClientChangeMessage,
  ClientChangeResponse
} from './message-types';
import { syncLogger, changesLogger } from '../utils/logger';
import { serverChanges } from './changes/server-changes';

/**
 * Handles processing of messages received from the main thread
 */
export class MessageProcessor {
  private connectionManager: ConnectionManager;
  private lsnManager: LSNManager;
  private clientChangeHandler: ClientChangeHandler;

  constructor(connectionManager: ConnectionManager, lsnManager: LSNManager) {
    this.connectionManager = connectionManager;
    this.lsnManager = lsnManager;
    this.clientChangeHandler = new ClientChangeHandler(connectionManager, lsnManager);
    changesLogger.logServiceEvent('Message processor initialized');
  }

  /**
   * Process an incoming message from the main thread
   */
  async processMessage(message: MessagePayload): Promise<void> {
    const { type, payload } = message;

    try {
      switch (type as MainToWorkerMessage) {
        case 'connect':
          await this.handleConnect(payload as ConnectCommand);
          break;

        case 'disconnect':
          await this.handleDisconnect(payload as DisconnectCommand);
          break;

        case 'send_message':
          await this.handleSendMessage(payload as SendMessageCommand);
          break;

        case 'get_status':
          await this.handleGetStatus();
          break;

        case 'set_latest_lsn':
          await this.handleSetLatestLSN(payload as string);
          break;

        case 'update_lsn':
          await this.handleUpdateLSN(payload as string);
          break;

        case 'client_change':
          syncLogger.info('Processing client change:', {
            type: payload.type,
            table: payload.change?.table,
            operation: payload.change?.operation
          });
          await this.clientChangeHandler.processChange(payload);
          break;

        case 'changes_processed':
          // Handle changes processed acknowledgment
          if (payload.error) {
            syncLogger.error('Error processing changes:', { error: payload.error });
          } else if (payload.lsn) {
            // Update LSN after successful processing
            await this.updateLSN(payload.lsn, 'changes_processed');
          }
          break;

        default:
          syncLogger.warn('Unknown message type:', { type });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      syncLogger.error('Failed to process message:', { error: errorMessage });
      self.postMessage({
        type: 'error',
        payload: { message: 'Failed to process message', details: errorMessage }
      });
    }
  }

  /**
   * Handle connect command
   */
  private async handleConnect(command: ConnectCommand): Promise<void> {
    const { wsUrl } = command;
    const clientId = await this.lsnManager.getClientId();
    const lastLSN = await this.lsnManager.getLSN();
    this.connectionManager.connect(wsUrl, clientId || '', lastLSN);
  }

  /**
   * Handle disconnect command
   */
  private async handleDisconnect(_command: DisconnectCommand): Promise<void> {
    this.connectionManager.disconnect();
  }

  /**
   * Handle send message command
   */
  private async handleSendMessage(command: SendMessageCommand): Promise<void> {
    const { type, payload } = command;
    
    // Handle reset sync by resetting LSN first
    if (type === 'sync' && payload?.resetSync) {
      syncLogger.info('Handling reset sync request');
      await this.lsnManager.setLSN('0/0');
      syncLogger.info('LSN reset to 0/0');
    }
    
    // Add detailed logging for sync messages
    if (type === 'sync') {
      syncLogger.info('Processing sync message in handleSendMessage:', { 
        type,
        payload,
        resetSync: payload?.resetSync,
        currentStoredLSN: await this.lsnManager.getLSN(),
        clientId: await this.lsnManager.getClientId()
      });
    }
    
    // Construct the message to send
    const messageToSend = {
      type,
      ...payload,
      clientId: await this.lsnManager.getClientId(),
      lastLSN: await this.lsnManager.getLSN()
    };

    // Log the final message being sent
    syncLogger.info('Sending constructed message to server:', {
      type: messageToSend.type,
      clientId: messageToSend.clientId,
      lastLSN: messageToSend.lastLSN,
      resetSync: messageToSend.resetSync
    });
    
    this.connectionManager.sendToServer(messageToSend);
  }

  /**
   * Handle get status command
   */
  private async handleGetStatus(): Promise<void> {
    const state = this.connectionManager.getState();
    self.postMessage({ type: 'status', payload: state });
  }

  /**
   * Update the LSN and notify the connection manager
   * This is the single point of truth for LSN updates
   */
  private async updateLSN(lsn: string, source: string = 'unknown'): Promise<void> {
    await this.lsnManager.setLSN(lsn);
    // Update connection manager state
    const state = this.connectionManager.getState();
    state.lastLSN = lsn;
    this.connectionManager.updateState(state);
    syncLogger.debug('LSN updated:', { lsn, source });
  }

  /**
   * Handle set latest LSN command
   */
  private async handleSetLatestLSN(lsn: string): Promise<void> {
    syncLogger.info('Setting latest LSN:', { lsn });
    await this.updateLSN(lsn, 'set_latest_lsn');
    
    // Send confirmation back to main thread
    self.postMessage({ 
      type: 'lsn_update', 
      payload: { 
        lsn,
        source: 'set_latest_lsn'
      }
    });
    
    syncLogger.info('Latest LSN set successfully:', { lsn });
  }

  /**
   * Handle update LSN command
   */
  private async handleUpdateLSN(lsn: string): Promise<void> {
    await this.updateLSN(lsn, 'update_lsn');
  }

  /**
   * Handle server message
   */
  public async handleServerMessage(data: any): Promise<void> {
    try {
      // Handle client change responses
      if (data.type === 'client_change_ack') {
        this.clientChangeHandler.handleResponse(data as ClientChangeResponse);
        return;
      }

      switch (data.type) {
        case 'changes':
          try {
            // Log raw server changes data
            changesLogger.logServiceEvent(`Processing ${data.changes?.length} server changes in sync worker`);

            // Process changes directly in the worker
            await serverChanges.processChanges(data.changes);
            
            // If we get here, changes were processed successfully
            changesLogger.logServiceEvent(`Successfully processed ${data.changes?.length} server changes`);
            
            // Update LSN and send acknowledgment
            if (data.lsn) {
              await this.updateLSN(data.lsn, 'changes');
              
              // Send success acknowledgment back to server
              this.connectionManager.sendToServer({
                type: 'sync_ack',
                clientId: await this.lsnManager.getClientId(),
                lsn: data.lsn,
                timestamp: Date.now()
              });
            }
          } catch (error) {
            syncLogger.error('Failed to process server changes', error);
            
            // Send error back to server
            this.connectionManager.sendToServer({
              type: 'sync_error',
              clientId: await this.lsnManager.getClientId(),
              lsn: data.lsn,
              error: error instanceof Error ? error.message : 'Failed to process changes',
              timestamp: Date.now()
            });
          }
          break;

        case 'sync_ack':
          // Update LSN from sync acknowledgment
          if (data.lsn) {
            await this.updateLSN(data.lsn, 'sync_ack');
          }
          break;

        default:
          syncLogger.debug('Unhandled server message type:', { type: data.type });
      }
    } catch (error) {
      syncLogger.error('Failed to handle server message', error);
      throw error;
    }
  }
} 