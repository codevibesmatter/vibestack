# Sync Worker Migration Plan

## Overview

This document outlines the plan for migrating the existing sync functionality from the traditional client-based implementation to the new worker-based implementation. The worker-based implementation offers improved performance, better reliability, and reduced main thread blocking.

## Current Architecture

The current sync system consists of several key components:

1. **SyncClient**: The main entry point for the sync system, coordinating connection management, state tracking, and operation queuing.
2. **ConnectionManager**: Handles WebSocket connections, reconnection logic, and network status monitoring.
3. **OperationQueue**: Manages a queue of operations that need to be executed when a connection is available.
4. **MessageHandler**: Processes incoming WebSocket messages and updates the application state.
5. **ChangeProcessor**: Processes changes received from the server and applies them to the local database.

## New Worker-Based Architecture

The new worker-based implementation consists of:

1. **WorkerSyncService**: A simplified interface for background synchronization using Web Workers.
2. **SyncWorkerManager**: Manages the sync worker and provides an interface for the main thread to communicate with the worker.
3. **SyncMessageHandler**: Handles sync messages received from the worker and processes them to update the database.
4. **SyncWorker**: A Web Worker that handles WebSocket connections and message processing in a separate thread.

## Migration Strategy

### Phase 1: Feature Parity Analysis

Before beginning the migration, we need to ensure that the worker-based implementation provides all the necessary functionality of the existing implementation:

| Feature | Current Implementation | Worker Implementation | Status |
|---------|------------------------|----------------------|--------|
| Connection Management | ConnectionManager | SyncWorkerManager + SyncWorker | Complete |
| Message Processing | MessageHandler | SyncMessageHandler | Complete |
| Operation Queuing | OperationQueue | Needs migration | Pending |
| Change Processing | ChangeProcessor | SyncMessageHandler | Complete |
| State Management | SyncState | LocalStorage + WorkerSyncService | Complete |
| Reconnection Logic | ReconnectionManager | SyncWorker | Complete |
| Network Status Monitoring | NetworkMonitor | WorkerSyncService | Complete |

### Phase 2: Implementation Migration

#### 1. Operation Queue Migration

The current `OperationQueue` functionality needs to be migrated to the worker-based implementation:

- Add an operation queue to the `WorkerSyncService` or `SyncWorkerManager`
- Implement methods to queue operations and process them when a connection is available
- Ensure operations can be executed in the worker context

##### Detailed Implementation Plan for Operation Queue

1. **Create a Worker-Compatible Operation Interface**:
   ```typescript
   // In apps/web/src/sync/worker/types.ts
   export interface WorkerSyncOperation {
     type: string;
     payload: any;
     id: string;
     priority?: number;
   }
   ```

2. **Add Operation Queue to WorkerSyncService**:
   ```typescript
   // In apps/web/src/sync/worker-sync-service.ts
   private operationQueue: WorkerSyncOperation[] = [];
   private processingQueue: boolean = false;
   
   /**
    * Queue an operation to be executed when a connection is available
    */
   public queueOperation(operation: WorkerSyncOperation): Promise<void> {
     return new Promise((resolve, reject) => {
       // Add resolve/reject callbacks to the operation
       const enhancedOperation = {
         ...operation,
         _resolve: resolve,
         _reject: reject
       };
       
       this.operationQueue.push(enhancedOperation);
       
       // If connected, process the queue immediately
       if (this.isConnected()) {
         this.processOperationQueue();
       } else if (!syncWorkerManager.isConnecting()) {
         // If not connected and not connecting, try to connect
         this.connect().catch(err => {
           console.error('Failed to connect for queued operation', err);
         });
       }
     });
   }
   
   /**
    * Process all operations in the queue
    */
   private processOperationQueue(): void {
     if (this.processingQueue || this.operationQueue.length === 0) {
       return;
     }
     
     this.processingQueue = true;
     
     try {
       console.log(`Processing ${this.operationQueue.length} queued operations`);
       
       // Process all operations in the queue
       while (this.operationQueue.length > 0) {
         const operation = this.operationQueue.shift();
         if (!operation) continue;
         
         try {
           // Execute the operation
           if (this.isConnected()) {
             // Send the operation to the worker
             const success = syncWorkerManager.sendMessage({
               type: 'operation',
               operation: {
                 type: operation.type,
                 payload: operation.payload,
                 id: operation.id
               }
             });
             
             if (success && operation._resolve) {
               operation._resolve();
             } else if (!success && operation._reject) {
               operation._reject(new Error('Failed to send operation to worker'));
             }
           } else {
             throw new Error('Not connected to sync server');
           }
         } catch (err) {
           console.error('Failed to execute queued operation', err);
           
           // Reject the promise if it exists
           if (operation._reject) {
             operation._reject(err instanceof Error ? err : new Error(String(err)));
           }
         }
       }
     } finally {
       this.processingQueue = false;
     }
   }
   
   /**
    * Clear all operations in the queue
    */
   public clearOperationQueue(): void {
     // Reject all pending operations
     for (const operation of this.operationQueue) {
       if (operation._reject) {
         operation._reject(new Error('Operation cancelled due to client cleanup'));
       }
     }
     
     this.operationQueue = [];
   }
   ```

