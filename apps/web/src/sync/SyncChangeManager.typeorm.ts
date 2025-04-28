import { getNewPGliteDataSource, NewPGliteDataSource } from '../db/newtypeorm/NewDataSource'; // Import new TypeORM service
import { DataSource, EntityManager, EntityTarget, In, ObjectLiteral } from 'typeorm'; // Import necessary TypeORM types
import { v4 as uuidv4 } from 'uuid';
// Import the shared types from our packages
// Also import the canonical list of client entities
import { 
  clientEntities, // Import the array
  Comment, 
  LocalChanges, 
  Project, 
  Task, 
  TaskPriority, // Restored import
  TaskStatus, // Restored import
  User 
} from '@repo/dataforge/client-entities';
import type { TableChange } from '@repo/sync-types';
import { SyncEventEmitter } from './SyncEventEmitter';
import { SyncManager } from './SyncManager';

// Constants for batch processing
const BATCH_DELAY = 50; // ms to wait before processing to allow batching
const MAX_CHANGES_PER_BATCH = 50; // max changes to include in a single message
const CHANGE_TIMEOUT = 300000; // 5 minutes timeout for a change before considering it lost
const INCOMING_BATCH_SIZE = 250; // Batch size for TypeORM save operations

/**
 * SyncChangeManager
 * 
 * A simplified change processing system that:
 * 1. Tracks and processes outgoing local changes
 * 2. Processes incoming changes from the server
 * 3. Handles acknowledgments and error states
 * 
 * This replaces ChangeProcessor.ts and TableChangeProcessor.ts with a simpler implementation
 */
export class SyncChangeManager {
  // Singleton instance
  private static instance: SyncChangeManager | null = null;
  
  // TypeORM DataSource instance (use the new type)
  private dataSource: NewPGliteDataSource | null = null;
  
  // Core dependencies
  private syncManager: SyncManager;
  private events: SyncEventEmitter;
  
  // Change tracking
  private changeQueue: Set<string> = new Set(); // Set of change IDs to process
  private isProcessing: boolean = false;
  private processTimer: number | null = null;
  private sentChanges: Map<string, number> = new Map(); // Map of changeId -> timestamp
  private pendingChangesCount: number = 0;
  
  /**
   * Private constructor - use getInstance() instead
   */
  private constructor() {
    console.log('SyncChangeManager: Initializing instance');
    this.syncManager = SyncManager.getInstance();
    this.events = this.syncManager.events; // Get shared emitter instance
    
    // Initialize event listeners
    this.initializeEventListeners();
    
    // Initialize TypeORM DataSource and load changes
    this.initializeDataSourceAndLoadChanges();
  }
  
  /**
   * Get the singleton instance
   */
  public static getInstance(): SyncChangeManager {
    if (!SyncChangeManager.instance) {
      SyncChangeManager.instance = new SyncChangeManager();
    }
    return SyncChangeManager.instance;
  }
  
  /**
   * Initialize TypeORM DataSource and load pending changes count
   */
  private async initializeDataSourceAndLoadChanges(): Promise<void> {
    if (this.dataSource) {
      console.log('SyncChangeManager: DataSource already initialized.');
      return this.loadPendingChangesCount(); // Load count if DS already exists
    }

    try {
      console.log('SyncChangeManager: Initializing New PGLite DataSource...');
      // Use the new factory function
      // TODO: Review and update the configuration options as needed for the new source
      this.dataSource = await getNewPGliteDataSource({
        database: 'shadadmin_db', // Or your actual DB name
        synchronize: false, // Ensure this is false for production/stable schema
        logging: false, // Set logging as needed (e.g., true for development)
        // Use the imported clientEntities array
        entities: clientEntities 
      });

      if (!this.dataSource || !this.dataSource.isInitialized) {
        // Check isInitialized as the new source might not throw but fail init
        throw new Error('Failed to initialize New PGLite DataSource or it did not initialize correctly.');
      }

      console.log('SyncChangeManager: New PGLite DataSource initialized, loading pending changes.');
      await this.loadPendingChangesCount(); // Load count after successful initialization

    } catch (error) {
      console.error('SyncChangeManager: Failed to initialize New PGLite DataSource:', error);
      // Retry initialization after a delay
      setTimeout(() => this.initializeDataSourceAndLoadChanges(), 5000);
    }
  }
  
  /**
   * Load the count of pending changes using TypeORM
   */
  private async loadPendingChangesCount(): Promise<void> {
    if (!this.dataSource) {
      console.error("SyncChangeManager: Cannot load pending changes count, DataSource not initialized.");
      // Optionally trigger re-initialization or handle error
      // setTimeout(() => this.initializeDataSourceAndLoadChanges(), 1000); // Example retry
      return;
    }

    try {
      // Get repository using the EntityManager from the DataSource
      const localChangesRepo = this.dataSource.manager.getRepository(LocalChanges);

      // Use Query Builder's getCount() method - should work now
      const count = await localChangesRepo.createQueryBuilder("local_changes") // Alias is needed here
          .where("local_changes.processedSync = :status", { status: 0 }) // Use integer 0 instead of boolean false
          .getCount();

      this.pendingChangesCount = count;

      // Update the sync manager
      this.syncManager.updatePendingChangesCount(count);

      if (count > 0) {
        console.log(`SyncChangeManager: Found ${count} pending changes to process (TypeORM)`);
      } else {
        console.debug('SyncChangeManager: No pending changes found (TypeORM)');
      }

    } catch (error) {
      console.error('SyncChangeManager: Failed to load pending changes count using TypeORM:', error);

      // Default to zero pending changes in case of error
      this.pendingChangesCount = 0;
      this.syncManager.updatePendingChangesCount(0);

      // Schedule a retry using the same method
      setTimeout(() => this.loadPendingChangesCount(), 2000);
    }
  }
  
