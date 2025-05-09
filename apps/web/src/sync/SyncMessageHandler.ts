import { SyncEventEmitter } from './SyncEventEmitter';
import { WebSocketConnector } from './WebSocketConnector'; // Or IMessageSender if preferred
import { IncomingChangeProcessor } from './IncomingChangeProcessor';
import { SyncStatePersister, ISyncStateData } from './SyncStatePersister';
// Remove SyncState import from SyncManager, import SyncStatus from interfaces
import { ServerMessage, ClientMessage, ServerLiveStartMessage } from './SyncManager';
import { SyncStatus } from './interfaces';

export class SyncMessageHandler {
  private events: SyncEventEmitter;
  private wsConnector: WebSocketConnector; // Use concrete class or IMessageSender
  private incomingProcessor: IncomingChangeProcessor;
  private statePersister: SyncStatePersister;

  // Internal state needed for workflow management
  private currentSyncState: SyncStatus = 'disconnected'; // Ensure this uses the imported SyncStatus
  private currentLsn: string = '0/0';
  private clientId: string = '';

  constructor(
    eventEmitter: SyncEventEmitter,
    wsConnector: WebSocketConnector, // Inject dependencies
    incomingProcessor: IncomingChangeProcessor,
    statePersister: SyncStatePersister
  ) {
    this.events = eventEmitter;
    this.wsConnector = wsConnector;
    this.incomingProcessor = incomingProcessor;
    this.statePersister = statePersister;

    // Listen for raw messages from the connector
    this.events.on('websocket:message', this.handleRawMessage.bind(this));
  }

  // Called after SyncStatePersister is initialized
  public syncInitialState(initialState: ISyncStateData): void {
      this.clientId = initialState.clientId;
      this.currentLsn = initialState.currentLsn;
      this.currentSyncState = initialState.syncState; // Should be 'disconnected' initially
      console.log(`SyncMessageHandler: Initial state synced - ClientID: ${this.clientId}, LSN: ${this.currentLsn}`);
  }

  private handleRawMessage(rawData: string | Buffer | ArrayBuffer | Blob): void {
    try {
      let message: ServerMessage;
      if (typeof rawData === 'string') {
        message = JSON.parse(rawData);
      } else {
        // Handle binary data if necessary, e.g., using TextDecoder
        console.warn("SyncMessageHandler: Received binary message data, decoding as UTF-8 string.");
        const decoder = new TextDecoder('utf-8');
        message = JSON.parse(decoder.decode(rawData as BufferSource)); // Assuming BufferSource
      }

      console.log(`[SyncMessageHandler] Received message: ${message.type}`);
      // Basic validation
      if (!message.type || !message.messageId) {
          console.error("[SyncMessageHandler] Invalid message received (missing type or messageId):", message);
          return;
      }

      this.processDecodedMessage(message);

    } catch (error) {
      console.error('[SyncMessageHandler] Error processing raw message:', error);
      console.error('[SyncMessageHandler] Raw data:', rawData);
    }
  }

  private processDecodedMessage(message: ServerMessage): void {
    console.log(`[SyncMessageHandler] processDecodedMessage ENTERED for type: "${message.type}" (ID: ${message.messageId}).`);
    // Logic from SyncManager.processMessage
    // Dispatch based on type
     switch (message.type) {
       case 'srv_state_change':
         this.handleStateChangeMessage(message);
         break;
       case 'srv_lsn_update':
         this.handleLSNUpdateMessage(message);
         break;
       case 'srv_send_changes': // Fallthrough
       case 'srv_live_changes':
       case 'srv_catchup_changes':
       case 'srv_init_changes':
         this.handleTableChangesMessage(message);
         break;
       case 'srv_init_start':
         this.handleInitStartMessage(message);
         break;
       case 'srv_init_complete':
         this.handleInitCompleteMessage(message);
         break;
       case 'srv_catchup_completed':
         this.handleCatchupCompletedMessage(message);
         break;
       case 'srv_live_start':
         this.handleLiveStartMessage(message);
         break;
       case 'srv_sync_stats':
         this.handleSyncStatsMessage(message);
         break;
       case 'srv_changes_received':
         this.events.emit('server_message:srv_changes_received', message);
         break;
       case 'srv_changes_applied':
         console.log(`[SyncMessageHandler] Matched CASE 'srv_changes_applied' for ID: ${message.messageId}`);
         this.events.emit('server_message:srv_changes_applied', message);
         console.log(`[SyncMessageHandler] AFTER EMIT 'server_message:srv_changes_applied' for ID: ${message.messageId}`);
         break;
       case 'srv_error':
         this.events.emit('server_message:srv_error', message);
         break;
       // Messages like srv_changes_received, srv_changes_applied, srv_error are now emitted
       // for OutgoingChangeProcessor to handle.
       default:
         // This will now only catch types not explicitly handled above or in other cases.
         console.warn(`[SyncMessageHandler] DEFAULT CASE: Received unhandled message type: "${message.type}" (ID: ${message.messageId})`);
     }
  }