3. **Update SyncWorker to Handle Operations**:
   ```typescript
   // In apps/web/src/sync/worker/sync-worker.ts
   // Add to the message handler
   case 'operation':
     handleOperation(payload.operation);
     break;
   
   /**
    * Handle an operation from the main thread
    */
   function handleOperation(operation: any): void {
     if (!state.isConnected || !ws || ws.readyState !== WebSocket.OPEN) {
       sendError(`Cannot execute operation - not connected to sync server`);
       return;
     }
     
     try {
       // Execute the operation based on its type
       switch (operation.type) {
         case 'send_message':
           sendToServer(operation.payload);
           break;
           
         // Add other operation types as needed
         
         default:
           sendError(`Unknown operation type: ${operation.type}`);
           break;
       }
       
       // Notify main thread of successful execution
       sendToMain('operation_complete', {
         id: operation.id,
         success: true
       });
     } catch (error: any) {
       sendError(`Error executing operation: ${error.message}`);
       
       // Notify main thread of failed execution
       sendToMain('operation_error', {
         id: operation.id,
         error: error.message
       });
     }
   }
   ```

4. **Add Operation Result Handling to SyncWorkerManager**:
   ```typescript
   // In apps/web/src/sync/worker/sync-worker-manager.ts
   // Add to the handleWorkerMessage method
   case 'operation_complete':
     this.emit('operation_complete', payload);
     break;
     
   case 'operation_error':
     this.emit('operation_error', payload);
     break;
   ```

5. **Update WorkerSyncService to Listen for Operation Results**:
   ```typescript
   // In apps/web/src/sync/worker-sync-service.ts
   // Add to the setupWorkerEventListeners method
   syncWorkerManager.on('operation_complete', (data) => {
     console.log('Operation completed successfully', data);
     // Could add additional handling here if needed
   });
   
   syncWorkerManager.on('operation_error', (data) => {
     console.error('Operation failed', data);
     // Could add additional handling here if needed
   });
   ```

#### 2. Global Connection Tracking

The current implementation uses a global connection tracker to prevent multiple connections with the same client ID:

- Implement similar functionality in the worker-based implementation
- Use `localStorage` or a similar mechanism to track connection attempts across tabs

##### Detailed Implementation Plan for Global Connection Tracking