  /**
   * Create a change record for a local data change using TypeORM
   */
  public async trackChange(
    table: string,
    operation: 'insert' | 'update' | 'delete',
    data: Record<string, any>,
    originalData?: Record<string, any> // Add original data for comparison
  ): Promise<string> {
    const changeId = uuidv4();

    if (!this.dataSource) {
      console.error("SyncChangeManager: Cannot track change, DataSource not initialized.");
      // Handle error appropriately - maybe queue the change attempt?
      throw new Error("DataSource not available for trackChange");
    }

    try {
      // Get repository
      const localChangesRepo = this.dataSource.manager.getRepository(LocalChanges);

      // For updates, only include modified fields
      let changeData = data;
      if (operation === 'update' && originalData) {
        changeData = {};
        for (const [key, value] of Object.entries(data)) {
          // Simple comparison, might need deep comparison for complex objects
          if (JSON.stringify(value) !== JSON.stringify(originalData[key])) {
            changeData[key] = value;
          }
        }
        // If no fields were actually changed, maybe skip tracking?
        if (Object.keys(changeData).length === 0 && data.id) {
            console.log(`SyncChangeManager: Skipping tracking update for ${table}:${data.id} as no data changed.`);
            // Return the entity id even if no change was tracked
            // Or perhaps return a specific indicator like null or undefined?
            return data.id; 
        }
      }

      // Convert data to JSON string
      const dataJson = JSON.stringify(changeData);
      const currentLsn = this.syncManager.getLSN(); // Assuming this remains valid
      const now = new Date(); // Use Date object directly if column type supports it

      // Create and save the new LocalChanges entity
      const newChange = localChangesRepo.create({
        id: changeId,
        table: table,
        operation: operation,
        data: changeData,
        lsn: currentLsn,
        updatedAt: now, // TypeORM handles Date objects
        processedSync: 0 // Use 0 based on previous findings
      });

      await localChangesRepo.save(newChange);

      // Queue the change for processing
      this.changeQueue.add(changeId);
      console.log(`SyncChangeManager: Tracked change ${changeId} for ${operation} on ${table} (TypeORM)`);

      // Schedule processing
      this.scheduleProcessing();

      // Emit event
      this.events.emit('change_created', { changeId, table, operation });

      // Increment in-memory count and trigger debounced update
      this.pendingChangesCount++;
      this.debouncedUpdatePendingChangesCount();

      return changeId;
    } catch (error) {
      console.error('SyncChangeManager: Error tracking change using TypeORM:', error);
      // Re-throw or handle as appropriate
      throw error;
    }
  }
  
  /**
   * Debounced function to update the pending changes count
   * This prevents excessive metadata saves
   */
  private debouncedUpdatePendingChangesCount = (() => {
    let timeoutId: any = null;
    let lastUpdateTime = 0;
    const MIN_UPDATE_INTERVAL = 3000; // Only update at most once every 3 seconds
    
    return () => {
      // Check if we've updated recently
      const now = Date.now();
      if (now - lastUpdateTime < MIN_UPDATE_INTERVAL) {
        // If existing timeout, just let it handle the update
        if (timeoutId) return;
        
        // Otherwise set a new timeout for the minimum interval
        timeoutId = setTimeout(() => {
          lastUpdateTime = Date.now();
          this.syncManager.updatePendingChangesCount(this.pendingChangesCount);
          timeoutId = null;
        }, MIN_UPDATE_INTERVAL - (now - lastUpdateTime));
        return;
      }
      
      // Clear any existing timeout
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      // Set a new timeout with a longer delay
      timeoutId = setTimeout(() => {
        lastUpdateTime = Date.now();
        this.syncManager.updatePendingChangesCount(this.pendingChangesCount);
        timeoutId = null;
      }, 1000); // Update at most once per second
    };
  })();
  
  /**
   * Schedule processing of changes (with debounce)
   */
  private scheduleProcessing(): void {
    // If already scheduled, do nothing
    if (this.processTimer !== null) return;
    
    // If changes are being processed, do nothing
    if (this.isProcessing) return;
    
    // Schedule processing after a short delay to batch changes
    this.processTimer = window.setTimeout(() => {
      this.processTimer = null;
      this.processChanges().catch(error => {
        console.error('Error processing changes:', error);
      });
    }, BATCH_DELAY);
  }
  
  /**
   * Process queued changes
   */
  private async processChanges(): Promise<void> {
    // If already processing or no changes to process, return
    if (this.isProcessing || this.changeQueue.size === 0) return;

    // Check DataSource initialization
    if (!this.dataSource) {
      console.error("SyncChangeManager: Cannot process changes, DataSource not initialized.");
      // Optionally trigger re-initialization
      // setTimeout(() => this.initializeDataSourceAndLoadChanges(), 1000);
      return;
    }

    // Check connection status via SyncManager
    const isConnected = this.syncManager.isConnected();
    const currentState = this.syncManager.getState();

    if (!isConnected) {
      console.log('Not processing changes - not connected to server');
      this.syncManager.on('websocket:open', () => { // Revert back to 'on'
        setTimeout(() => this.scheduleProcessing(), 1000);
      });
      return;
    }

    if (currentState !== 'live') {
      console.log(`Not processing changes - current state is ${currentState}, waiting for 'live' state`);
      setTimeout(() => this.scheduleProcessing(), 5000);
      return;
    }

    this.isProcessing = true;

    try {
      // Convert queue to array for processing
      const changeIds = Array.from(this.changeQueue).slice(0, MAX_CHANGES_PER_BATCH);

      // Clear these IDs from the queue *before* processing to prevent race conditions
      changeIds.forEach(id => this.changeQueue.delete(id));

      // Load the changes from the database using TypeORM
      const localChangesRepo = this.dataSource.manager.getRepository(LocalChanges);
      const changes = await localChangesRepo.find({
        where: { id: In(changeIds) } // Use TypeORM's In operator
      });

      if (changes.length === 0) {
        console.log('No changes found in DB for the selected IDs, processing skipped.');
        this.isProcessing = false;
        // If there are more changes in the queue, schedule next batch
        if (this.changeQueue.size > 0) {
          this.scheduleProcessing();
        }
        return;
      }

      console.log(`Processing ${changes.length} outgoing changes (TypeORM)`);

      // Optimize outgoing changes (this method likely needs refactoring too if it accesses DB)
      const optimizedChanges = await this.optimizeOutgoingChanges(changes);
      console.log(`Optimized ${changes.length} changes to ${optimizedChanges.length}`);

      if (optimizedChanges.length === 0) {
          console.log('All changes were optimized out, nothing to send.');
          this.isProcessing = false;
          if (this.changeQueue.size > 0) {
            this.scheduleProcessing();
          }
          return;
      }

      // Convert changes to the format expected by the server
      const clientId = this.syncManager.getClientId();
      const tableChanges = optimizedChanges.map(change => {
        // Assuming change.data is already an object from TypeORM entity
        const changeDataSnake = this.convertKeysToSnakeCase(change.data);
        return {
          table: change.table,
          operation: change.operation as 'insert' | 'update' | 'delete', // Cast if necessary
          data: {
            ...changeDataSnake,
            client_id: clientId
          }
        };
      });

      // Send changes to the server
      const success = this.syncManager.send({
        type: 'clt_send_changes',
        clientId: this.syncManager.getClientId(),
        messageId: `changes_${Date.now()}`,
        timestamp: Date.now(),
        changes: tableChanges
      });

      if (success) {
        // Record sent time for each change ID that was *attempted*
        const now = Date.now();
        // Use the original changeIds array from the queue for tracking sent attempts
        changeIds.forEach(id => this.sentChanges.set(id, now)); 

        // Emit event with the original changeIds
        this.events.emit('changes_sent', { 
          changeIds, // Use original IDs from queue
          messageId: `changes_${now}`
        });
        console.log(`Sent ${tableChanges.length} changes to server (orig IDs: ${changeIds.length})`);
      } else {
        console.warn('Failed to send changes, putting IDs back in queue');
        // Put changes back in the queue for retry
        changeIds.forEach(id => this.changeQueue.add(id));
        // No need to schedule processing here, rely on connection events or manual trigger
      }
    } catch (error) {
      console.error('SyncChangeManager: Error processing changes using TypeORM:', error);
      // Re-queue the failed batch IDs if an error occurs during DB load or processing
      const changeIds = Array.from(this.changeQueue).slice(0, MAX_CHANGES_PER_BATCH);
      changeIds.forEach(id => this.changeQueue.add(id)); 
      
      // Re-enable processing after a delay
      setTimeout(() => {
        this.isProcessing = false;
        // Maybe schedule processing here if appropriate for the error type
        // this.scheduleProcessing(); 
      }, 5000);

      return;
    } finally {
        // Always release processing lock in finally block
        this.isProcessing = false;
        // If there are more changes, schedule next batch
        if (this.changeQueue.size > 0) {
          this.scheduleProcessing();
        }
    }
  }
  
