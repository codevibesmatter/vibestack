# LSN Processing Refactor Plan

## Overview

This document outlines a plan to refactor the Log Sequence Number (LSN) processing in our worker-based sync system. The current implementation advances the LSN too eagerly without confirming that changes were successfully applied to the client's database, creating risks of data loss or inconsistency.

## Current Implementation Issues

### 1. Premature LSN Advancement

The client advances the LSN immediately upon receiving changes, not after successfully processing them:

```typescript
// In sync-worker.ts
if (data.type === 'changes') {
  // Update our local LSN if provided
  if (data.lsn) {
    state.lastLSN = data.lsn;
    // Forward to main thread immediately
  }
}

// In message-handler.ts
case 'changes':
  // Process changes as a batch update
  if (message.data && Array.isArray(message.data)) {
    await this.handleBatchUpdate({
      // ... process changes ...
    });
  }
  
  // Update LSN if provided - happens regardless of successful processing
  if (message.lsn) {
    localStorage.setItem('sync_last_lsn', message.lsn);
  }
  break;
```

### 2. No Error Handling for Failed Updates

The LSN is updated even if the database operations fail:

```typescript
try {
  // Start a transaction
  await this.db.transaction(async (tx) => {
    // Process batch items...
  });
} catch (error: any) {
  syncLogger.error(`Error processing batch update ${message.batchId}:`, error);
  // No mechanism to revert the LSN if the transaction fails
}
```

### 3. No Acknowledgment Mechanism

There's no explicit acknowledgment sent back to the server after successfully processing changes. The client simply updates its local LSN.

### 4. Potential Risks

1. **Data Loss**: If the client advances its LSN but fails to process some changes, it will never request those changes again.
2. **Inconsistent State**: If the app crashes or closes during change processing, the LSN might be saved but the changes not fully applied.
3. **No Recovery Mechanism**: There's no way to detect and recover from partially applied changes.

## Refactor Goals

1. Implement a robust LSN advancement mechanism that only advances the LSN after successful change processing
2. Add an acknowledgment system to confirm successful change application
3. Create a recovery mechanism for handling interrupted sync operations
4. Ensure all changes are processed atomically (all or nothing)
5. Maintain backward compatibility with the server API

## Implementation Plan

### Phase 1: Two-Phase LSN Advancement

#### 1.1 Add Pending LSN Storage

```typescript
// In sync-service.ts
private getPendingLSN(): string | null {
  return localStorage.getItem('sync_pending_lsn');
}

private setPendingLSN(lsn: string): void {
  if (lsn) {
    localStorage.setItem('sync_pending_lsn', lsn);
  }
}

private commitLSN(lsn: string): void {
  if (lsn) {
    localStorage.setItem('sync_last_lsn', lsn);
    localStorage.removeItem('sync_pending_lsn');
    syncLogger.info('Committed LSN', { lsn });
  }
}
```

#### 1.2 Modify Worker Thread LSN Handling

```typescript
// In sync-worker.ts
if (data.type === 'changes') {
  // Store as pending LSN, not confirmed yet
  if (data.lsn) {
    // Include both current and pending LSN when forwarding
    const forwardData = { ...data };
    forwardData.pendingLSN = data.lsn;
    forwardData.currentLSN = state.lastLSN;
    sendToMain('message', forwardData);
  }
}
```

#### 1.3 Update Message Handler

```typescript
// In message-handler.ts
case 'changes':
  if (message.data && Array.isArray(message.data)) {
    // Store pending LSN before processing
    if (message.pendingLSN) {
      localStorage.setItem('sync_pending_lsn', message.pendingLSN);
    }
    
    try {
      // Process changes
      await this.handleBatchUpdate({
        // ... process changes ...
      });
      
      // Only commit LSN after successful processing
      if (message.pendingLSN) {
        localStorage.setItem('sync_last_lsn', message.pendingLSN);
        localStorage.removeItem('sync_pending_lsn');
        
        // Update worker's state
        workerManager.sendMessage({
          type: 'lsn_committed',
          lsn: message.pendingLSN
        });
      }
    } catch (error) {
      syncLogger.error('Failed to process changes:', error);
      // Don't commit the LSN, leave it as pending
    }
  }
  break;
```

### Phase 2: Acknowledgment Mechanism

#### 2.1 Add Acknowledgment Message Type

```typescript
// In types definition
export type SyncMessageType = 
  // ... existing types ...
  | 'sync_ack'
  | 'lsn_committed';

export interface SyncAckMessage {
  type: 'sync_ack';
  clientId: string;
  lsn: string;
  status: 'success' | 'error';
  error?: string;
}
```

#### 2.2 Send Acknowledgment After Processing