1. **Create a Global Connection Tracker Class**:
   ```typescript
   // In apps/web/src/sync/worker/global-connection-tracker.ts
   
   /**
    * GlobalConnectionTracker
    * 
    * Tracks connection attempts and active connections across browser tabs
    * using localStorage for cross-tab communication.
    */
   export class GlobalConnectionTracker {
     private static readonly CONNECTION_KEY = 'sync_connection_status';
     private static readonly ATTEMPT_KEY = 'sync_connection_attempt';
     private static readonly LAST_UPDATED_KEY = 'sync_connection_last_updated';
     private static readonly CLEANUP_INTERVAL = 30000; // 30 seconds
     
     private cleanupInterval: number | null = null;
     
     constructor() {
       // Set up storage event listener for cross-tab communication
       window.addEventListener('storage', this.handleStorageEvent);
       
       // Start cleanup interval
       this.cleanupInterval = window.setInterval(
         this.cleanupStaleConnections,
         GlobalConnectionTracker.CLEANUP_INTERVAL
       );
     }
     
     /**
      * Check if a client ID is already connected
      */
     public isClientConnected(clientId: string): boolean {
       const connectionData = this.getConnectionData();
       return connectionData.connectedClients.includes(clientId);
     }
     
     /**
      * Check if a connection attempt is in progress for a client ID
      */
     public isAttemptingConnection(clientId: string): boolean {
       const attemptData = this.getAttemptData();
       return attemptData.attemptingClients.includes(clientId);
     }
     
     /**
      * Start a connection attempt for a client ID
      * @returns A cleanup function to call when the attempt is complete
      */
     public startConnectionAttempt(clientId: string): () => void {
       const attemptData = this.getAttemptData();
       
       // Add client ID to attempting clients if not already there
       if (!attemptData.attemptingClients.includes(clientId)) {
         attemptData.attemptingClients.push(clientId);
         this.saveAttemptData(attemptData);
       }
       
       // Return cleanup function
       return () => {
         this.endConnectionAttempt(clientId);
       };
     }
     
     /**
      * End a connection attempt for a client ID
      */
     public endConnectionAttempt(clientId: string): void {
       const attemptData = this.getAttemptData();
       
       // Remove client ID from attempting clients
       attemptData.attemptingClients = attemptData.attemptingClients.filter(
         id => id !== clientId
       );
       
       this.saveAttemptData(attemptData);
     }
     
     /**
      * Register a successful connection for a client ID
      */
     public registerConnection(clientId: string): void {
       const connectionData = this.getConnectionData();
       
       // Add client ID to connected clients if not already there
       if (!connectionData.connectedClients.includes(clientId)) {
         connectionData.connectedClients.push(clientId);
         connectionData.lastUpdated = Date.now();
         this.saveConnectionData(connectionData);
       }
       
       // End the connection attempt
       this.endConnectionAttempt(clientId);
     }
     
     /**
      * Close a connection for a client ID
      */
     public closeConnection(clientId: string): void {
       const connectionData = this.getConnectionData();
       
       // Remove client ID from connected clients
       connectionData.connectedClients = connectionData.connectedClients.filter(
         id => id !== clientId
       );
       
       connectionData.lastUpdated = Date.now();
       this.saveConnectionData(connectionData);
     }
     
     /**
      * Wait for an existing connection attempt to complete
      * @returns Promise that resolves when the attempt is complete
      */
     public async waitForExistingAttempt(clientId: string): Promise<void> {
       // If not attempting, resolve immediately
       if (!this.isAttemptingConnection(clientId)) {
         return;
       }
       
       // Wait for the attempt to complete
       return new Promise<void>((resolve) => {
         const checkInterval = setInterval(() => {
           if (!this.isAttemptingConnection(clientId)) {
             clearInterval(checkInterval);
             resolve();
           }
         }, 100);
         
         // Set a timeout to prevent waiting forever
         setTimeout(() => {
           clearInterval(checkInterval);
           resolve();
         }, 5000);
       });
     }
     
     /**
      * Clean up resources used by the tracker
      */
     public cleanup(): void {
       // Remove event listener
       window.removeEventListener('storage', this.handleStorageEvent);
       
       // Clear cleanup interval
       if (this.cleanupInterval !== null) {
         clearInterval(this.cleanupInterval);
         this.cleanupInterval = null;
       }
     }
     
     /**
      * Handle storage events for cross-tab communication
      */
     private handleStorageEvent = (event: StorageEvent): void => {
       // Only handle events for our keys
       if (
         event.key === GlobalConnectionTracker.CONNECTION_KEY ||
         event.key === GlobalConnectionTracker.ATTEMPT_KEY
       ) {
         // Could add additional handling here if needed
       }
     };
     
     /**
      * Clean up stale connections
      */
     private cleanupStaleConnections = (): void => {
       const connectionData = this.getConnectionData();
       const now = Date.now();
       
       // If last updated more than 2 minutes ago, consider connections stale
       if (now - connectionData.lastUpdated > 120000) {
         connectionData.connectedClients = [];
         connectionData.lastUpdated = now;
         this.saveConnectionData(connectionData);
       }
     };
     
     /**
      * Get connection data from localStorage
      */
     private getConnectionData(): { connectedClients: string[]; lastUpdated: number } {
       const data = localStorage.getItem(GlobalConnectionTracker.CONNECTION_KEY);
       
       if (data) {
         try {
           return JSON.parse(data);
         } catch (err) {
           console.error('Error parsing connection data', err);
         }
       }
       
       // Default data
       return {
         connectedClients: [],
         lastUpdated: Date.now()
       };
     }
     
     /**
      * Save connection data to localStorage
      */
     private saveConnectionData(data: { connectedClients: string[]; lastUpdated: number }): void {
       localStorage.setItem(
         GlobalConnectionTracker.CONNECTION_KEY,
         JSON.stringify(data)
       );
     }
     
     /**
      * Get attempt data from localStorage
      */
     private getAttemptData(): { attemptingClients: string[] } {
       const data = localStorage.getItem(GlobalConnectionTracker.ATTEMPT_KEY);
       
       if (data) {
         try {
           return JSON.parse(data);
         } catch (err) {
           console.error('Error parsing attempt data', err);
         }
       }
       
       // Default data
       return {
         attemptingClients: []
       };
     }
     
     /**
      * Save attempt data to localStorage
      */
     private saveAttemptData(data: { attemptingClients: string[] }): void {
       localStorage.setItem(
         GlobalConnectionTracker.ATTEMPT_KEY,
         JSON.stringify(data)
       );
     }
   }
   
   // Export singleton instance
   export const globalConnectionTracker = new GlobalConnectionTracker();
   ```