  /**
   * Optimize outgoing changes to reduce network traffic and improve efficiency
   */
  private async optimizeOutgoingChanges(changes: LocalChanges[]): Promise<LocalChanges[]> {
    // Group changes by entity (table + id) to find operations on the same entity
    const entitiesMap = new Map<string, LocalChanges[]>();
    
    // First, group all changes by entity
    for (const change of changes) {
      if (!change.data || typeof change.data !== 'object') continue;
      
      const id = (change.data as any).id;
      if (!id) continue;
      
      const key = `${change.table}:${id}`;
      if (!entitiesMap.has(key)) {
        entitiesMap.set(key, []);
      }
      entitiesMap.get(key)!.push(change);
    }
    
    // Optimize changes for each entity
    const optimizedChanges: LocalChanges[] = [];
    
    for (const [key, entityChanges] of entitiesMap.entries()) {
      // Sort changes by update time to ensure correct order
      entityChanges.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
      
      // Check if there's a delete operation
      const hasDelete = entityChanges.some(c => c.operation === 'delete');
      
      if (hasDelete) {
        // If entity is eventually deleted, just send the delete operation
        // Find the latest delete operation
        const deleteOp = entityChanges
          .filter(c => c.operation === 'delete')
          .reduce((latest, current) => 
            latest.updatedAt.getTime() > current.updatedAt.getTime() ? latest : current
          );
        
        optimizedChanges.push(deleteOp);
      } else {
        // For inserts and updates, only the latest one matters
        const latestChange = entityChanges.reduce((latest, current) => 
          latest.updatedAt.getTime() > current.updatedAt.getTime() ? latest : current
        );
        
        // If there's an insert followed by updates, convert to a single insert
        if (entityChanges.some(c => c.operation === 'insert')) {
          // Use the data from the latest change, but ensure it's an insert operation
          latestChange.operation = 'insert';
        }
        
        optimizedChanges.push(latestChange);
      }
    }
    
    // Filter out any changes that have no real effect (e.g., update with no changed fields)
    return optimizedChanges;
  }
  
  /**
   * Check for changes that were sent but not acknowledged
   */
  private checkSentChanges(): void {
    const now = Date.now();
    let timedOut = 0;
    
    // Check for changes that timed out
    this.sentChanges.forEach((timestamp, changeId) => {
      if (now - timestamp > CHANGE_TIMEOUT) {
        // Change timed out - might not have been received by server
        console.log(`Change ${changeId} timed out waiting for acknowledgment`);
        
        // Mark as processed to prevent endless loop
        this.markChangesAsProcessed([changeId], false)
          .catch(error => console.error('Error marking timed-out change as processed:', error));
        
        // Remove from sent changes tracking
        this.sentChanges.delete(changeId);
        
        timedOut++;
      }
    });
    
    if (timedOut > 0) {
      console.log(`Marked ${timedOut} timed-out changes as processed to prevent infinite loop`);
    }
  }
  
  /**
   * Handle changes received acknowledgment from server
   */
  private handleChangesReceived(message: any): void {
    const { changeIds } = message;
    
    if (!changeIds || !Array.isArray(changeIds)) {
      console.warn('Received invalid changes_received message without changeIds array');
      return;
    }
    
    console.log(`Server acknowledged receipt of ${changeIds.length} changes`);
    
    // Emit event
    this.events.emit('changes_acknowledged', {
      changeIds,
      messageId: message.messageId
    });
  }
  