  // --- Message Handlers (Adapted from SyncManager) ---

  private handleStateChangeMessage(message: ServerMessage): void {
    const state = message.state; // message.state is already SyncStatus | undefined
    if (state && this.currentSyncState !== state) {
        console.log(`[SyncMessageHandler] State changing from ${this.currentSyncState} to ${state}`);
        this.currentSyncState = state; // Assign SyncStatus
        this.events.emit('stateChange', state); // Emit SyncStatus
        // Persist the state change (saveState expects Partial<ISyncStateData> where syncState is SyncStatus)
        this.statePersister.saveState({ syncState: state }).catch(err => console.error("Error saving state:", err));
    }
  }

  private handleLSNUpdateMessage(message: ServerMessage): void {
    const lsn = message.lsn;
    if (lsn && this.currentLsn !== lsn) {
        console.log(`[SyncMessageHandler] LSN changing from ${this.currentLsn} to ${lsn}`);
        this.currentLsn = lsn;
        this.events.emit('lsnUpdate', lsn); // Emit for UI/SyncManager orchestrator
        // Persist the LSN change immediately
        this.statePersister.saveState({ currentLsn: lsn }).then(() => this.statePersister.flush());
    }
  }

  private handleTableChangesMessage(message: ServerMessage): void {
    const changes = message.changes;
    if (changes && Array.isArray(changes)) {
      // Update LSN first if provided (common in catchup/live)
      if (message.lastLSN && this.currentLsn !== message.lastLSN) {
          this.handleLSNUpdateMessage({ ...message, lsn: message.lastLSN }); // Reuse LSN update logic
      }

      // Delegate processing to IncomingChangeProcessor
      this.incomingProcessor.processIncomingChanges(changes, message.type)
        .then(success => {
          if (success) {
            console.log(`[SyncMessageHandler] Incoming changes processed successfully for ${message.type}. Sending ACK.`);
            // Send appropriate acknowledgment
            this.sendMessageAcknowledgment(message);
          } else {
            console.error(`[SyncMessageHandler] Incoming changes processing failed for ${message.type}. Not sending ACK.`);
            // Handle failure? Trigger error state?
            this.events.emit('sync_error', { error: `Failed to process incoming changes for ${message.type}`, phase: 'client_processing', messageId: message.messageId });
          }
        })
        .catch(error => {
          console.error(`[SyncMessageHandler] Error delegating incoming changes processing (${message.type}):`, error);
           this.events.emit('sync_error', { error: `Error processing incoming changes for ${message.type}`, phase: 'client_processing', messageId: message.messageId, originalError: error });
        });
    } else {
      console.warn(`[SyncMessageHandler] Received ${message.type} with no valid changes array.`);
    }
  }

  private handleInitStartMessage(message: ServerMessage): void {
     console.log('[SyncMessageHandler] Initial sync starting', { serverLSN: message.serverLSN });
     if (message.serverLSN && !message.serverLSN.includes('(resuming)')) {
         this.handleLSNUpdateMessage({ ...message, lsn: message.serverLSN });
     }
     this.handleStateChangeMessage({ ...message, state: 'initial_sync' });
     this.sendInitStartReceivedAck(message.messageId);
  }

  private handleInitCompleteMessage(message: ServerMessage): void {
     console.log('[SyncMessageHandler] Initial sync complete', { serverLSN: message.serverLSN });
     if (message.serverLSN) {
         this.handleLSNUpdateMessage({ ...message, lsn: message.serverLSN });
     }
     this.sendInitProcessedAck(message.messageId);
     // Transition state AFTER sending ACK
     this.handleStateChangeMessage({ ...message, state: 'catchup' });
  }

  private handleCatchupCompletedMessage(message: ServerMessage): void {
     console.log('[SyncMessageHandler] Catchup sync complete', { lastLSN: message.lastLSN });
     if (message.lastLSN) {
         this.handleLSNUpdateMessage({ ...message, lsn: message.lastLSN });
     }
     this.handleStateChangeMessage({ ...message, state: 'live' });
     // Persist last sync time
     this.statePersister.saveState({ lastSyncTime: new Date() }).catch(err => console.error("Error saving last sync time:", err));
     // Trigger OutgoingChangeProcessor to send pending changes
     this.events.emit('process_all_outgoing_changes', { reason: 'catchup_complete' }); // New event for OutgoingProcessor
  }

