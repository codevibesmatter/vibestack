import { getNewPGliteDataSource, NewPGliteDataSource } from '../db/newtypeorm/NewDataSource';
import { SyncMetadata } from '@repo/dataforge/client-entities';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid'; // For generating client ID if needed
// Remove import of old SyncState from SyncManager
import { SyncStatus, ClientId, LSN } from './interfaces'; // Import new types

// Interface for the data managed by this persister
export interface ISyncStateData {
    clientId: ClientId;
    currentLsn: LSN;
    syncState: SyncStatus; // Use new SyncStatus type
    pendingChangesCount: number;
    lastSyncTime: Date | null;
}

export class SyncStatePersister {
  private dataSource: NewPGliteDataSource | null = null;
  private metadataRepo!: Repository<SyncMetadata>; // Definite assignment after init
  private isInitialized: boolean = false;
  private currentStateData: ISyncStateData | null = null; // Cache loaded state

  // Debounce mechanism for saving
  private saveDebounceTimer: NodeJS.Timeout | null = null;
  private pendingMetadataSave: boolean = false;
  private readonly SAVE_DEBOUNCE_DELAY = 500; // ms

  constructor() {}

  public async initialize(): Promise<ISyncStateData> {
    if (this.isInitialized) {
        if (!this.currentStateData) {
            // Should not happen if initialized, but handle defensively
            return await this.loadMetadata();
        }
        return this.currentStateData;
    }

    this.dataSource = await getNewPGliteDataSource();
    if (!this.dataSource) {
        throw new Error("SyncStatePersister: Failed to get DataSource.");
    }
    this.metadataRepo = this.dataSource.getRepository(SyncMetadata);
    this.currentStateData = await this.loadMetadata(); // Load initial state
    this.isInitialized = true;
    console.log(`SyncStatePersister: Initialized. ClientID: ${this.currentStateData.clientId}, LSN: ${this.currentStateData.currentLsn}`);
    return this.currentStateData;
  }

  // Loads metadata from DB or creates initial if not found
  private async loadMetadata(): Promise<ISyncStateData> {
    // Adapted logic from SyncManager.loadMetadata
    console.log('SyncStatePersister: Loading sync metadata...');
    if (!this.metadataRepo) throw new Error("Repository not initialized in loadMetadata");

    try {
        const existingMetadataArray = await this.metadataRepo.find();
        if (existingMetadataArray && existingMetadataArray.length > 0) {
            const meta = existingMetadataArray[0];
            console.log(`SyncStatePersister: Found existing metadata ID: ${meta.id}`);
            return {
                clientId: meta.clientId || this.generateClientId(), // Ensure clientId exists
                currentLsn: meta.currentLsn || '0/0',
                syncState: 'disconnected', // Ensure this matches SyncStatus type
                pendingChangesCount: meta.pendingChangesCount || 0,
                lastSyncTime: meta.lastSyncTime || null
            };
        } else {
            console.log('SyncStatePersister: No existing metadata. Creating initial record.');
            const initialData: ISyncStateData = {
                clientId: this.generateClientId(),
                currentLsn: '0/0',
                syncState: 'disconnected', // Ensure this matches SyncStatus type
                pendingChangesCount: 0,
                lastSyncTime: null
            };
            // Save immediately on creation
            await this.performSave(initialData);
            return initialData;
        }
    } catch (error) {
        console.error('SyncStatePersister: Error loading metadata, creating defaults.', error);
        const defaultData: ISyncStateData = {
            clientId: this.generateClientId(),
            currentLsn: '0/0',
            syncState: 'disconnected', // Ensure this matches SyncStatus type
            pendingChangesCount: 0,
            lastSyncTime: null
        };
        // Attempt to save defaults
        try {
            await this.performSave(defaultData);
        } catch (saveError) {
            console.error('SyncStatePersister: Failed to save default metadata after load error:', saveError);
        }
        return defaultData;
    }
  }

  // Saves the provided state (debounced)
  public async saveState(stateData: Partial<ISyncStateData>): Promise<void> {
     if (!this.isInitialized || !this.currentStateData) {
         console.error("SyncStatePersister: Cannot save state, not initialized.");
         return;
     }
     // Update cached state immediately
     this.currentStateData = { ...this.currentStateData, ...stateData };

     // Debounce the actual save operation
     this.pendingMetadataSave = true;
     if (this.saveDebounceTimer) {
         clearTimeout(this.saveDebounceTimer);
     }
     this.saveDebounceTimer = setTimeout(async () => {
         if (this.pendingMetadataSave) {
             await this.performSave(this.currentStateData!); // Use the latest cached state
         }
         this.saveDebounceTimer = null;
     }, this.SAVE_DEBOUNCE_DELAY);
  }