  /**
   * Handle changes applied acknowledgment from server
   */
  private handleChangesApplied(message: any): void {
    console.log('Received srv_changes_applied message', message);
    
    // Handle both old (changeIds) and new (appliedChanges) field names
    const appliedChangeIds = message.appliedChanges || message.changeIds;
    const messageId = message.messageId;
    
    if (!appliedChangeIds || !Array.isArray(appliedChangeIds) || appliedChangeIds.length === 0) {
      console.warn('Received srv_changes_applied message without valid changeIds array');
      
      // If no changeIds provided, use all pending sent changes as a fallback
      const allSentChangeIds = Array.from(this.sentChanges.keys());
      
      if (allSentChangeIds.length > 0) {
        console.log(`Using ${allSentChangeIds.length} sent changes as changeIds: ${allSentChangeIds.join(', ')}`);
        
        // Mark all sent changes as processed
        this.markChangesAsProcessed(allSentChangeIds, true)
          .then(() => {
            console.log(`Successfully marked ${allSentChangeIds.length} changes as processed`);
            
            // Force a check to ensure the pending changes count is updated correctly
            this.loadUnprocessedChanges().catch((err: Error) => 
              console.error('Error loading unprocessed changes after processing:', err)
            );
          })
          .catch(error => console.error('Error marking changes as processed:', error));
        
        // Emit event
        this.events.emit('changes_applied', {
          changeIds: allSentChangeIds,
          messageId: messageId || `auto_applied_${Date.now()}`
        });
      }
      return;
    }
    
    console.log(`Server applied ${appliedChangeIds.length} changes: ${appliedChangeIds.join(', ')}`);
    
    // Mark changes as processed
    this.markChangesAsProcessed(appliedChangeIds, true)
      .then(() => {
        console.log(`Successfully marked ${appliedChangeIds.length} changes as processed`);
        
        // Force a check to ensure the pending changes count is updated correctly
        this.loadUnprocessedChanges().catch((err: Error) => 
          console.error('Error loading unprocessed changes after processing:', err)
        );
      })
      .catch(error => console.error('Error marking changes as processed:', error));
    
    // Emit event
    this.events.emit('changes_applied', {
      changeIds: appliedChangeIds,
      messageId
    });
  }
  
  /**
   * Handle server error
   */
  private handleServerError(message: any): void {
    const { error, changeIds } = message;
    
    console.error('Received error from server:', error);
    
    // If changeIds is provided, these changes failed and should be requeued
    if (changeIds && Array.isArray(changeIds)) {
      console.log(`Re-queueing ${changeIds.length} changes that failed on server`);
      
      // Remove from sent changes tracking
      changeIds.forEach(id => this.sentChanges.delete(id));
      
      // Add back to the queue for retry
      changeIds.forEach(id => this.changeQueue.add(id));
      
      // Schedule processing
      this.scheduleProcessing();
    }
    
    // Emit error event
    this.events.emit('sync_error', {
      error,
      phase: 'server_processing',
      changeIds
    });
  }
  
  /**
   * Mark changes as processed using TypeORM
   */
  private async markChangesAsProcessed(changeIds: string[], success: boolean): Promise<void> {
    if (!this.dataSource) {
      console.error("SyncChangeManager: Cannot mark changes, DataSource not initialized.");
      return;
    }
    if (changeIds.length === 0) return;

    console.log(`Marking ${changeIds.length} changes as processed (success: ${success}) using TypeORM`);
    console.log(`Change IDs to process: ${changeIds.join(', ')}`);

    try {
      const oldCount = this.pendingChangesCount; // Store old count for logging
      const localChangesRepo = this.dataSource.manager.getRepository(LocalChanges);

      // 1. Filter the incoming changeIds to only include those that were actually sent
      const validSentChangeIds = changeIds.filter(id => this.sentChanges.has(id));

      if (validSentChangeIds.length === 0) {
        console.warn('No changes found in sentChanges map matching the provided IDs. Cannot mark as processed.');
        return;
      }

      console.log(`Found ${validSentChangeIds.length} changes in sentChanges map to potentially update.`);

      // 2. Update the entities in the database
      // Use TypeORM update method for efficiency
      const updateResult = await localChangesRepo.update(
        { id: In(validSentChangeIds) }, // Condition: IDs must be in the valid list
        { 
          processedSync: success ? 1 : 0, // Use 1 for success, 0 for failure (or keep 0 if timed out/failed)
          updatedAt: new Date() 
        }
      );
      
      console.log(`TypeORM update result: ${updateResult.affected ?? 0} rows affected.`);

      // 3. Clean up internal state (sentChanges, changeQueue)
      validSentChangeIds.forEach(id => {
        this.sentChanges.delete(id);
        this.changeQueue.delete(id);
      });

      // 4. Recalculate pending changes count
      const newCount = await localChangesRepo.count({ where: { processedSync: 0 } });
      console.log(`Before update: ${oldCount} pending changes, After update: ${newCount} pending changes (TypeORM)`);

      this.pendingChangesCount = newCount;

      // 5. Update SyncManager (debounced)
      this.debouncedUpdatePendingChangesCount();
      // Optionally force immediate UI update if needed
      // this.syncManager.updatePendingChangesCount(newCount);

      console.log(`Marked ${validSentChangeIds.length} changes as processed, pending count: ${newCount}`);

    } catch (error) {
      console.error('SyncChangeManager: Error marking changes as processed using TypeORM:', error);
      // Consider how to handle errors - should we retry? Re-queue?
      throw error; // Re-throw for now
    }
  }
  
  /**
   * Handle connection state change
   */
  private handleConnectionStateChange(state: string): void {
    // Only process changes when state becomes 'live'
    if (state === 'live') {
      console.log(`Connection state changed to ${state}, checking for unprocessed changes`);
      // Use a small delay to avoid excessive database calls during rapid state changes
      setTimeout(() => {
        // Only proceed if we're still in live state after the timeout
        if (this.syncManager.getState() === 'live') {
      this.loadUnprocessedChanges().then(() => {
        if (this.changeQueue.size > 0) {
          console.log(`Found ${this.changeQueue.size} changes to process after state change to live`);
          this.scheduleProcessing();
        }
      }).catch(error => {
        console.error('Error loading unprocessed changes after state change:', error);
      });
        }
      }, 500); // 500ms delay to avoid excessive calls
    }
  }
  
  /**
   * Handle WebSocket open
   */
  private handleWebSocketOpen(): void {
    // Process any queued changes on reconnection if in live state
    if (this.syncManager.getState() === 'live') {
      console.log(`WebSocket connected in live state, checking for unprocessed changes`);
      // Small delay to avoid excessive database access during connection events
      setTimeout(() => {
        // Only proceed if we're still connected and in live state
        if (this.syncManager.isConnected() && this.syncManager.getState() === 'live') {
      this.loadUnprocessedChanges().then(() => {
        if (this.changeQueue.size > 0) {
          console.log(`Found ${this.changeQueue.size} changes to process after WebSocket connected`);
          this.scheduleProcessing();
        }
      }).catch(error => {
        console.error('Error loading unprocessed changes after WebSocket connected:', error);
      });
        }
      }, 500); // 500ms delay to avoid excessive calls
    }
  }
  