  private handleLiveStartMessage(message: ServerMessage): void {
     const liveStartMsg = message as ServerLiveStartMessage;
     console.log('[SyncMessageHandler] Live sync starting', { finalLSN: liveStartMsg.finalLSN });
     if (liveStartMsg.finalLSN) {
         this.handleLSNUpdateMessage({ ...message, lsn: liveStartMsg.finalLSN });
     }
     this.handleStateChangeMessage({ ...message, state: 'live' });
     this.statePersister.saveState({ lastSyncTime: new Date() }).catch(err => console.error("Error saving last sync time:", err));
     // Trigger OutgoingChangeProcessor to send pending changes
     this.events.emit('process_all_outgoing_changes', { reason: 'live_start' }); // New event for OutgoingProcessor
  }

  private handleSyncStatsMessage(message: ServerMessage): void {
    console.log('[SyncMessageHandler] Received sync stats', message);
    this.events.emit('sync_stats', message); // Forward for UI
  }

  // --- Acknowledgment Sending Methods (Adapted from SyncManager) ---

  private sendMessageAcknowledgment(message: ServerMessage): void {
    // Logic from SyncManager.sendMessageAcknowledgment
     const type = message.type;
     try {
       console.log(`[SyncMessageHandler] Preparing acknowledgment for ${type} (in reply to ${message.messageId})`);
       switch (type) {
         case 'srv_init_changes':
           this.sendInitChangesAcknowledgment(message);
           break;
         case 'srv_catchup_changes':
           this.sendCatchupAcknowledgment(message);
           break;
         case 'srv_live_changes':
           this.sendLiveChangesAcknowledgment(message);
           break;
         default:
           console.warn(`[SyncMessageHandler] No acknowledgment handler for message type: ${type}`);
       }
     } catch (error) {
       console.error(`[SyncMessageHandler] Error sending acknowledgment for ${type}:`, error);
     }
  }

  private sendInitChangesAcknowledgment(message: ServerMessage): void {
    // Logic from SyncManager.sendInitChangesAcknowledgment
     const sequence = message.sequence;
     const table = sequence?.table;
     const chunk = sequence?.chunk;
     if (!table || chunk === undefined) return;
     const ackMessage: ClientMessage = {
       type: 'clt_init_received', messageId: `init_ack_${table}_${chunk}_${Date.now()}`,
       timestamp: Date.now(), clientId: this.clientId, table: table, chunk: chunk,
       inReplyTo: message.messageId
     };
     this.wsConnector.send(ackMessage);
  }

  private sendCatchupAcknowledgment(message: ServerMessage): void {
    // Logic from SyncManager.sendCatchupAcknowledgment
     const sequence = message.sequence;
     const lastLSN = message.lastLSN || this.currentLsn;
     const chunk = sequence?.chunk || 1;
     const ackMessage: ClientMessage = {
       type: 'clt_catchup_received', messageId: `catchup_ack_${Date.now()}`,
       timestamp: Date.now(), clientId: this.clientId, chunk: chunk, lsn: lastLSN,
       inReplyTo: message.messageId
     };
     this.wsConnector.send(ackMessage);
  }

  private sendLiveChangesAcknowledgment(message: ServerMessage): void {
    // Logic from SyncManager.sendLiveChangesAcknowledgment
     const changes = message.changes as Array<any> || [];
     const lastLSN = message.lastLSN || this.currentLsn;
     const changeIds = changes.map(change => change.data?.id).filter(Boolean);
     const ackMessage: ClientMessage = {
       type: 'clt_changes_received', messageId: `live_ack_${Date.now()}`,
       timestamp: Date.now(), clientId: this.clientId, changeIds: changeIds, lastLSN: lastLSN,
       inReplyTo: message.messageId
     };
     this.wsConnector.send(ackMessage);
  }

  private sendInitStartReceivedAck(inReplyTo: string): void {
    // Logic from SyncManager.sendInitStartReceivedAck
     const ackMessage: ClientMessage = {
       type: 'clt_init_received', messageId: `init_start_ack_${Date.now()}`,
       timestamp: Date.now(), clientId: this.clientId, inReplyTo
     };
     this.wsConnector.send(ackMessage);
  }

  private sendInitProcessedAck(inReplyTo: string): void {
    // Logic from SyncManager.sendInitProcessedAck
     const ackMessage: ClientMessage = {
       type: 'clt_init_processed', messageId: `init_processed_${Date.now()}`,
       timestamp: Date.now(), clientId: this.clientId, inReplyTo
     };
     this.wsConnector.send(ackMessage);
  }

  // --- Public Accessors ---

  public getCurrentSyncPhase(): SyncStatus {
    // Returns the handler's internal understanding of the current phase
    return this.currentSyncState;
  }
}