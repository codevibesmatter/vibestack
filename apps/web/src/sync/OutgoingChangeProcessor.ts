import { LocalChanges } from '@repo/dataforge/client-entities';
import { In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { SyncEventEmitter } from './SyncEventEmitter';
import { DatabaseInitializer } from './DatabaseInitializer';
import { IMessageSender } from './interfaces';
import { ClientMessage } from './SyncManager'; // Only ClientMessage needed here for sending
import type {
  TableChange,
  ServerMessage as BaseServerMessage,
  ServerAppliedMessage,
  ServerReceivedMessage,
  // ServerErrorResponseMessage is not exported from sync-types, handle srv_error directly
  SrvMessageType // To help with type guards
} from '@repo/sync-types';

// Constants for batch processing
const BATCH_DELAY = 50; // ms
const MAX_CHANGES_PER_BATCH = 50;
const CHANGE_TIMEOUT = 300000; // 5 minutes

// A more specific type for server error messages if not covered by sync-types
interface ServerErrorResponseMessage extends BaseServerMessage {
  type: 'srv_error';
  errorCode?: string | number;
  errorMessage?: string;
  originalMessageId?: string;
  // Add other expected error fields if any
}


export class OutgoingChangeProcessor {
  private localChangesRepo: Repository<LocalChanges>;
  private events: SyncEventEmitter;
  private messageSender: IMessageSender;
  private dbInitializer: DatabaseInitializer;

  private changeQueue: Set<string> = new Set(); // Stores LocalChanges.id
  private isProcessing: boolean = false;
  private processTimer: NodeJS.Timeout | null = null; // Use NodeJS.Timeout type
  private sentChanges: Map<string, number> = new Map(); // LocalChanges.id -> timestamp
  private pendingChangesCount: number = 0;

  private debouncedUpdatePendingChangesCountTimer: NodeJS.Timeout | null = null;
  private lastPendingChangesCountUpdateTime = 0;
  private readonly MIN_PENDING_CHANGES_UPDATE_INTERVAL = 3000;
  private readonly PENDING_CHANGES_UPDATE_DEBOUNCE_DELAY = 1000;

  constructor(
    dbInitializer: DatabaseInitializer,
    eventEmitter: SyncEventEmitter,
    messageSender: IMessageSender
  ) {
    this.dbInitializer = dbInitializer;
    if (!this.dbInitializer.isInitialized()) {
      throw new Error("DatabaseInitializer not initialized when OutgoingChangeProcessor is constructed.");
    }
    this.localChangesRepo = dbInitializer.getLocalChangesRepository();
    this.events = eventEmitter;
    this.messageSender = messageSender;

    this.initializeEventListeners();
    this.loadUnprocessedChanges().catch(error => {
      console.error("[OutgoingChangeProcessor] Error loading unprocessed changes on init:", error);
    });
  }

  private initializeEventListeners(): void {
    this.messageSender.on('websocket:open', this.handleWebSocketOpen.bind(this));
    // Assuming 'stateChange' from IMessageSender is now 'websocket:status' or similar
    // Or SyncManager translates 'websocket:status' to a 'connection:stateChanged' if needed by OCP
    this.events.on('websocket:status', (status: 'connected' | 'disconnected' | 'connecting' | 'error') => {
        // OCP might be interested in 'connected' to trigger processing
        if (status === 'connected') {
            this.handleConnectionStateChange('live'); // Assuming 'connected' means 'live' for OCP's purpose
        } else {
            // Handle other statuses if necessary, e.g. stop processing if 'disconnected'
            // For now, only 'live' state triggers processing.
        }
    });
    this.events.on('process_all_outgoing_changes', () => {
      console.log('[OutgoingChangeProcessor] Received process_all_outgoing_changes event.');
      this.loadUnprocessedChanges().then(() => {
        this.scheduleProcessing();
      }).catch(error => {
        console.error('[OutgoingChangeProcessor] Error processing all changes event:', error);
      });
    });

    // Listen for server messages forwarded by SyncMessageHandler
    this.events.on('server_message:srv_changes_received', (message: BaseServerMessage) => {
      this.handleChangesReceived(message);
    });
    this.events.on('server_message:srv_changes_applied', (message: BaseServerMessage) => {
      this.handleChangesApplied(message).catch(error => {
        console.error('[OutgoingChangeProcessor] Error in handleChangesApplied after event:', error);
      });
    });
    this.events.on('server_message:srv_error', (message: BaseServerMessage) => {
      // Ensure the message is cast or validated if ServerErrorResponseMessage is more specific
      this.handleServerError(message as ServerErrorResponseMessage | BaseServerMessage);
    });
  }

  private handleWebSocketOpen(): void {
    console.log('[OutgoingChangeProcessor] WebSocket opened. Scheduling change processing.');
    setTimeout(() => {
      this.loadUnprocessedChanges().then(() => {
        this.scheduleProcessing();
      }).catch(error => {
        console.error('[OutgoingChangeProcessor] Error loading unprocessed changes on WebSocket open:', error);
      });
    }, 1000);
  }

  private handleConnectionStateChange(state: string): void {
    console.log(`[OutgoingChangeProcessor] Connection state changed to: ${state}`);
    if (state === 'live') {
      console.log('[OutgoingChangeProcessor] Connection state is live. Scheduling change processing.');
      setTimeout(() => {
        this.loadUnprocessedChanges().then(() => {
          this.scheduleProcessing();
        }).catch(error => {
          console.error('[OutgoingChangeProcessor] Error loading unprocessed changes on connection state live:', error);
        });
      }, 1000);
    }
  }

  public async trackChange(
    tableName: string, // Renamed from 'table' to avoid conflict with LocalChanges.table
    operationType: 'insert' | 'update' | 'delete', // Renamed from 'operation'
    dataPayload: Record<string, any>, // Renamed from 'data'
    originalData?: Record<string, any>
  ): Promise<string> {
    const localChangeId = uuidv4(); // This is the ID for the LocalChanges record itself

    if (!this.dbInitializer.isInitialized() || !this.localChangesRepo) {
      console.error("[OutgoingChangeProcessor] Cannot track change, DatabaseInitializer not ready or repository not available.");
      throw new Error("Database or repository not available for trackChange");
    }

    try {
      let processedData = { ...dataPayload };
      // The entity's actual ID is expected to be in dataPayload.id
      const entityId = dataPayload.id || originalData?.id;

      if (operationType === 'update') {
        if (originalData) {
          const modifiedFields: Record<string, any> = {};
          let hasChanges = false;
          for (const [key, value] of Object.entries(dataPayload)) {
            if (JSON.stringify(value) !== JSON.stringify(originalData[key])) {
              modifiedFields[key] = value;
              hasChanges = true;
            }
          }
          if (dataPayload.id && !modifiedFields.id) { // Ensure entity ID is included
            modifiedFields.id = dataPayload.id;
          }
          if (!hasChanges && dataPayload.id) {
            console.log(`[OutgoingChangeProcessor] Skipping tracking update for ${tableName}:${dataPayload.id} as no data changed.`);
            return dataPayload.id; // Return entity id
          }
          processedData = modifiedFields;
        }
        if (!processedData.id && dataPayload.id) { // Ensure entity ID is in the final data for update
          processedData.id = dataPayload.id;
        } else if (!processedData.id) {
          console.warn(`[OutgoingChangeProcessor] Update operation for table ${tableName} is missing an 'id' in the data. LocalChange ID: ${localChangeId}`);
        }
      } else if (operationType === 'insert' && !dataPayload.id) {
        console.warn(`[OutgoingChangeProcessor] Insert operation for table ${tableName} is missing an 'id' in dataPayload. LocalChange ID: ${localChangeId}`);
      }


      const now = new Date();
      const newChange = this.localChangesRepo.create({
        id: localChangeId, // Primary key for LocalChanges table
        table: tableName,
        operation: operationType,
        // data field in LocalChanges stores the actual data payload
        data: processedData,
        lsn: '', // LSN must be a string; use empty if not applicable for client-originated changes
        // createdAt will be set by DB or TypeORM
        updatedAt: now, // Explicitly set updatedAt
        processedSync: 0, // 0 for false, 1 for true
        // source: 'client' // Add if 'source' column exists in LocalChanges entity
      });

      await this.localChangesRepo.save(newChange);
      this.changeQueue.add(localChangeId);
      console.log(`[OutgoingChangeProcessor] Tracked change ${localChangeId} (entity: ${entityId}) for ${operationType} on ${tableName}`);
      this.scheduleProcessing();
      this.events.emit('local_change_tracked', { changeId: localChangeId, table: tableName, operation: operationType, entityId });
      this.pendingChangesCount++;
      this.triggerDebouncedUpdatePendingChangesCount();
      return localChangeId;
    } catch (error) {
      console.error('[OutgoingChangeProcessor] Error tracking change:', error);
      throw error;
    }
  }

  private triggerDebouncedUpdatePendingChangesCount(): void {
    const now = Date.now();
    if (this.debouncedUpdatePendingChangesCountTimer) {
      clearTimeout(this.debouncedUpdatePendingChangesCountTimer);
    }
    const timeSinceLastUpdate = now - this.lastPendingChangesCountUpdateTime;
    if (timeSinceLastUpdate >= this.MIN_PENDING_CHANGES_UPDATE_INTERVAL) {
      this.updatePendingChangesCount();
    } else {
      this.debouncedUpdatePendingChangesCountTimer = setTimeout(() => {
        this.updatePendingChangesCount();
      }, Math.max(0, this.PENDING_CHANGES_UPDATE_DEBOUNCE_DELAY, this.MIN_PENDING_CHANGES_UPDATE_INTERVAL - timeSinceLastUpdate));
    }
  }

  private updatePendingChangesCount(): void {
    this.lastPendingChangesCountUpdateTime = Date.now();
    if (this.debouncedUpdatePendingChangesCountTimer) {
      clearTimeout(this.debouncedUpdatePendingChangesCountTimer);
      this.debouncedUpdatePendingChangesCountTimer = null;
    }
    console.log(`[OutgoingChangeProcessor] Pending changes count updated to: ${this.pendingChangesCount}`);
    this.events.emit('pending_outgoing_changes_count_updated', this.pendingChangesCount);
  }

  private scheduleProcessing(): void {
    if (this.processTimer !== null) return;
    if (this.isProcessing) return;
    if (this.changeQueue.size === 0 && this.pendingChangesCount === 0) {
      if (this.pendingChangesCount > 0) {
        this.loadUnprocessedChanges().then(() => {
          if (this.changeQueue.size > 0) this.scheduleProcessingActual();
        }).catch(err => console.error("Error loading unprocessed in scheduleProcessing:", err));
      }
      return;
    }
    this.scheduleProcessingActual();
  }

  private scheduleProcessingActual(): void {
    this.processTimer = setTimeout(() => {
      this.processTimer = null;
      this.processChanges().catch(error => {
        console.error('[OutgoingChangeProcessor] Error during scheduled processChanges:', error);
      });
    }, BATCH_DELAY);
  }

  private async processChanges(): Promise<void> {
    if (this.isProcessing || this.changeQueue.size === 0) return;
    if (!this.dbInitializer.isInitialized() || !this.localChangesRepo) {
      console.error("[OutgoingChangeProcessor] Cannot process changes, DB not ready.");
      return;
    }
    // Revert to getStatus() as defined in the current interface (will update interface next)
    const senderStatus = this.messageSender.getStatus();
    // Assuming 'connected' is the status string indicating readiness to send
    if (!this.messageSender.isConnected() || senderStatus !== 'connected') {
      console.log(`[OutgoingChangeProcessor] Not processing: connection not ready. Status: ${senderStatus}, Connected: ${this.messageSender.isConnected()}`);
      return;
    }

    this.isProcessing = true;
    console.log(`[OutgoingChangeProcessor] Starting to process ${this.changeQueue.size} queued changes.`);

    let currentBatchLocalChangeIds: string[] = [];

    try {
      currentBatchLocalChangeIds = Array.from(this.changeQueue).slice(0, MAX_CHANGES_PER_BATCH);
      currentBatchLocalChangeIds.forEach(id => this.changeQueue.delete(id));

      const changesFromDb = await this.localChangesRepo.find({
        where: { id: In(currentBatchLocalChangeIds), processedSync: 0 }, // Use camelCase
        order: { createdAt: 'ASC' } // Use camelCase
      });

      if (changesFromDb.length === 0) {
        console.log('[OutgoingChangeProcessor] No unprocessed changes found in DB for the current batch IDs.');
        this.isProcessing = false;
        if (this.changeQueue.size > 0) this.scheduleProcessing();
        return;
      }

      const optimizedChanges = await this.optimizeOutgoingChanges(changesFromDb);
      console.log(`[OutgoingChangeProcessor] Optimized ${changesFromDb.length} changes to ${optimizedChanges.length}`);

      if (optimizedChanges.length === 0) {
        console.log('[OutgoingChangeProcessor] All changes were optimized out, nothing to send.');
        const optimizedOutIds = changesFromDb.map(c => c.id);
        await this.markLocalChangesAsProcessed(optimizedOutIds, true, 'optimized_out');
        this.isProcessing = false;
        if (this.changeQueue.size > 0) this.scheduleProcessing();
        return;
      }

      // ClientId will be added by WebSocketConnector.send()
      const tableChangesPayload: TableChange[] = optimizedChanges.map(change => {
        let rowData = change.data;
        if (typeof rowData === 'string') {
          try {
            rowData = JSON.parse(rowData);
          } catch (e) {
            console.error(`[OutgoingChangeProcessor] Failed to parse LocalChanges.data for change ${change.id}:`, e);
            rowData = {}; // default to empty object on parse error
          }
        }
        
        const entityId = (rowData as Record<string, any>)?.id;
        if (!entityId && change.operation !== 'delete') {
            console.warn(`[OutgoingChangeProcessor] Entity ID missing in data for change ${change.id}, table ${change.table}, op ${change.operation}`);
        }

        const changeDataForServer = this.convertKeysToSnakeCase(rowData || {});
        
        return {
          table: change.table,
          operation: change.operation as 'insert' | 'update' | 'delete',
          data: {
            ...changeDataForServer,
            id: entityId,
            // client_id is not typically part of TableChange.data; it's a top-level message property
          },
          updated_at: change.updatedAt.toISOString(),
        };
      });

      // Construct the message payload *without* common fields, as per IMessageSender
      // Client ID will be added by the layer calling the sender (e.g., SyncManager or WebSocketConnector)
      const messagePayloadToSend: Omit<ClientMessage, 'clientId' | 'messageId' | 'timestamp'> = {
          type: 'clt_send_changes',
          // clientId: clientId, // Removed: Not part of the payload sent via IMessageSender.send
          messageId: `changes_${Date.now()}_${uuidv4().substring(0, 6)}`, // Generate unique message ID
          timestamp: Date.now(),
          changes: tableChangesPayload
          // lsn: this.currentLsn, // Add LSN if applicable for outgoing changes
      };

      // Call send, which returns void. Assume success if no error is thrown by the sender.
      this.messageSender.send(messagePayloadToSend);

      // Assume send was successful if no error was thrown. Track locally.
      const now = Date.now();
      optimizedChanges.forEach(optChange => this.sentChanges.set(optChange.id, now));

      // Emit event - messageId is not available here as it's added by the sender implementation.
      // The consumer (e.g., SyncManager) that adds the messageId might emit a more complete event.
      this.events.emit('outgoing_changes_payload_sent', { // Changed event name slightly
          changeIds: optimizedChanges.map(c => c.id),
          numChanges: optimizedChanges.length
      });
      console.log(`[OutgoingChangeProcessor] Sent payload for ${optimizedChanges.length} changes to message sender.`);

    } catch (error) {
      console.error('[OutgoingChangeProcessor] Error processing changes:', error);
      if (currentBatchLocalChangeIds.length > 0) {
        currentBatchLocalChangeIds.forEach(id => this.changeQueue.add(id));
      }
    } finally {
      this.isProcessing = false;
      if (this.changeQueue.size > 0) {
        this.scheduleProcessing();
      }
      this.checkSentChanges();
    }
  }

  private async optimizeOutgoingChanges(changes: LocalChanges[]): Promise<LocalChanges[]> {
    const entityChangeMap = new Map<string, LocalChanges[]>(); // key: table:entityId
    
    for (const change of changes) {
        const entityId = (change.data as Record<string, any>)?.id;
        if (!entityId) {
            console.warn(`[OutgoingChangeProcessor] Change ${change.id} missing entity_id in data during optimization.`);
            // Decide how to handle: skip, or include as is if it's a delete without full data
            if (change.operation === 'delete' && change.data && Object.keys(change.data).length === 1 && (change.data as Record<string,any>).id) {
                // If it's a delete and data only contains id, it's probably fine.
            } else {
                 // finalChanges.push(change); // Or push as is if cannot determine entityId
                 continue;
            }
        }
        const key = `${change.table}:${entityId}`;
        if (!entityChangeMap.has(key)) {
            entityChangeMap.set(key, []);
        }
        entityChangeMap.get(key)!.push(change);
    }

    const finalChanges: LocalChanges[] = [];
    const processedDueToOptimization: string[] = [];

    for (const [_, entityChanges] of entityChangeMap.entries()) {
        entityChanges.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        let currentChangeData: Record<string, any> | null = null;
        let firstOpType = entityChanges[0].operation;
        const firstLocalChangeId = entityChanges[0].id; // ID of the LocalChanges record
        const entityIdForOp = (entityChanges[0].data as Record<string, any>)?.id;


        if (firstOpType === 'insert') {
            currentChangeData = { ...(entityChanges[0].data as Record<string, any>) };
        }

        for (let i = 0; i < entityChanges.length; i++) {
            const currentLocalChange = entityChanges[i];
            if (currentLocalChange.id !== firstLocalChangeId) processedDueToOptimization.push(currentLocalChange.id);

            if (currentLocalChange.operation === 'insert') {
                currentChangeData = { ...(currentLocalChange.data as Record<string, any>) };
                firstOpType = 'insert';
            } else if (currentLocalChange.operation === 'update') {
                if (firstOpType === 'insert') {
                    currentChangeData = { ...currentChangeData, ...(currentLocalChange.data as Record<string, any>) };
                } else {
                    if (currentChangeData === null) currentChangeData = {}; // Should have original data
                    currentChangeData = { ...currentChangeData, ...(currentLocalChange.data as Record<string, any>) };
                    if (firstOpType !== 'insert') firstOpType = 'update';
                }
            } else if (currentLocalChange.operation === 'delete') {
                if (firstOpType === 'insert') {
                    currentChangeData = null; // No-op
                    if (!processedDueToOptimization.includes(firstLocalChangeId)) processedDueToOptimization.push(firstLocalChangeId);
                    break;
                } else {
                    currentChangeData = { id: entityIdForOp }; // For delete, only entity ID is needed in data
                    firstOpType = 'delete';
                    for(let j=0; j < i; j++) {
                        if (!processedDueToOptimization.includes(entityChanges[j].id)) {
                            processedDueToOptimization.push(entityChanges[j].id);
                        }
                    }
                    break; 
                }
            }
        }

        if (currentChangeData) {
            const representativeChange = { ...entityChanges[0] }; // Base LocalChanges record
            representativeChange.id = firstLocalChangeId; // Use the ID of the first LocalChanges record
            representativeChange.operation = firstOpType as 'insert' | 'update' | 'delete';
            representativeChange.data = currentChangeData; // The merged/final data
            representativeChange.updatedAt = entityChanges[entityChanges.length -1].updatedAt;
            finalChanges.push(representativeChange);
        }
    }
    
    if (processedDueToOptimization.length > 0) {
        console.log(`[OutgoingChangeProcessor] ${processedDueToOptimization.length} changes were optimized out or merged.`);
        await this.markLocalChangesAsProcessed(processedDueToOptimization, true, 'optimized_merged');
    }
    return finalChanges;
  }

  private checkSentChanges(): void {
    const now = Date.now();
    this.sentChanges.forEach((timestamp, localChangeId) => {
      if (now - timestamp > CHANGE_TIMEOUT) {
        console.warn(`[OutgoingChangeProcessor] Change ${localChangeId} timed out. Re-queueing.`);
        this.sentChanges.delete(localChangeId);
        this.changeQueue.add(localChangeId);
        this.scheduleProcessing();
      }
    });
  }

  // Use specific message types from sync-types
  public handleChangesReceived(message: BaseServerMessage): void {
    if (message.type !== 'srv_changes_received') return;
    const receivedMessage = message as ServerReceivedMessage; // Narrow type
    console.log(`[OutgoingChangeProcessor] Server acknowledged receipt of changes. Original Msg ID (from server): ${ (receivedMessage as any).originalMessageId || 'N/A'}. ChangeIDs from server: ${receivedMessage.changeIds?.join(', ')}`);
    // The `changeIds` in `ServerReceivedMessage` are the `LocalChanges.id`s that the server received.
    // This is a direct ACK for those specific changes.
    // However, the prompt's original SyncChangeManager used originalMessageId.
    // If server sends `originalMessageId` corresponding to `ClientMessage.messageId`, mapping is needed.
    // For now, assume `message.changeIds` are the `LocalChanges.id`s.
  }

  public async handleChangesApplied(message: BaseServerMessage): Promise<void> {
    if (message.type !== 'srv_changes_applied') return;
    const appliedMessage = message as ServerAppliedMessage; // Narrow type

    const appliedLocalChangeIds = appliedMessage.appliedChanges || []; // These are LocalChanges.id
    // The ServerAppliedMessage in sync-types doesn't have failedChangeIds directly.
    // It has a single `success: boolean` and `error?: string` for the whole batch.

    console.log(`[OutgoingChangeProcessor] Server applied changes. Success: ${appliedMessage.success}. Applied: ${appliedLocalChangeIds.length}. Error: ${appliedMessage.error || 'None'}`);

    const successfullyAppliedLocalChangeIds: string[] = [];
    const permanentlyFailedLocalChangeIds: string[] = [];

    if (appliedMessage.success) {
        appliedLocalChangeIds.forEach((localId: string) => { // Explicitly type localId
            successfullyAppliedLocalChangeIds.push(localId);
            this.sentChanges.delete(localId);
        });
    } else {
        // If the whole batch failed, all `appliedChangeIds` (which are the ones attempted) are considered failed.
        appliedLocalChangeIds.forEach((localId: string) => { // Explicitly type localId
            console.error(`[OutgoingChangeProcessor] Server failed to apply change ${localId} (part of failed batch): ${appliedMessage.error}`);
            this.sentChanges.delete(localId);
            permanentlyFailedLocalChangeIds.push(localId);
            this.events.emit('outgoing_change_failed_on_server', { id: localId, error: appliedMessage.error });
        });
    }
    
    if (successfullyAppliedLocalChangeIds.length > 0) {
        await this.markLocalChangesAsProcessed(successfullyAppliedLocalChangeIds, true, 'applied_by_server');
    }
    if (permanentlyFailedLocalChangeIds.length > 0) {
        await this.markLocalChangesAsProcessed(permanentlyFailedLocalChangeIds, true, `server_rejection: ${appliedMessage.error || 'Unknown error'}`);
    }
  }
  
private async markChangesAsProcessed(entityIds: string[], success: boolean): Promise<void> {
    const dataSource = this.dbInitializer.getDataSource();
    if (!dataSource) {
      console.error("[OutgoingChangeProcessor]: Cannot mark changes as processed, DataSource not available.");
      return;
    }
    if (entityIds.length === 0) return;

    console.log(`[OutgoingChangeProcessor] Attempting to mark LocalChanges as processed based on ${entityIds.length} received entity IDs (success: ${success})`);

    // This logic needs significant revision. It currently tries to find LocalChanges
    // based on entity IDs within the `data` column, which is inefficient and potentially incorrect.
    // The correct approach depends on whether the server ACKs outgoing changes using
    // the LocalChanges.id or the entity's ID (e.g., Comment.id).
    // Assuming for now this method is primarily for INCOMING changes,
    // and outgoing ACKs are handled differently (e.g., in handleChangesApplied).

    let successfullyMarkedCount = 0;
    try {
      await dataSource.manager.transaction(async transactionalEntityManager => {
        const localChangesRepo = transactionalEntityManager.getRepository(LocalChanges);
        
        for (const entityId of entityIds) {
          const changesToUpdate = await localChangesRepo.createQueryBuilder("lc")
            .where(`lc.data ->> 'id' = :entityId`, { entityId })
            .andWhere("lc.processedSync = 0")
            .getMany();

          if (changesToUpdate.length > 0) {
            for (const changeToUpdate of changesToUpdate) {
              changeToUpdate.processedSync = success ? 1 : 0;
              await localChangesRepo.save(changeToUpdate);
              successfullyMarkedCount++;
            }
          } else {
            console.warn(`[OutgoingChangeProcessor]: No unprocessed LocalChanges found for entity ID ${entityId} to mark as processed.`);
          }
        }
      });

      // After successful transaction, update the pending count
      const currentLocalChangesRepo = this.dbInitializer.getLocalChangesRepository();
      this.pendingChangesCount = await currentLocalChangesRepo.count({ where: { processedSync: 0 } });

      entityIds.forEach(id => {
        // Example: this.sentChanges.delete(id); // If entityIds are LocalChanges IDs and this method should interact with sentChanges
      });

      this.triggerDebouncedUpdatePendingChangesCount();
      console.log(`[OutgoingChangeProcessor] Attempted to mark ${successfullyMarkedCount} LocalChanges records as processed based on ${entityIds.length} entity IDs. Final pending count: ${this.pendingChangesCount}`);

    } catch (error) {
      console.error('[OutgoingChangeProcessor]: Error marking changes as processed:', error);
      // Handle error, potentially retry or log for manual intervention
    }
  }
  private async markLocalChangesAsProcessed(entityIdsFromServer: string[], success: boolean, reason: string): Promise<void> {
    if (entityIdsFromServer.length === 0) return;
    if (!this.dbInitializer.isInitialized() || !this.localChangesRepo) {
        console.error("[OutgoingChangeProcessor] Cannot mark changes, DB not ready.");
        return;
    }
    try {
        const statusToSet = success ? 1 : 0;
        let updatedCount = 0;
        const successfullyProcessedLocalChangeIds: string[] = [];

        for (const entityId of entityIdsFromServer) {
            // Use createQueryBuilder to correctly query against the JSONB field
            const changesToUpdate = await this.localChangesRepo.createQueryBuilder("LocalChanges")
                .where(`("LocalChanges"."data" ->> 'id') = :entityId`, { entityId })
                .andWhere('LocalChanges.processedSync = :processedSyncStatus', { processedSyncStatus: 0 })
                .getMany();

            if (changesToUpdate.length > 0) {
                console.log(`[OutgoingChangeProcessor] Found ${changesToUpdate.length} LocalChanges record(s) for entity ID ${entityId} to mark as processedSync=${statusToSet}`);
                for (const change of changesToUpdate) {
                    change.processedSync = statusToSet;
                    await this.localChangesRepo.save(change); // Save each updated entity
                    successfullyProcessedLocalChangeIds.push(change.id); // Store the actual LocalChanges.id
                    updatedCount++;
                }
            } else {
                console.warn(`[OutgoingChangeProcessor] No unprocessed LocalChanges found for entity ID ${entityId} to mark as processedSync=${statusToSet}. This might be okay if changes were optimized out or already processed by another means.`);
            }
        }

        console.log(`[OutgoingChangeProcessor] Marked ${updatedCount} LocalChanges as processedSync=${statusToSet} due to: ${reason}, based on ${entityIdsFromServer.length} entity IDs from server.`);
        
        if (updatedCount > 0) {
            // Recalculate pendingChangesCount more accurately after updates
            this.pendingChangesCount = await this.localChangesRepo.count({ where: { processedSync: 0 } });
            this.triggerDebouncedUpdatePendingChangesCount();
            this.events.emit('outgoing_changes_processed_locally', {
                changeIds: successfullyProcessedLocalChangeIds, // Emit the actual LocalChanges.id that were processed
                success,
                reason,
                newPendingCount: this.pendingChangesCount
            });
        }
    } catch (error) {
        console.error(`[OutgoingChangeProcessor] Error marking LocalChanges as processed (reason: ${reason}):`, error);
    }
  }

  public handleServerError(message: ServerErrorResponseMessage | BaseServerMessage): void {
    if (message.type !== 'srv_error') return;
    // message is now ServerErrorResponseMessage (or your defined specific error type)
    const { errorCode, errorMessage, originalMessageId } = message as ServerErrorResponseMessage;
    console.error(`[OutgoingChangeProcessor] Received server error: ${errorCode} - ${errorMessage}. Original Msg ID: ${originalMessageId}`);
  }

  private async loadUnprocessedChanges(): Promise<void> {
    if (!this.dbInitializer.isInitialized() || !this.localChangesRepo) {
      console.warn('[OutgoingChangeProcessor] Cannot load unprocessed changes, DB not ready.');
      return;
    }
    try {
      console.log('[OutgoingChangeProcessor] Loading unprocessed changes from DB...');
      const unprocessed = await this.localChangesRepo.find({
        where: { processedSync: 0 }, // Use camelCase
        order: { createdAt: 'ASC' }, // Use camelCase
        take: MAX_CHANGES_PER_BATCH * 5
      });

      let newChangesAddedToQueue = 0;
      unprocessed.forEach(change => {
        if (!this.changeQueue.has(change.id) && !this.sentChanges.has(change.id)) {
          this.changeQueue.add(change.id);
          newChangesAddedToQueue++;
        }
      });
      
      const totalUnprocessedCount = await this.localChangesRepo.count({ where: { processedSync: 0 }}); // Use camelCase
      this.pendingChangesCount = totalUnprocessedCount;
      this.triggerDebouncedUpdatePendingChangesCount();

      if (newChangesAddedToQueue > 0) {
        console.log(`[OutgoingChangeProcessor] Loaded ${newChangesAddedToQueue} unprocessed changes into the queue. Total pending in DB: ${totalUnprocessedCount}. Queue size: ${this.changeQueue.size}`);
        this.scheduleProcessing();
      } else if (unprocessed.length > 0) {
        console.log(`[OutgoingChangeProcessor] Found ${unprocessed.length} unprocessed changes in DB, but they are already in queue or sent map. Total pending in DB: ${totalUnprocessedCount}.`);
      } else {
        console.log('[OutgoingChangeProcessor] No unprocessed changes found in DB.');
      }
    } catch (error) {
      console.error('[OutgoingChangeProcessor] Error loading unprocessed changes:', error);
      setTimeout(() => this.loadUnprocessedChanges(), 5000);
    }
  }

  public async processQueuedChanges(): Promise<void> {
    console.log('[OutgoingChangeProcessor] processQueuedChanges called externally.');
    if (this.isProcessing) {
      console.log('[OutgoingChangeProcessor] Already processing, request to process queued changes ignored.');
      return;
    }
    if (this.changeQueue.size > 0) {
      this.scheduleProcessing();
    } else {
      await this.loadUnprocessedChanges();
      if (this.changeQueue.size > 0) {
        this.scheduleProcessing();
      } else {
        console.log('[OutgoingChangeProcessor] No changes in queue or DB to process.');
      }
    }
  }
  
  public getQueueSize(): number {
    // Return the count reflecting all pending changes, not just those currently in the Set
    return this.pendingChangesCount;
  }

  public getPendingChangesCount(): number {
    return this.pendingChangesCount;
  }

  public async getPendingChanges(): Promise<LocalChanges[]> {
    if (!this.dbInitializer.isInitialized() || !this.localChangesRepo) {
        console.error("[OutgoingChangeProcessor] Cannot get pending changes, DB not ready.");
        return [];
    }
    return this.localChangesRepo.find({
        where: { processedSync: 0 }, // Use camelCase
        order: { createdAt: 'ASC' } // Use camelCase
    });
  }

  public async clearUnprocessedChanges(): Promise<void> {
    if (!this.dbInitializer.isInitialized() || !this.localChangesRepo) {
        console.error("[OutgoingChangeProcessor] Cannot clear unprocessed changes, DB not ready.");
        return;
    }
    try {
        const deleteResult = await this.localChangesRepo.delete({ processedSync: 0 }); // Use camelCase
        console.log(`[OutgoingChangeProcessor] Cleared ${deleteResult.affected || 0} unprocessed local changes.`);
        this.changeQueue.clear();
        this.sentChanges.clear();
        this.pendingChangesCount = 0;
        this.triggerDebouncedUpdatePendingChangesCount();
        this.events.emit('all_unprocessed_outgoing_changes_cleared');
    } catch (error) {
        console.error('[OutgoingChangeProcessor] Error clearing unprocessed changes:', error);
    }
  }

  private convertKeysToSnakeCase(obj: any): any {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.convertKeysToSnakeCase(item));
    }
    const newObj: Record<string, any> = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const snakeKey = key.replace(/([A-Z]+)/g, "_$1").replace(/^_/, '').toLowerCase();
        newObj[snakeKey] = this.convertKeysToSnakeCase(obj[key]);
      }
    }
    return newObj;
  }
/**
   * Handles an LSN reset event.
   * Clears internal queues and state related to outgoing changes,
   * as they are no longer valid with the old LSN.
   */
  public async handleLSNReset(): Promise<void> {
    console.warn("[OutgoingChangeProcessor] Handling LSN reset. Clearing outgoing change queues.");
    
    // Stop any ongoing processing
    this.isProcessing = false;
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }

    // Clear internal state
    this.changeQueue.clear();
    this.sentChanges.clear();
    
    // Reset pending count and notify
    if (this.pendingChangesCount > 0) {
        this.pendingChangesCount = 0;
        this.triggerDebouncedUpdatePendingChangesCount(); // Ensure UI/persister gets updated
    }

    // Note: This does NOT clear the LocalChanges table in the database.
    // Depending on the sync strategy, those entries might need to be marked
    // as processed/obsolete separately or handled during the next sync cycle.
    // For now, we just clear the in-memory processing state.
    console.log("[OutgoingChangeProcessor] Outgoing change queues cleared due to LSN reset.");
  }

  // Removed duplicate handleLSNReset method definition
} // Added missing closing brace for the class