2. **Integrate with WorkerSyncService**:
   ```typescript
   // In apps/web/src/sync/worker-sync-service.ts
   
   import { globalConnectionTracker } from './worker/global-connection-tracker';
   
   // In the connect method
   public async connect(): Promise<boolean> {
     if (!this.isInitialized) {
       console.error('Cannot connect - WorkerSyncService not initialized');
       this.emitEvent('error', { message: 'Cannot connect - WorkerSyncService not initialized' });
       return false;
     }
     
     // Check if this client ID is already connected globally
     if (globalConnectionTracker.isClientConnected(this.clientId)) {
       console.warn('Client ID already connected globally, aborting connection attempt');
       return false;
     }
     
     // Check if there's already a global connection attempt for this client ID
     if (globalConnectionTracker.isAttemptingConnection(this.clientId)) {
       console.warn('Connection attempt already in progress for this client ID, waiting...');
       
       // Wait for the existing connection attempt to complete
       await globalConnectionTracker.waitForExistingAttempt(this.clientId);
       
       // After waiting, check if we're now connected
       if (this.isConnected()) {
         return true;
       }
     }
     
     // Register this connection attempt with the global tracker
     const cleanup = globalConnectionTracker.startConnectionAttempt(this.clientId);
     
     try {
       // Validate WebSocket URL
       try {
         new URL('/api/sync', config.wsUrl);
       } catch (error: any) {
         console.error('Invalid WebSocket URL', error);
         this.emitEvent('error', { message: `Invalid WebSocket URL: ${error.message}` });
         return false;
       }
       
       console.log('Connecting to sync server', {
         clientId: this.clientId,
         lastLSN: this.lastLSN,
         wsUrl: config.wsUrl
       });
       
       // Connect using the worker manager
       const connected = await syncWorkerManager.connect(config.wsUrl, this.clientId, this.lastLSN);
       
       if (connected) {
         // Register successful connection
         globalConnectionTracker.registerConnection(this.clientId);
       }
       
       return connected;
     } catch (err) {
       console.error('Connection attempt failed', err);
       return false;
     } finally {
       // Clean up the global tracker entry
       cleanup();
     }
   }
   
   // In the disconnect method
   public disconnect(graceful: boolean = true): boolean {
     if (!this.isInitialized) {
       return false;
     }
     
     console.log('Disconnecting from sync server', { graceful });
     const result = syncWorkerManager.disconnect(graceful);
     
     // Remove this client ID from the global tracker
     globalConnectionTracker.closeConnection(this.clientId);
     
     return result;
   }
   
   // In the cleanup method
   public cleanup(): void {
     if (!this.isInitialized) {
       return;
     }
     
     console.log('Cleaning up WorkerSyncService');
     
     // Disconnect from the server
     this.disconnect(false);
     
     // Remove network status listener
     if (this.networkStatusListener) {
       window.removeEventListener('online', this.networkStatusListener);
       window.removeEventListener('offline', this.networkStatusListener);
       this.networkStatusListener = null;
     }
     
     // Clear event listeners
     this.eventListeners.clear();
     
     // Terminate the worker
     syncWorkerManager.terminate();
     
     // Clean up message handler if it has a cleanup method
     if (typeof syncMessageHandler.cleanup === 'function') {
       syncMessageHandler.cleanup();
     }
     
     // Remove this client ID from the global tracker
     globalConnectionTracker.closeConnection(this.clientId);
     
     this.isInitialized = false;
   }
   ```

#### 3. Change Processor Integration

The current change processor needs to be integrated with the worker-based implementation:

- Ensure the `SyncMessageHandler` can process all types of changes
- Implement batch processing for efficient database updates
- Maintain LSN tracking for synchronization state

##### Detailed Implementation Plan for Change Processor Integration