  // Performs the actual database save operation
  private async performSave(stateToSave: ISyncStateData): Promise<void> {
    if (!this.isInitialized || !this.metadataRepo) {
        console.error("SyncStatePersister: Cannot perform save, not initialized.");
        this.pendingMetadataSave = true; // Keep flag true to retry later if needed
        return;
    }
    console.log(`SyncStatePersister: Performing save. ClientID: ${stateToSave.clientId}, LSN: ${stateToSave.currentLsn}, State: ${stateToSave.syncState}`);
    try {
        const existingMetadataArray = await this.metadataRepo.find();
        let metadataToSaveEntity: SyncMetadata;

        if (existingMetadataArray && existingMetadataArray.length > 0) {
            metadataToSaveEntity = existingMetadataArray[0];
            // Update properties
            metadataToSaveEntity.clientId = stateToSave.clientId;
            metadataToSaveEntity.currentLsn = stateToSave.currentLsn;
            metadataToSaveEntity.syncState = stateToSave.syncState;
            metadataToSaveEntity.lastSyncTime = stateToSave.lastSyncTime || new Date();
            metadataToSaveEntity.pendingChangesCount = stateToSave.pendingChangesCount;
        } else {
            metadataToSaveEntity = this.metadataRepo.create({
                clientId: stateToSave.clientId,
                currentLsn: stateToSave.currentLsn,
                syncState: stateToSave.syncState,
                lastSyncTime: stateToSave.lastSyncTime || new Date(),
                pendingChangesCount: stateToSave.pendingChangesCount
            });
        }
        await this.metadataRepo.save(metadataToSaveEntity);
        this.pendingMetadataSave = false; // Reset flag on successful save
        console.log(`SyncStatePersister: Save successful.`);
    } catch (error) {
        console.error('SyncStatePersister: Error performing save:', error);
        this.pendingMetadataSave = true; // Keep flag true for potential retry
    }
  }

  // Flushes any pending debounced save immediately
  public async flush(): Promise<void> {
    if (this.saveDebounceTimer) {
        clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = null;
    }
    if (this.pendingMetadataSave && this.currentStateData) {
        console.log("SyncStatePersister: Flushing pending save...");
        await this.performSave(this.currentStateData);
    } else {
         console.log("SyncStatePersister: Flush called, but no pending save.");
    }
  }

  // --- Public Accessors ---

  public getClientId(): string {
    if (!this.currentStateData) {
        console.warn("SyncStatePersister: getClientId called before initialization or after failure.");
        // Attempt to load if not initialized, though initialize should be called first.
        // Or throw error / return default empty string
        return '';
    }
    return this.currentStateData.clientId;
  }

  public getLSN(): string {
     if (!this.currentStateData) {
        console.warn("SyncStatePersister: getLSN called before initialization or after failure.");
        return '0/0'; // Default LSN
    }
    return this.currentStateData.currentLsn;
  }

  public getStatus(): SyncStatus { // Ensure return type is SyncStatus
       if (!this.currentStateData) {
          console.warn("SyncStatePersister: getStatus called before initialization or after failure.");
        return 'disconnected'; // Default state
    }
    // Note: This returns the *persisted* state, which might lag behind the actual live state.
    // SyncManager's getStatus() should combine this with WebSocketConnector status for live info.
    return this.currentStateData.syncState; // Now returns SyncStatus
  }
  
  public getPendingChangesCount(): number {
     if (!this.currentStateData) {
        console.warn("SyncStatePersister: getPendingChangesCount called before initialization or after failure.");
        return 0;
    }
    return this.currentStateData.pendingChangesCount;
  }

  // --- Reset Method ---
  public async resetSyncState(): Promise<void> {
    console.warn("SyncStatePersister: Resetting sync state (LSN, etc.).");
    const newClientId = this.generateClientId(); // Generate a new client ID on reset
    const initialData: ISyncStateData = {
        clientId: newClientId,
        currentLsn: '0/0',
        syncState: 'disconnected', // Ensure this matches SyncStatus type
        pendingChangesCount: 0,
        lastSyncTime: null
    };
    this.currentStateData = initialData; // Update cache immediately
    await this.flush(); // Clear any pending saves
    await this.performSave(initialData); // Force save the reset state
    console.log(`SyncStatePersister: Sync state reset complete. New ClientID: ${newClientId}`);
    // Optionally emit an event if other modules need to react directly
    // this.events.emit('syncStatePersister:stateReset', initialData);
  }

  private generateClientId(): string {
    return uuidv4();
  }
}