```typescript
// In message-handler.ts
try {
  // Process changes
  await this.handleBatchUpdate({
    // ... process changes ...
  });
  
  // Commit LSN
  if (message.pendingLSN) {
    localStorage.setItem('sync_last_lsn', message.pendingLSN);
    localStorage.removeItem('sync_pending_lsn');
  }
  
  // Send acknowledgment to server
  workerManager.sendMessage({
    type: 'sync_ack',
    lsn: message.pendingLSN,
    status: 'success'
  });
} catch (error) {
  // Send failure acknowledgment
  workerManager.sendMessage({
    type: 'sync_ack',
    lsn: localStorage.getItem('sync_last_lsn') || '0/0',
    status: 'error',
    error: error.message
  });
}
```

#### 2.3 Handle Acknowledgment in Worker

```typescript
// In sync-worker.ts
if (data.type === 'sync_ack') {
  // Send acknowledgment to server
  connectionManager.sendMessage({
    type: 'sync_ack',
    clientId: state.clientId,
    lsn: data.lsn,
    status: data.status,
    error: data.error
  });
  
  // Update state if successful
  if (data.status === 'success') {
    state.lastLSN = data.lsn;
    sendToMain('status', { lastLSN: state.lastLSN });
  }
}
```

### Phase 3: Recovery Mechanism

#### 3.1 Add Startup Recovery Check

```typescript
// In sync-service.ts constructor
constructor() {
  // Generate a client ID or use existing one from localStorage
  this.clientId = localStorage.getItem('sync_client_id') || uuidv4();
  localStorage.setItem('sync_client_id', this.clientId);
  
  // Check for interrupted sync operations
  this.checkForInterruptedSync();
  
  // Ensure we have a default LSN in localStorage
  if (!localStorage.getItem('sync_last_lsn')) {
    localStorage.setItem('sync_last_lsn', '0/0');
  }
  
  // Set up event listeners for worker events
  this.setupWorkerEventListeners();
  
  // Set up network status listener
  this.setupNetworkListener();
}

private checkForInterruptedSync(): void {
  const lastLSN = localStorage.getItem('sync_last_lsn');
  const pendingLSN = localStorage.getItem('sync_pending_lsn');
  
  if (pendingLSN && pendingLSN !== lastLSN) {
    syncLogger.warn('Detected interrupted sync operation', {
      lastLSN,
      pendingLSN
    });
    
    // Clear the pending LSN - we'll re-fetch these changes
    localStorage.removeItem('sync_pending_lsn');
    
    // Could also set a flag to trigger verification on next connect
    this.needsVerification = true;
  }
}
```

#### 3.2 Add Verification Process

```typescript
// In sync-service.ts
private async verifySync(): Promise<void> {
  if (!this.needsVerification) return;
  
  syncLogger.info('Performing sync verification');
  
  // Request verification from server by sending a special sync message
  workerManager.sendMessage({
    type: 'sync_verify',
    clientId: this.clientId,
    lastLSN: this.getLastLSN()
  });
  
  this.needsVerification = false;
}

// Call this after connecting
public async connect(): Promise<boolean> {
  // ... existing connect code ...
  
  const connected = await workerManager.connect(config.wsUrl, this.clientId, lastLSN);
  
  if (connected && this.needsVerification) {
    // Schedule verification after connection is established
    setTimeout(() => this.verifySync(), 1000);
  }
  
  return connected;
}
```

### Phase 4: Transaction-Based Processing

#### 4.1 Enhance Batch Processing

```typescript
// In message-handler.ts
private async handleBatchUpdate(message: SyncMessage): Promise<void> {
  if (!this.db || !message.data || !Array.isArray(message.data)) {
    syncLogger.error('Invalid batch update message:', message);
    return;
  }

  try {
    // Start a transaction
    await this.db.transaction(async (tx) => {
      // Process all changes in a single transaction
      for (const item of message.data) {
        if (!item.type || !item.entityType || !item.entityId) {
          syncLogger.warn('Invalid batch item:', item);
          continue;
        }

        if (item.type === 'update' && item.data) {
          await tx.upsertEntity(
            item.entityType,
            item.entityId,
            item.data,
            item.timestamp
          );
        } else if (item.type === 'delete') {
          await tx.deleteEntity(
            item.entityType,
            item.entityId,
            item.timestamp
          );
        }
      }
      
      // Optionally, store the LSN in the database as part of the transaction
      // This ensures the LSN is only updated if all changes are applied
      if (message.pendingLSN) {
        await tx.setMetadata('last_lsn', message.pendingLSN);
      }
    });
    
    // Transaction succeeded, now we can update localStorage
    if (message.pendingLSN) {
      localStorage.setItem('sync_last_lsn', message.pendingLSN);
      localStorage.removeItem('sync_pending_lsn');
    }
    
    return true; // Indicate success
  } catch (error: any) {
    syncLogger.error(`Error processing batch update:`, error);
    return false; // Indicate failure
  }
}
```