1. **Enhance SyncMessageHandler to Support All Change Types**:
   ```typescript
   // In apps/web/src/sync/worker/message-handler.ts
   
   // Add support for all change types
   export type SyncMessageType = 
     | 'sync_start'
     | 'sync_data'
     | 'sync_complete'
     | 'sync_error'
     | 'entity_update'
     | 'entity_delete'
     | 'batch_update'
     | 'sync_request'
     | 'changes';  // Add support for the 'changes' message type
   
   // Add a new method to handle the 'changes' message type
   /**
    * Handle changes message from server
    */
   private async handleChangesMessage(message: SyncMessage): Promise<void> {
     if (!this.db || !message.data || !Array.isArray(message.data.changes)) {
       console.error('Invalid changes message:', message);
       return;
     }
     
     const { changes, lsn } = message.data;
     
     try {
       // Process changes in a transaction for better performance
       await this.db.transaction(async (tx) => {
         for (const change of changes) {
           if (!change.type || !change.entityType || !change.entityId) {
             console.warn('Invalid change item:', change);
             continue;
           }
           
           if (change.type === 'update' && change.data) {
             await tx.upsertEntity(
               change.entityType,
               change.entityId,
               change.data,
               change.timestamp
             );
           } else if (change.type === 'delete') {
             await tx.deleteEntity(
               change.entityType,
               change.entityId,
               change.timestamp
             );
           }
         }
       });
       
       // Update LSN after successful processing
       if (lsn) {
         localStorage.setItem('sync_last_lsn', lsn);
       }
       
       console.log(`Processed ${changes.length} changes, new LSN: ${lsn}`);
     } catch (error: any) {
       console.error('Error processing changes:', error);
     }
   }
   
   // Update the handleSyncMessage method to handle the 'changes' message type
   private handleSyncMessage = async (message: SyncMessage): Promise<void> => {
     if (!this.isInitialized || !this.db) {
       // Queue message for later processing
       this.messageQueue.push(message);
       return;
     }
     
     try {
       switch (message.type) {
         // ... existing cases ...
         
         case 'changes':
           await this.handleChangesMessage(message);
           break;
           
         // ... other cases ...
       }
       
       // Update LSN if provided
       if (message.lsn) {
         localStorage.setItem('sync_last_lsn', message.lsn);
       }
     } catch (error: any) {
       console.error('Error processing sync message:', error, message);
     }
   };
   ```

2. **Add Batch Processing Support**:
   ```typescript
   // In apps/web/src/sync/worker/message-handler.ts
   
   /**
    * Process a batch of changes efficiently
    */
   private async processBatch(
     changes: Array<{
       type: 'update' | 'delete';
       entityType: string;
       entityId: string;
       data?: any;
       timestamp?: number;
     }>,
     tx: DatabaseTransaction
   ): Promise<void> {
     // Group changes by entity type for more efficient processing
     const changesByType: Record<string, typeof changes> = {};
     
     // Group changes
     for (const change of changes) {
       if (!changesByType[change.entityType]) {
         changesByType[change.entityType] = [];
       }
       changesByType[change.entityType].push(change);
     }
     
     // Process each entity type in sequence
     for (const [entityType, typeChanges] of Object.entries(changesByType)) {
       console.log(`Processing ${typeChanges.length} changes for ${entityType}`);
       
       // Process all changes for this entity type
       for (const change of typeChanges) {
         if (change.type === 'update' && change.data) {
           await tx.upsertEntity(
             change.entityType,
             change.entityId,
             change.data,
             change.timestamp
           );
         } else if (change.type === 'delete') {
           await tx.deleteEntity(
             change.entityType,
             change.entityId,
             change.timestamp
           );
         }
       }
     }
   }
   
   // Update the handleBatchUpdate method to use the new processBatch method
   private async handleBatchUpdate(message: SyncMessage): Promise<void> {
     if (!this.db || !message.data || !Array.isArray(message.data)) {
       console.error('Invalid batch update message:', message);
       return;
     }
     
     try {
       // Start a transaction
       await this.db.transaction(async (tx) => {
         await this.processBatch(message.data, tx);
       });
     } catch (error: any) {
       console.error(`Error processing batch update ${message.batchId}:`, error);
     }
   }
   
   // Update the handleChangesMessage method to use the new processBatch method
   private async handleChangesMessage(message: SyncMessage): Promise<void> {
     if (!this.db || !message.data || !Array.isArray(message.data.changes)) {
       console.error('Invalid changes message:', message);
       return;
     }
     
     const { changes, lsn } = message.data;
     
     try {
       // Process changes in a transaction for better performance
       await this.db.transaction(async (tx) => {
         await this.processBatch(changes, tx);
       });
       
       // Update LSN after successful processing
       if (lsn) {
         localStorage.setItem('sync_last_lsn', lsn);
       }
       
       console.log(`Processed ${changes.length} changes, new LSN: ${lsn}`);
     } catch (error: any) {
       console.error('Error processing changes:', error);
     }
   }
   ```