  /**
   * Load unprocessed changes from database using TypeORM
   */
  private async loadUnprocessedChanges(): Promise<void> {
    if (!this.dataSource) {
      console.error("SyncChangeManager: Cannot load unprocessed changes, DataSource not initialized.");
      // Optionally trigger re-initialization
      // setTimeout(() => this.initializeDataSourceAndLoadChanges(), 1000);
      return;
    }

    try {
      const localChangesRepo = this.dataSource.manager.getRepository(LocalChanges);

      // Query unprocessed changes using TypeORM
      const unprocessedChanges = await localChangesRepo.find({
        where: { processedSync: 0 },
        select: ['id'] // Only select the ID, as that's all we need here
      });

      // Add the change IDs to the queue
      unprocessedChanges.forEach((change) => {
        this.changeQueue.add(change.id);
      });

      console.log(`Loaded ${unprocessedChanges.length} unprocessed change IDs from database (TypeORM)`);

      // Update the count if different
      const newCount = unprocessedChanges.length; // We just fetched them, count is accurate
      if (this.pendingChangesCount !== newCount) {
        this.pendingChangesCount = newCount;
        this.debouncedUpdatePendingChangesCount();
        // Optionally force immediate UI update
        // this.syncManager.updatePendingChangesCount(newCount);
      }

    } catch (error) {
      console.error('SyncChangeManager: Failed to load unprocessed changes using TypeORM:', error);
      // Maybe set count to 0 or leave as is on error?
      // this.pendingChangesCount = 0;
      // this.syncManager.updatePendingChangesCount(0);
    }
  }
  
  /**
   * Get the client ID from the sync manager
   */
  public getClientId(): string {
    // Use the cached instance instead of calling getInstance() again
    return this.syncManager.getClientId();
  }
  
  /**
   * Process all queued changes - public method that can be called to force processing
   */
  public async processQueuedChanges(): Promise<void> {
    console.log('[SyncChangeManager] Manually triggered change processing');
    
    // Check connection status first
    if (!this.syncManager.isConnected()) {
      console.log('[SyncChangeManager] Cannot process changes - not connected');
      throw new Error('Cannot process changes - not connected to server');
    }
    
    // Load any unprocessed changes from database to ensure we process everything
    await this.loadUnprocessedChanges();
    
    // If already processing, wait for it to complete
    if (this.isProcessing) {
      console.log('[SyncChangeManager] Already processing changes, waiting for current batch to complete');
      // Return a promise that resolves when current processing is done
      return new Promise(resolve => {
        const checkDone = () => {
          if (!this.isProcessing) {
            // Process the next batch immediately
            this.processChanges()
              .then(resolve)
              .catch(resolve); // Resolve even on error to avoid hanging
          } else {
            // Check again in 100ms
            setTimeout(checkDone, 100);
          }
        };
        // Start checking
        checkDone();
      });
    }
    
    // Trigger processing immediately
    return this.processChanges();
  }
  