### Phase 5: Server-Side Enhancements

#### 5.1 Add Acknowledgment Handling in WebSocket Handlers

```typescript
// In websocket-handlers.ts
export async function handleWebSocketMessage(
  context: SimpleWebSocketHandlerContext,
  ws: WebSocket,
  message: string | ArrayBuffer
): Promise<void> {
  try {
    // ... existing code ...
    
    if (typeof message === 'string') {
      const data = JSON.parse(message) as SyncRequest;
      
      // Handle sync_ack messages
      if (data.type === 'sync_ack') {
        connectionLogger.info('Received sync acknowledgment', {
          clientId: ws.clientData?.clientId,
          lsn: data.lsn,
          status: data.status
        });
        
        // If error, we could trigger a resend of changes
        if (data.status === 'error') {
          connectionLogger.warn('Client reported error processing changes', {
            clientId: ws.clientData?.clientId,
            lsn: data.lsn,
            error: data.error
          });
          
          // Could implement resend logic here
        }
        
        return; // Don't process further
      }
      
      // ... existing message handling ...
    }
  } catch (err) {
    // ... error handling ...
  }
}
```

#### 5.2 Add Verification Endpoint

```typescript
// In websocket-handlers.ts
// Handle sync_verify messages
if (data.type === 'sync_verify') {
  connectionLogger.info('Received sync verification request', {
    clientId: ws.clientData?.clientId,
    lastLSN: data.lastLSN
  });
  
  // Get the client's last known LSN
  const clientLSN = data.lastLSN || '0/0';
  
  // Query for any changes that might have been missed
  const query = `
    SELECT 
      lsn,
      table_name,
      operation,
      data,
      old_data
    FROM change_history
    WHERE lsn::pg_lsn > $1::pg_lsn
    ORDER BY lsn::pg_lsn ASC
    LIMIT 100
  `;
  
  const result = await context.dbClient.query(query, [clientLSN]);
  
  if (result.rows.length > 0) {
    connectionLogger.info('Found potentially missed changes during verification', {
      clientId: ws.clientData?.clientId,
      count: result.rows.length
    });
    
    // Send these changes to the client
    // ... similar to sendChangesToClient logic
  } else {
    connectionLogger.info('No missed changes found during verification', {
      clientId: ws.clientData?.clientId
    });
    
    // Send confirmation that client is up to date
    ws.send(JSON.stringify({
      type: 'sync_verify_result',
      status: 'up_to_date',
      lsn: clientLSN
    }));
  }
  
  return; // Don't process further
}
```

## Implementation Timeline

### Week 1: Phase 1 - Two-Phase LSN Advancement
- Day 1-2: Implement pending LSN storage and modify worker thread
- Day 3-4: Update message handler to use two-phase commit
- Day 5: Testing and bug fixes

### Week 2: Phase 2 - Acknowledgment Mechanism
- Day 1-2: Add acknowledgment message types and sending logic
- Day 3-4: Implement server-side acknowledgment handling
- Day 5: Testing and bug fixes

### Week 3: Phase 3 & 4 - Recovery Mechanism and Transaction-Based Processing
- Day 1-2: Implement startup recovery check and verification process
- Day 3-4: Enhance batch processing with transaction support
- Day 5: Testing and bug fixes

### Week 4: Phase 5 - Server-Side Enhancements and Final Testing
- Day 1-2: Implement server-side acknowledgment handling
- Day 3-4: Add verification endpoint
- Day 5: Final testing and documentation

## Migration Strategy

1. **Backward Compatibility**: The changes should be implemented in a way that maintains backward compatibility with the current server API.

2. **Phased Rollout**: Deploy the changes in phases, starting with the two-phase LSN advancement and gradually adding the other features.

3. **Monitoring**: Add additional logging and monitoring to track the effectiveness of the new LSN processing mechanism.

4. **Fallback Plan**: Implement a feature flag system to easily disable the new LSN processing if issues are discovered in production.

## Conclusion

This refactor plan addresses the key issues with the current LSN processing implementation and provides a roadmap for implementing a more robust solution. By implementing these changes, we can significantly reduce the risk of data loss or inconsistency in our sync system.

The plan is designed to be implemented incrementally, allowing for testing and validation at each step. The end result will be a more reliable and resilient sync system that can handle failures gracefully and ensure data consistency between the server and clients. 