3. **Implement LSN Tracking and Management**:
   ```typescript
   // In apps/web/src/sync/worker-sync-service.ts
   
   /**
    * Update the last LSN
    */
   private updateLastLSN(lsn: string): void {
     if (!lsn) return;
     
     // Compare LSNs to ensure we only update to a newer LSN
     if (this.compareLSN(lsn, this.lastLSN) > 0) {
       this.lastLSN = lsn;
       localStorage.setItem('sync_last_lsn', lsn);
       console.log('Updated last LSN:', lsn);
     }
   }
   
   /**
    * Compare two LSNs
    * @returns -1 if lsn1 < lsn2, 0 if lsn1 === lsn2, 1 if lsn1 > lsn2
    */
   private compareLSN(lsn1: string, lsn2: string): number {
     if (lsn1 === lsn2) return 0;
     if (lsn1 === '0/0') return -1;
     if (lsn2 === '0/0') return 1;
     
     // Parse LSNs (format: "X/Y")
     const [major1, minor1] = lsn1.split('/').map(Number);
     const [major2, minor2] = lsn2.split('/').map(Number);
     
     // Compare major parts
     if (major1 !== major2) {
       return major1 > major2 ? 1 : -1;
     }
     
     // Compare minor parts
     return minor1 > minor2 ? 1 : -1;
   }
   
   // Add event listener for LSN updates
   private setupWorkerEventListeners(): void {
     // ... existing event listeners ...
     
     syncWorkerManager.on('message', (data) => {
       // Update LSN if provided
       if (data.lsn) {
         this.updateLastLSN(data.lsn);
       }
       
       // Emit appropriate event based on message type
       if (data.type === 'sync_complete') {
         this.emitEvent('sync_completed', data);
       } else if (data.type === 'sync_start') {
         this.emitEvent('sync_started', data);
       }
     });
   }
   ```

4. **Add Support for Change Processor in SyncWorker**:
   ```typescript
   // In apps/web/src/sync/worker/sync-worker.ts
   
   /**
    * Handle changes message from server
    */
   function handleChangesMessage(data: any): void {
     // Extract changes and LSN
     const { changes, lsn } = data;
     
     // Update state LSN if provided
     if (lsn) {
       state.lastLSN = lsn;
     }
     
     // Forward message to main thread
     sendToMain('message', {
       type: 'changes',
       data: {
         changes,
         lsn
       }
     });
   }
   
   // Update the handleMessage function to handle changes messages
   function handleMessage(event: MessageEvent) {
     try {
       const data = JSON.parse(event.data);
       
       // Update LSN if provided
       if (data.lsn) {
         state.lastLSN = data.lsn;
       }
       
       // Handle specific message types
       if (data.type === 'changes') {
         handleChangesMessage(data);
       } else if (data.type === 'sync_request') {
         console.log('Received sync_request from server, sending sync response');
         // Respond to sync request with the format expected by the server
         sendToServer({
           type: 'sync',
           clientId: state.clientId,
           lastLSN: state.lastLSN
         });
       } else {
         // Forward message to main thread
         sendToMain('message', data);
       }
     } catch (error: any) {
       sendError(`Error processing message: ${error.message}`);
     }
   }
   ```

### Phase 3: API Compatibility

To ensure a smooth transition, the worker-based implementation should provide a compatible API:

- Implement all public methods from `SyncClient` in `WorkerSyncService`
- Ensure event handling is consistent between implementations
- Provide migration helpers for any breaking changes

##### Detailed Implementation Plan for API Compatibility