  /**
   * Format value for SQL
   * Handles different field types based on entity schemas
   */
  private formatValueForSQL(column: string, value: any, table: string): string {
    // Handle null values first
    if (value === null || value === undefined) {
      return 'NULL';
    }
    
    // Special handling for task-specific fields
    if (table === 'tasks') {
      // Handle enum types for status
      if (column === 'status' && typeof value === 'string') {
        // Ensure the status value is a valid enum value
        const validStatuses = Object.values(TaskStatus);
        if (validStatuses.includes(value as TaskStatus)) {
          // For enum types in PostgreSQL, we need to use proper enum syntax
          return `'${value}'::task_status`;
        }
      }
      
      // Handle enum types for priority
      if (column === 'priority' && typeof value === 'string') {
        const validPriorities = Object.values(TaskPriority);
        if (validPriorities.includes(value as TaskPriority)) {
          return `'${value}'::task_priority`;
        }
      }
      
      // Handle date fields that may be stored as timestamps
      if (column === 'dueDate' || column === 'due_date' || column === 'completedAt' || column === 'completed_at') {
        // If it's already a string in ISO format, use it directly
        if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}T/)) {
          return `'${value}'::timestamptz`;
        }
        // If it's a Date object, convert to ISO
        if (value instanceof Date) {
          return `'${value.toISOString()}'::timestamptz`;
        }
      }
      
      // Handle special PostgreSQL types
      if (column === 'timeRange' || column === 'time_range') {
        // For tsrange, the format is typically '["2023-01-01 00:00:00","2023-01-02 00:00:00"]'
        if (typeof value === 'string') {
          return `'${value}'::tsrange`;
        }
        // If it's already formatted correctly as an object with from/to
        if (typeof value === 'object' && value.from && value.to) {
          const from = value.from instanceof Date ? value.from.toISOString() : value.from;
          const to = value.to instanceof Date ? value.to.toISOString() : value.to;
          return `'["${from}","${to}"]'::tsrange`;
        }
      }
      
      // Handle interval type
      if (column === 'estimatedDuration' || column === 'estimated_duration') {
        if (typeof value === 'string') {
          // Ensure proper interval format
          return `'${value}'::interval`;
        }
      }
      
      // Handle array types
      if (column === 'tags' && Array.isArray(value)) {
        // Convert array to PostgreSQL array syntax
        const arrayStr = value.map(item => `"${String(item).replace(/"/g, '\\"')}"`).join(',');
        return `ARRAY[${arrayStr}]::text[]`;
      }
    }
    
    // Generic type handling for all tables
    
    // Strings - handle escaping single quotes
    if (typeof value === 'string') {
      // Double up single quotes to escape them in SQL
      return `'${value.replace(/'/g, "''")}'`;
    }
    
    // Dates - convert to ISO format
    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }
    
    // Booleans - convert to SQL boolean literals
    if (typeof value === 'boolean') {
      return value ? 'TRUE' : 'FALSE';
    }
    
    // Numbers - use as is
    if (typeof value === 'number') {
      return value.toString();
    }
    
    // JSON objects - stringify and escape for SQL
    if (typeof value === 'object') {
      return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
    }
    
    // Default - convert to string
    return `'${String(value).replace(/'/g, "''")}'`;
  }
  
  /**
   * Initialize event listeners
   */
  private initializeEventListeners(): void {
    // Listen for connection events to process queued changes
    this.syncManager.on('stateChange', this.handleConnectionStateChange.bind(this));
    this.syncManager.on('websocket:open', this.handleWebSocketOpen.bind(this));
    
    // Register handlers for server acknowledgments
    this.syncManager.on('srv_changes_received', this.handleChangesReceived.bind(this));
    this.syncManager.on('srv_changes_applied', this.handleChangesApplied.bind(this));
    this.syncManager.on('srv_error', this.handleServerError.bind(this));
    
    // Register handler for processing changes (new callback pattern)
    this.syncManager.on('process_changes', this.handleProcessChanges.bind(this));
    
    // Register handler for explicit processing of all unprocessed changes
    this.syncManager.on('process_all_changes', (event: any) => {
      console.log(`[SyncChangeManager] Received process_all_changes event from: ${event.type}`);
      this.loadUnprocessedChanges().then(() => {
        if (this.changeQueue.size > 0) {
          console.log(`[SyncChangeManager] Processing ${this.changeQueue.size} changes after explicit request`);
          this.scheduleProcessing();
        } else {
          console.log('[SyncChangeManager] No changes to process after explicit request');
        }
      }).catch(error => {
        console.error('[SyncChangeManager] Error loading unprocessed changes:', error);
      });
    });
    
    // Set up periodic check for sent changes that weren't acknowledged
    setInterval(this.checkSentChanges.bind(this), 5000);
  }

  /**
   * Recursively convert object keys from camelCase to snake_case
   * This is needed for server API compatibility
   */
  private convertKeysToSnakeCase(obj: any): any {
    // Simplified version - replace with full implementation if needed
    const convert = (str: string) => str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    
    if (!obj || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return obj.toISOString();
    if (Array.isArray(obj)) return obj.map(item => this.convertKeysToSnakeCase(item));
    
    const result: Record<string, any> = {};
    Object.entries(obj).forEach(([key, value]) => {
      result[convert(key)] = this.convertKeysToSnakeCase(value);
    });
    
    return result;
  }

  /**
   * Processes incoming changes from the server using TypeORM transactions.
   */
  public async processIncomingChanges(changes: TableChange[]): Promise<boolean> {
    if (!this.dataSource) {
      console.error("SyncChangeManager: Cannot process incoming changes, DataSource not initialized.");
      return false;
    }
    if (changes.length === 0) {
      console.log("SyncChangeManager: No incoming changes to process.");
      return true; // Nothing to do, considered success
    }

    console.log(`SyncChangeManager: Processing ${changes.length} incoming changes from server (TypeORM)`);

    // Group changes by table and operation for ordered processing within transaction
    const changesByTable: Record<string, { 
        inserts: ObjectLiteral[], 
        updates: ObjectLiteral[], 
        deletes: string[] 
    }> = {};

    for (const change of changes) {
        // Validate table name using the new method
        if (!this.isValidTable(change.table)) {
            console.warn(`[Validation] Skipping incoming change for unknown or invalid table: ${change.table}`);
            continue; // Skip this change
        }

        if (!changesByTable[change.table]) {
            changesByTable[change.table] = { inserts: [], updates: [], deletes: [] };
        }

        // Ensure data exists before further checks
        if (!change.data) {
            console.warn(`[Validation] Skipping incoming ${change.operation} on table ${change.table} due to missing data field.`);
            continue;
        }

        // Ensure data has an ID for updates/deletes
        if ((change.operation === 'update' || change.operation === 'delete') && !change.data.id) {
             console.warn(`[Validation] Skipping incoming ${change.operation} on table ${change.table} due to missing ID in data:`, JSON.stringify(change.data));
             continue;
        }

        // Add specific validation for non-nullable fields (like for comments)
        if (change.table === 'comments') {
            // Validate based on snake_case keys from incoming data
            if (!change.data.id || !change.data.content || !change.data.entity_type) {
                console.warn(
                    `[Validation] Skipping comment ${change.operation} due to missing required fields (id, content, or entity_type). Data:`,
                    JSON.stringify(change.data)
                );
                continue; // Skip this invalid comment record
            }
        }
        
        // Get repository using the *default* entity manager (outside transaction scope)
        // We need this to call repository.create()
        const repository = this.getEntityRepository(this.dataSource!.manager, change.table);
        if (!repository) { // Should not happen due to isValidTable check, but safe guard
            console.error(`[Error] Could not get repository for valid table: ${change.table}`);
            continue;
        }

        // Map and Create Entity Instance
        let entityInstance: ObjectLiteral;
        if (change.table === 'comments') {
            const mappedData = this.mapIncomingDataToEntityProperties(change.data);
            // Use repository.create to ensure it's a proper entity instance
            entityInstance = repository.create(mappedData);
        } else {
            // For other tables, assume direct data or simple create for now
            // TODO: Apply mapping if needed for other tables
            entityInstance = repository.create(change.data as ObjectLiteral);
        }

        // Add the *entity instance* to the correct list
        switch (change.operation) {
            case 'insert':
                changesByTable[change.table].inserts.push(entityInstance);
                break;
            case 'update':
                changesByTable[change.table].updates.push(entityInstance);
                break;
            case 'delete':
                // Delete still only needs the ID
                changesByTable[change.table].deletes.push(change.data.id as string);
                break;
            default:
                console.warn(`Ignoring incoming change with unknown operation: ${change.operation}`);
        }
    }

    // Process changes within a transaction
    try {
      await this.dataSource.manager.transaction(async (transactionalEntityManager: EntityManager) => {
        console.log('Starting TypeORM transaction for incoming changes.');
        
        // Process Deletes first across all tables 
        for (const tableName of Object.keys(changesByTable)) {
            const { deletes } = changesByTable[tableName];
            if (deletes.length > 0) {
                console.log(`Deleting ${deletes.length} record(s) from ${tableName}`);
                const transactionalRepo = this.getEntityRepository(transactionalEntityManager, tableName);
                await transactionalRepo.delete({ id: In(deletes) });
            }
        }
        
        // Process Inserts/Updates table by table using the created entity instances
        for (const tableName of Object.keys(changesByTable)) {
          const { inserts, updates } = changesByTable[tableName];
          
          if (tableName === 'comments') {
            // Use the dedicated helper function for comments
            await this._processCommentChanges(
              transactionalEntityManager,
              inserts as Comment[],
              updates as Comment[]
            );
          } else {
            // Standard handling for other tables (combine inserts/updates)
            const transactionalRepo = this.getEntityRepository(transactionalEntityManager, tableName);
            const recordsToSave = [...inserts, ...updates]; 
            if (recordsToSave.length > 0) {
              console.log(`Saving (insert/update) ${recordsToSave.length} record(s) to ${tableName}`);
              // console.log(`[DEBUG SAVE - Standard] Table: ${tableName}, Data:`, JSON.stringify(recordsToSave, null, 2));
              // Wrap in try-catch for better error reporting
              try {
                 await transactionalRepo.save(recordsToSave, { chunk: INCOMING_BATCH_SIZE });
              } catch (error) {
                 console.error(`[${tableName}] Error saving records:`, error);
                 console.error(`[${tableName}] Records data:`, JSON.stringify(recordsToSave, null, 2));
                 throw error;
              }
            }
          }
        }
        console.log('Committed TypeORM transaction for incoming changes.');
      });
      return true; // Transaction successful
    } catch (error) {
      console.error('SyncChangeManager: Error processing incoming changes within TypeORM transaction:', error);
      return false; // Transaction failed
    }
  }

  /**
   * Handle process_changes event from SyncManager
   */
  private handleProcessChanges(event: { type: string; changes: TableChange[]; callback: (success: boolean) => void }): void {
    const { type, changes, callback } = event;
    
    console.log(`[SyncChangeManager] 🛠️ Starting handleProcessChanges for ${type} with ${changes?.length} changes`);
    
    if (!changes || !Array.isArray(changes)) {
      console.warn(`[SyncChangeManager] ⚠️ Received invalid changes event without changes array`);
      console.log(`[SyncChangeManager] 📞 Calling callback with failure (false) due to invalid changes`);
      if (callback && typeof callback === 'function') callback(false); // Call callback if provided
      return;
    }
    
    console.log(`[SyncChangeManager] 📥 Processing ${changes.length} changes (${type})`);
    
    // Record start time for performance logging
    const startTime = Date.now();
    
    // Process the changes
    this.processIncomingChanges(changes)
      .then((success: boolean) => {
        const processingTime = Date.now() - startTime;
        
        if (success) {
          console.log(`[SyncChangeManager] ✅ Processed ${changes.length} changes (${type}) in ${processingTime}ms`);
          
          // Emit event for visualization
          this.events.emit('incoming_changes_processed', { 
            success: true, 
            count: changes.length,
            type
          });
          
          // Call the callback with success
          console.log(`[SyncChangeManager] 📞 Calling callback with success (true)`);
          if (callback && typeof callback === 'function') callback(true);
        } else {
          console.error(`[SyncChangeManager] ❌ Failed to process some changes from ${type} (took ${processingTime}ms)`);
          
          // Emit event for error visualization
          this.events.emit('incoming_changes_processed', { 
            success: false, 
            error: `Failed to process some changes from ${type}`,
            count: changes.length,
            type
          });
          
          // Call the callback with failure
          console.log(`[SyncChangeManager] 📞 Calling callback with failure (false) due to processing failure`);
          if (callback && typeof callback === 'function') callback(false);
        }
      })
      .catch((error: Error) => {
        const processingTime = Date.now() - startTime;
        console.error(`[SyncChangeManager] ❌ Error handling ${type} changes (took ${processingTime}ms):`, error);
        
        // Emit event for error visualization
        this.events.emit('incoming_changes_processed', { 
          success: false, 
          error: error instanceof Error ? error.message : `Error processing ${type} changes`,
          count: changes.length,
          type
        });
        
        // Call the callback with failure
        console.log(`[SyncChangeManager] 📞 Calling callback with failure (false) due to error`);
        if (callback && typeof callback === 'function') callback(false);
      });
  }

  /**
   * Helper to get the TypeORM Entity TABLE NAME based on a conceptual table name string.
   * Returns null if the conceptual name is unknown.
   */
  private getEntityTableName(conceptualTableName: string): string | null {
    // Use a mapping to ensure consistency, especially if entity class names
    // don't directly match conceptual table names used elsewhere.
    switch (conceptualTableName) {
      case 'tasks': return 'task'; // Assuming TypeORM entity is singular 'Task' mapped to 'task' table
      case 'projects': return 'project'; // Assuming TypeORM entity is singular 'Project' mapped to 'project' table
      case 'users': return 'user'; // Assuming TypeORM entity is singular 'User' mapped to 'user' table
      case 'comments': return 'comment'; // Assuming TypeORM entity is singular 'Comment' mapped to 'comment' table
      // Add other mappings as needed, ensuring the returned string matches the TypeORM table name
      default:
        console.warn(`SyncChangeManager: Unknown conceptual table name '${conceptualTableName}' encountered.`);
        return null;
    }
  }

  /**
   * Helper to get a repository instance for a given conceptual table name.
   * Uses the provided EntityManager (either default or transactional).
   */
  private getEntityRepository(manager: EntityManager, conceptualTableName: string) {
    // Map conceptual table names to actual Entity classes
    let entityClass: EntityTarget<any> | null = null;
    switch (conceptualTableName) {
      case 'tasks':
        entityClass = Task;
        break;
      case 'projects':
        entityClass = Project;
        break;
      case 'users':
        entityClass = User;
        break;
      case 'comments':
        entityClass = Comment;
        break;
      // Add cases for other entities managed by SyncChangeManager if any
      default:
        console.error(`SyncChangeManager: Unknown conceptual table name '${conceptualTableName}' encountered in getEntityRepository.`);
        throw new Error(`No repository found for conceptual table name: ${conceptualTableName}`);
    }

    // Pass the Entity class to getRepository
    return manager.getRepository(entityClass);
  }

  /**
   * Check if a table name corresponds to a known TypeORM entity.
   */
  private isValidTable(tableName: string): boolean {
    // Add null check for dataSource first
    if (!this.dataSource) {
        console.warn("isValidTable: Cannot check table validity, DataSource not initialized.");
        return false; 
    }
    
    // Use mapping defined in getEntityTableName
    return this.getEntityTableName(tableName) !== null;
  }
  
  /**
   * Get the number of queued or pending changes
   */
  public getQueueSize(): number {
    return this.pendingChangesCount;
  }

  /**
   * Register an event listener
   */
  public on(event: string, listener: (...args: any[]) => void): void {
    this.events.on(event, listener);
  }

  /**
   * Remove an event listener
   */
  public off(event: string, listener: (...args: any[]) => void): void {
    this.events.off(event, listener);
  }

  /**
   * Maps incoming data (potentially snake_case) to camelCase entity properties.
   * Specifically handles fields for the Comment entity.
   */
  private mapIncomingDataToEntityProperties(data: Record<string, unknown>): Partial<Comment> {
    return {
      id: data.id as string,
      content: data.content as string,
      entityType: data.entity_type as string, // Map snake_case to camelCase
      entityId: data.entity_id as string | undefined, // Map snake_case to camelCase
      authorId: data.author_id as string | undefined, // Map snake_case to camelCase
      parentId: data.parent_id as string | undefined, // Map snake_case to camelCase
      createdAt: data.created_at ? new Date(data.created_at as string) : undefined, // Convert string to Date
      updatedAt: data.updated_at ? new Date(data.updated_at as string) : undefined, // Convert string to Date
      // Include other base fields if necessary and present in data
      clientId: data.client_id as string | undefined, 
    };
  }

  /**
   * Processes incoming comment changes, handling parent/child dependencies.
   * Saves updates first, then iteratively saves inserts based on parent readiness,
   * accounting for parents that may already exist in the database.
   */
  private async _processCommentChanges(
    transactionalEntityManager: EntityManager,
    inserts: Comment[],
    updates: Comment[]
  ): Promise<void> {
    const commentRepo = transactionalEntityManager.getRepository(Comment);

    // Pass 1: Apply Updates first
    if (updates.length > 0) {
      console.log(`[Comments] Pass 1: Saving ${updates.length} comment update(s)`);
       try {
          await commentRepo.save(updates, { chunk: INCOMING_BATCH_SIZE });
       } catch (error) {
          console.error("[Comments] Error saving comment updates:", error);
          console.error("[Comments] Updates data:", JSON.stringify(updates, null, 2));
          throw error; // Re-throw to fail the transaction
      }
    }

    // Pass 2: Iteratively Insert Comments
    if (inserts.length > 0) {
      console.log(`[Comments] Pass 2: Processing ${inserts.length} comment insert(s) iteratively.`);
      
      // Pre-fetch IDs of parents that might already exist in the DB
      const parentIdsToCheck = inserts
        .map(c => c.parentId)
        .filter((id): id is string => !!id); // Get all non-null parent IDs from the batch
      
      let existingParentIds = new Set<string>();
      if (parentIdsToCheck.length > 0) {
          try {
            console.log(`[Comments] Pre-checking existence for ${parentIdsToCheck.length} potential parent IDs.`);
            const existingParents = await commentRepo.find({
                where: { id: In(parentIdsToCheck) },
                select: ['id'] // Only need the ID
            });
            existingParentIds = new Set(existingParents.map(p => p.id));
            console.log(`[Comments] Found ${existingParentIds.size} existing parents in DB: ${[...existingParentIds].join(', ')}`);
          } catch (error) {
             console.error("[Comments] Error pre-fetching existing parent IDs:", error);
             throw error; // Fail transaction if pre-check fails
          }
      }

      const pendingInserts = new Map<string, Comment>(inserts.map(c => [c.id, c]));
      const savedInThisRun = new Set<string>();
      let batchNumber = 0;

      while (pendingInserts.size > 0) {
        batchNumber++;
        console.log(`[Comments] -- Iteration ${batchNumber} -- Pending: ${pendingInserts.size}, Saved IDs this run: ${[...savedInThisRun].join(', ') || 'None'}`);
        const batchToSave: Comment[] = [];

        // Find comments ready to be saved in this iteration
        for (const [id, comment] of pendingInserts.entries()) {
          // Check: No parent OR parent saved this run OR parent pre-existed in DB
          if (
              !comment.parentId || 
              savedInThisRun.has(comment.parentId) || 
              existingParentIds.has(comment.parentId)
             ) 
          {
            batchToSave.push(comment);
          }
        }

        // If no comments can be saved, it means there's a missing parent or cycle
        if (batchToSave.length === 0) {
          const remainingIds = Array.from(pendingInserts.keys());
          const remainingData = Array.from(pendingInserts.values());
          console.warn(`[Comments] Skipping ${remainingIds.length} comment inserts due to unresolved dependencies (parent might be missing from DB/batch, or circular dependency).`);
          console.warn("[Comments] Skipped insert IDs:", remainingIds);
          console.warn("[Comments] Skipped insert ParentIDs:", 
            JSON.stringify(remainingData.map(c => ({id: c.id, parentId: c.parentId})), null, 2)
          );
          break; 
        }

        // Attempt to save the batch
        console.log(`[Comments] Pass 2, Iteration ${batchNumber}: Attempting to save ${batchToSave.length} comment(s)`);
        try {
            await commentRepo.save(batchToSave, { chunk: INCOMING_BATCH_SIZE });
            // If successful, update pending and saved sets
            for (const savedComment of batchToSave) {
                pendingInserts.delete(savedComment.id);
                savedInThisRun.add(savedComment.id);
            }
            console.log(`[Comments] Pass 2, Iteration ${batchNumber}: Successfully saved ${batchToSave.length}. Remaining: ${pendingInserts.size}`);
        } catch (error) {
            console.error(`[Comments] Error saving insert batch ${batchNumber}:`, error);
            console.error(`[Comments] Batch ${batchNumber} data:`, JSON.stringify(batchToSave, null, 2));
            throw error; // Re-throw to fail the transaction
        }
      }
      console.log(`[Comments] Pass 2: Successfully inserted all ${inserts.length} comments.`);
    }
  }
} 