1. **Implement All Public Methods from SyncClient**:
   ```typescript
   // In apps/web/src/sync/worker-sync-service.ts
   
   /**
    * Get the current sync state
    */
   public getState(): any {
     return {
       clientId: this.clientId,
       lastLSN: this.lastLSN,
       isConnected: this.isConnected(),
       isConnecting: syncWorkerManager.isConnecting(),
       reconnectAttempts: syncWorkerManager.getStatus().reconnectAttempts || 0
     };
   }
   
   /**
    * Force an immediate connection attempt
    */
   public async forceConnect(): Promise<boolean> {
     try {
       // Disconnect first to ensure a clean connection
       this.disconnect(false);
       
       // Connect with a fresh connection
       return await this.connect();
     } catch (err) {
       console.error('Force connect failed', err);
       this.emitEvent('error', { message: 'Force connect failed', error: err });
       return false;
     }
   }
   
   /**
    * Get the current network status
    */
   public getNetworkStatus(): boolean {
     return navigator.onLine;
   }
   
   /**
    * Add a state change listener
    */
   public onStateChange(listener: (state: any) => void): () => void {
     // Create a wrapper that converts our events to state changes
     const stateChangeListener = (data: any) => {
       listener(this.getState());
     };
     
     // Add listeners for all events that might change state
     const removeConnected = this.addEventListener('connected', stateChangeListener);
     const removeDisconnected = this.addEventListener('disconnected', stateChangeListener);
     const removeReconnecting = this.addEventListener('reconnecting', stateChangeListener);
     const removeError = this.addEventListener('error', stateChangeListener);
     
     // Return a function to remove all listeners
     return () => {
       removeConnected();
       removeDisconnected();
       removeReconnecting();
       removeError();
     };
   }
   ```

2. **Create a Compatibility Layer**:
   ```typescript
   // In apps/web/src/sync/compatibility.ts
   
   import workerSyncService from './worker-sync-service';
   import type { SyncOperation } from './types';
   
   /**
    * Compatibility layer for the worker-based sync service
    * 
    * This provides a SyncClient-compatible API for the worker-based implementation
    * to ease migration from the old implementation.
    */
   export class SyncClientCompat {
     constructor() {
       // Initialize with the worker sync service
     }
     
     /**
      * Initialize the sync client with a database
      */
     async initialize(db: any): Promise<boolean> {
       return workerSyncService.initialize(db);
     }
     
     /**
      * Connect to the sync server
      */
     async connect(): Promise<void> {
       await workerSyncService.connect();
     }
     
     /**
      * Disconnect from the sync server
      */
     disconnect(graceful: boolean = true): void {
       workerSyncService.disconnect(graceful);
     }
     
     /**
      * Get the current sync state
      */
     getState(): any {
       return workerSyncService.getState();
     }
     
     /**
      * Add an operation to the queue
      */
     queueOperation(operation: SyncOperation): void {
       // Convert SyncOperation to WorkerSyncOperation
       const workerOperation = {
         type: 'custom_operation',
         payload: {
           execute: operation.execute,
           priority: operation.priority
         },
         id: Math.random().toString(36).substring(2, 15)
       };
       
       // Queue the operation
       workerSyncService.queueOperation(workerOperation).then(() => {
         if (operation.resolve) {
           operation.resolve();
         }
       }).catch(err => {
         if (operation.reject) {
           operation.reject(err);
         }
       });
     }
     
     /**
      * Force an immediate connection attempt
      */
     async forceConnect(): Promise<void> {
       await workerSyncService.forceConnect();
     }
     
     /**
      * Get the current network status
      */
     getNetworkStatus(): boolean {
       return workerSyncService.getNetworkStatus();
     }
     
     /**
      * Add a state change listener
      */
     set onStateChange(listener: ((state: any) => void) | null) {
       if (listener) {
         this._removeStateChangeListener = workerSyncService.onStateChange(listener);
       } else if (this._removeStateChangeListener) {
         this._removeStateChangeListener();
         this._removeStateChangeListener = null;
       }
     }
     
     private _removeStateChangeListener: (() => void) | null = null;
     
     /**
      * Clean up resources
      */
     cleanup(): void {
       workerSyncService.cleanup();
     }
   }
   
   // Export a singleton instance
   export const syncClientCompat = new SyncClientCompat();
   ```

3. **Update the Main Sync Index File**:
   ```typescript
   // In apps/web/src/sync/index.ts
   
   /**
    * Sync Module
    * 
    * This module exports the sync functionality for the application.
    * It now uses a Web Worker-based implementation for improved performance.
    */
   
   import workerSyncService from './worker-sync-service';
   import { syncClientCompat } from './compatibility';
   
   // Export the worker-based sync service as the main sync client
   export const syncClient = workerSyncService;
   
   // Export the compatibility layer for legacy code
   export const syncClientLegacy = syncClientCompat;
   
   // Re-export types from the worker implementation
   export type { Database } from './worker/message-handler';
   export type { ConnectionStatus } from './worker/sync-worker-manager';
   export type { SyncServiceEvent, SyncServiceEventListener } from './worker-sync-service';
   
   // Re-export types from the old implementation for compatibility
   export type { SyncOperation, SyncState, SyncConfig } from './types';
   
   // Initialize the sync system
   export function initializeSync(db: any): boolean {
     return syncClient.initialize(db);
   }
   
   // Connect to the sync server
   export async function connectToSyncServer(): Promise<boolean> {
     return syncClient.connect();
   }
   
   // Disconnect from the sync server
   export function disconnectFromSyncServer(graceful: boolean = true): boolean {
     return syncClient.disconnect(graceful);
   }
   
   // Get the current sync status
   export function getSyncStatus(): any {
     return syncClient.getStatus();
   }
   
   // Clean up background sync resources
   export function cleanupBackgroundSync(): void {
     syncClient.cleanup();
   }
   
   // Send a sync message to the server
   export function sendSyncMessage(): boolean {
     return syncClient.sendSyncMessage();
   }
   
   // Export the singleton instance
   export default syncClient;
   ```

4. **Create Migration Helpers**:
   ```typescript
   // In apps/web/src/sync/migration-helpers.ts
   
   import { syncClient, syncClientLegacy } from './index';
   
   /**
    * Migration helpers for transitioning from the old sync implementation
    * to the new worker-based implementation.
    */
   
   /**
    * Migrate event listeners from the old implementation to the new one
    * @param oldListeners Map of event listeners from the old implementation
    * @returns Function to remove all migrated listeners
    */
   export function migrateEventListeners(
     oldListeners: Map<string, Set<(data: any) => void>>
   ): () => void {
     const removeCallbacks: Array<() => void> = [];
     
     // Map old event types to new event types
     const eventTypeMap: Record<string, string> = {
       'connected': 'connected',
       'disconnected': 'disconnected',
       'error': 'error',
       'sync_started': 'sync_started',
       'sync_completed': 'sync_completed',
       'reconnecting': 'reconnecting'
     };
     
     // Migrate each listener
     for (const [oldEventType, listeners] of oldListeners.entries()) {
       const newEventType = eventTypeMap[oldEventType];
       
       if (newEventType) {
         for (const listener of listeners) {
           // Add listener to new implementation
           const removeCallback = syncClient.addEventListener(
             newEventType as any,
             listener
           );
           
           removeCallbacks.push(removeCallback);
         }
       }
     }
     
     // Return function to remove all listeners
     return () => {
       for (const removeCallback of removeCallbacks) {
         removeCallback();
       }
     };
   }
   
   /**
    * Migrate queued operations from the old implementation to the new one
    * @param operations Array of operations from the old implementation
    */
   export function migrateQueuedOperations(operations: Array<any>): void {
     for (const operation of operations) {
       syncClientLegacy.queueOperation(operation);
     }
   }
   
   /**
    * Migrate sync state from the old implementation to the new one
    * @param oldState State from the old implementation
    */
   export function migrateSyncState(oldState: any): void {
     // The new implementation uses localStorage for state,
     // so we just need to ensure the client ID and LSN are set
     
     if (oldState.clientId) {
       localStorage.setItem('sync_client_id', oldState.clientId);
     }
     
     if (oldState.lastLSN) {
       localStorage.setItem('sync_last_lsn', oldState.lastLSN);
     }
   }
   ```

### Phase 4: Testing and Validation

Before finalizing the migration:

- Test all sync functionality with the worker-based implementation
- Validate performance improvements
- Ensure reliability under various network conditions
- Test reconnection behavior and error handling

### Phase 5: Deployment

Once testing is complete:

- Update the main sync index file to use the worker-based implementation
- Remove the old implementation files
- Update any direct references to the old implementation

## Implementation Tasks

1. **Enhance WorkerSyncService**:
   - Add operation queue functionality
   - Implement global connection tracking
   - Ensure all public methods from SyncClient are available

2. **Update SyncMessageHandler**:
   - Ensure all message types are handled correctly
   - Implement batch processing for database updates
   - Add proper error handling and recovery

3. **Enhance SyncWorker**:
   - Improve reconnection logic
   - Add support for all operation types
   - Implement proper cleanup on termination

4. **Update Main Integration**:
   - Update the sync index file to use the worker-based implementation
   - Ensure all exports are compatible with existing code
   - Provide migration helpers for any breaking changes

## Timeline

- Phase 1 (Feature Parity Analysis): 1 day
- Phase 2 (Implementation Migration): 3-5 days
- Phase 3 (API Compatibility): 2-3 days
- Phase 4 (Testing and Validation): 2-3 days
- Phase 5 (Deployment): 1 day

Total estimated time: 9-13 days

## Conclusion

Migrating to the worker-based sync implementation will provide significant benefits in terms of performance, reliability, and user experience. By following this migration plan, we can ensure a smooth transition with minimal disruption to the application. 