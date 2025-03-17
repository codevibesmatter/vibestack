# Sync Connection Refactor Plan - Leveraging WebSocket Hibernation API

## Current Issues

Based on a thorough review of the codebase and server logs, we've identified several issues with the current sync connection implementation:

1. **Multiple Durable Object Instances**: The server creates multiple `SyncDO` instances for the same client ID, leading to connection conflicts.

2. **Race Conditions**: When a client connects, there's a race condition where multiple WebSocket connections can be established for the same client ID.

3. **Connection Cleanup Issues**: When a new connection replaces an existing one, the cleanup process can cause errors with the WebSocket Hibernation API.

4. **Inconsistent Client ID Usage**: The client ID is used inconsistently across the codebase, sometimes as a parameter and sometimes hardcoded.

5. **Inefficient Connection Management**: The current approach doesn't fully leverage Durable Objects' global uniqueness guarantees and WebSocket Hibernation capabilities.

6. **Unnecessary Wake-up Logic**: We're implementing complex wake-up logic and endpoints when the WebSocket connection itself automatically wakes up the Durable Object.

7. **Excessive Logging**: The current implementation generates excessive logs, making it difficult to diagnose issues.

## Root Causes

1. **Durable Object ID Generation**: In `index.ts`, we create a Durable Object ID from the client ID, but in the `/api/sync/wake` endpoint, we use a hardcoded 'sync' string.

2. **Connection Handling in React**: The React provider attempts to establish connections without properly coordinating with other components or checking for existing connections.

3. **Manual WebSocket Closing**: We manually close WebSockets that were registered with the Hibernation API, causing conflicts.

4. **Not Fully Leveraging Hibernation API**: We're not taking full advantage of the WebSocket Hibernation API's capabilities.

5. **Redundant Wake-up Endpoint**: We have a separate HTTP endpoint for waking up Durable Objects, which is unnecessary with the WebSocket Hibernation API.

6. **Inefficient Error Handling**: Error handling is inconsistent and doesn't always prevent errors from propagating.

## Key Insight: WebSocket Hibernation API

According to Cloudflare's documentation, the WebSocket Hibernation API provides several key benefits:

1. **Hibernatable WebSockets**: Using `state.acceptWebSocket(ws)` informs the Workers Runtime that the WebSocket is "hibernatable," allowing the Durable Object to be evicted from memory while the connection remains open.

2. **Automatic Reactivation**: When a WebSocket receives a message, the runtime automatically recreates the Durable Object and delivers the message to the appropriate handler.

3. **Self-Waking Connections**: The WebSocket connection itself wakes up the Durable Object - no separate wake-up endpoint is needed.

4. **Duration Charge Reduction**: Using the WebSocket Hibernation API significantly decreases duration charges.

5. **Built-in Lifecycle Management**: The API handles much of the WebSocket lifecycle management automatically.

## Leveraging Existing Sync Messages

A key insight for our refactor is that we don't need to add separate "heartbeat" messages to maintain connections. Instead, we can leverage our existing sync messages:

1. **Sync Messages as Natural Wake-up Signals**: Each sync message sent through the WebSocket automatically wakes up the Durable Object.

2. **Periodic Sync Checks**: Our existing periodic sync checks already serve as effective "heartbeats" to keep the connection active.

3. **Event-Triggered Syncs**: When visibility or focus changes, we can trigger a sync operation, which will wake up the Durable Object.

4. **Dual-Purpose Communication**: This approach is more efficient as each message serves both its primary synchronization purpose and the secondary purpose of keeping the connection alive.

5. **Reduced Network Traffic**: By avoiding separate heartbeat messages, we reduce unnecessary network traffic.

## Refactor Goals

1. **Ensure Single Durable Object Per Client**: Each client ID should map to exactly one Durable Object instance.

2. **Leverage WebSocket Hibernation API**: Fully utilize the built-in capabilities of the WebSocket Hibernation API.

3. **Remove Unnecessary Wake-up Logic**: Eliminate the wake endpoint and all related client-side wake-up logic.

4. **Use Existing Sync Messages for Connection Maintenance**: Leverage the existing sync messages as natural "wake-up" signals instead of adding separate heartbeat messages.

5. **Simplify Connection Management**: Streamline connection tracking and management.

6. **Enhance Error Handling**: Make error handling more robust and consistent.

7. **Reduce Race Conditions**: Implement proper synchronization to reduce race conditions.

8. **Optimize Connection Cleanup**: Ensure connections are cleaned up properly without causing errors.

9. **Improve Logging**: Implement more structured and useful logging.

## Implementation Plan

### 1. Server-Side Changes

#### 1.1. Consistent Durable Object ID Generation

**File**: `apps/server/src/index.ts`

```typescript
// CURRENT:
const id = env.SYNC.idFromName(clientId);

// PROPOSED:
// Use a consistent approach to generate Durable Object IDs
const id = env.SYNC.idFromName(`client:${clientId}`);
```

#### 1.2. Remove Wake Endpoint

**File**: `apps/server/src/api/sync.ts`

```typescript
// CURRENT:
sync.get('/wake', async (c) => {
  const clientId = c.req.query('clientId');
  console.log(`🔔 Wake-up ping received from client: ${clientId || 'unknown'}`);
  
  // Access the sync DO to wake it up
  try {
    const syncId = c.env.SYNC.idFromName('sync');
    const syncObj = c.env.SYNC.get(syncId);
    
    await syncObj.fetch(new Request(`${c.req.url.split('/api')[0]}/api/sync/ping`));
    
    // Additional replication DO logic...
    
    return c.json({ 
      success: true, 
      message: 'Sync server awakened',
      clientId
    });
  } catch (err) {
    // Error handling...
  }
});

// PROPOSED:
// Remove the wake endpoint entirely - WebSocket connections will wake up the Durable Object automatically
// Keep only a simple ping endpoint for health checks if needed
sync.get('/ping', async (c) => {
  return c.json({ 
    success: true, 
    message: 'Sync server is running',
    timestamp: Date.now()
  });
});
```

#### 1.3. Improve WebSocket Connection Handling

**File**: `apps/server/src/sync/SyncDO.ts`

```typescript
// CURRENT:
if (existingClient.connected && existingClient.ws.readyState === WebSocket.OPEN) {
  try {
    // Send error message and close immediately
    existingClient.ws.send(JSON.stringify({
      type: 'error',
      message: 'Connection replaced by a new connection with the same client ID'
    }));
    
    existingClient.ws.close(1000, 'Replaced by new connection');
  } catch (err) {
    // Just log the error but continue - don't let this block the new connection
    console.error('Error handling existing connection:', err);
  }
}

// PROPOSED:
if (existingClient.connected && existingClient.ws.readyState === WebSocket.OPEN) {
  try {
    // Send error message but DON'T manually close the WebSocket
    existingClient.ws.send(JSON.stringify({
      type: 'error',
      message: 'Connection replaced by a new connection with the same client ID'
    }));
    
    // Just mark as disconnected and let the Hibernation API handle cleanup
    existingClient.connected = false;
  } catch (err) {
    console.error('Error handling existing connection:', err);
  }
}
```

#### 1.4. Properly Use WebSocket Hibernation API

**File**: `apps/server/src/sync/SyncDO.ts`

```typescript
// CURRENT:
// Handle WebSocket connections
if (request.headers.get('Upgrade') === 'websocket') {
  const { 0: client, 1: server } = new WebSocketPair();
  const clientId = url.searchParams.get('clientId');
  if (!clientId) {
    return new Response('Client ID is required', { status: 400 });
  }
  await this.handleConnection(server, clientId);
  return new Response(null, {
    status: 101,
    webSocket: client
  });
}

// PROPOSED:
// Handle WebSocket connections
if (request.headers.get('Upgrade') === 'websocket') {
  const { 0: client, 1: server } = new WebSocketPair();
  const clientId = url.searchParams.get('clientId');
  if (!clientId) {
    return new Response('Client ID is required', { status: 400 });
  }
  
  // Initialize client state
  const initialClientState = {
    ws: server,
    lastLSN: '0/0',
    connected: true,
    clientId
  };
  
  // Handle existing client cleanup
  const existingClient = this.clients.get(clientId);
  if (existingClient) {
    // Handle existing client (as shown in 1.3)
  }
  
  // Update connection metrics
  this.metrics.connections.total++;
  this.metrics.connections.active++;
  
  // Store the client state
  this.clients.set(clientId, initialClientState);
  
  // Use the WebSocket Hibernation API
  this.state.acceptWebSocket(server);
  
  // Send initial sync request
  server.send(JSON.stringify({
    type: 'sync_request',
    message: 'Please send your last LSN'
  }));
  
  return new Response(null, {
    status: 101,
    webSocket: client
  });
}
```

### 2. Client-Side Changes

#### 2.1. Simplify Connection Manager

**File**: `apps/web/src/sync/connection/manager.ts`

```typescript
// CURRENT:
async connect(): Promise<WebSocket> {
  // Complex connection logic with wake-up calls
  // ...
  
  // Wake up the server first
  await this.reconnectionManager.wakeUpServer();
  
  // Create WebSocket connection
  // ...
}

// PROPOSED:
async connect(): Promise<WebSocket> {
  // If already connecting, wait for that attempt
  if (this.connectionPromise) {
    console.log('ℹ️ Connection already in progress, waiting...');
    await this.connectionPromise;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Connection failed');
    }
    return this.ws;
  }

  // If already connected, do nothing
  if (this.ws?.readyState === WebSocket.OPEN) {
    console.log('ℹ️ Already connected, no action needed');
    return this.ws;
  }

  console.log('🔄 Initiating connection...', {
    clientId: this.state.clientId,
    lastLSN: this.state.lastLSN
  });

  // Clean up any existing connection
  this.disconnect();
  
  // Mark as connecting
  this.isConnecting = true;
  
  // Create a connection promise to track this attempt
  this.connectionPromise = (async () => {
    try {
      // Initialize database connection if needed
      await this.ensureDatabase();

      // Ensure we have a valid lastLSN
      if (!this.state.lastLSN) {
        this.updateState({ lastLSN: '0/0' });
      }

      // Clean the wsUrl by removing any quotes
      const cleanWsUrl = this.config.wsUrl.replace(/['"]/g, '');

      console.log('🔌 Connecting to sync server:', {
        clientId: this.state.clientId,
        lastLSN: this.state.lastLSN,
        wsUrl: cleanWsUrl
      });

      // Create WebSocket instance with client ID and lastLSN
      // The WebSocket connection itself will wake up the Durable Object
      const wsUrl = new URL('/api/sync', cleanWsUrl);
      wsUrl.searchParams.set('clientId', this.state.clientId);
      wsUrl.searchParams.set('lastLSN', this.state.lastLSN);
      this.ws = new WebSocket(wsUrl.toString());

      // Set up event handlers
      this.eventHandlers.setupHandlers(this.ws);

      // Wait for connection to be established
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 10000); // Increased timeout for more reliability

        this.ws!.addEventListener('open', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });

        this.ws!.addEventListener('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        }, { once: true });
      });
      
      console.log('✅ Connection established successfully');
      
      return;
    } catch (err) {
      console.error('❌ Connection attempt failed:', err);
      
      // Schedule auto-reconnect
      this.scheduleAutoConnect();
      
      throw err;
    } finally {
      this.isConnecting = false;
      this.connectionPromise = null;
    }
  })();
  
  await this.connectionPromise;
  
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Connection failed');
  }
  
  return this.ws;
}
```

#### 2.2. Remove Reconnection Manager's Wake-up Method

**File**: `apps/web/src/sync/connection/reconnection.ts`

```typescript
// CURRENT:
async wakeUpServer(): Promise<boolean> {
  try {
    const clientId = this.getState().clientId;
    console.log('🔔 Explicitly waking up sync server...', {
      clientId,
      apiUrl: config.apiUrl,
      wakeupUrl: `${config.apiUrl}/api/sync/wake?clientId=${clientId}`
    });
    
    const response = await fetch(`${config.apiUrl}/api/sync/wake?clientId=${clientId}`);
    const data = await response.json();
    
    if (data.success) {
      console.log('✅ Server awakened successfully:', data);
      return true;
    } else {
      console.warn('⚠️ Server wake-up response indicates failure:', data);
      return false;
    }
  } catch (err) {
    console.error('❌ Failed to wake up server:', err);
    return false;
  }
}

// PROPOSED:
// Remove this method entirely - no wake-up logic is needed
// If a health check is needed, use a simple ping method
async checkServerHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${config.apiUrl}/api/sync/ping`);
    const data = await response.json();
    
    if (data.success) {
      return true;
    } else {
      console.warn('⚠️ Server health check failed:', data);
      return false;
    }
  } catch (err) {
    console.error('❌ Failed to check server health:', err);
    return false;
  }
}
```

#### 2.3. Update React Provider

**File**: `apps/web/src/sync/provider.tsx`

```typescript
// CURRENT:
// Complex initialization with wake-up calls
useEffect(() => {
  // ...
  
  async function initSync() {
    try {
      // ...
      
      // Connect directly without wake-up call
      // The /api/sync endpoint already wakes up the necessary Durable Objects
      syncClient.connect()
        .then(() => {
          if (mounted) {
            setIsInitialized(true);
            setState(syncClient.getState());
          }
        })
        .catch((err) => {
          console.error('Failed to initialize sync:', err);
          if (mounted) {
            setError(err instanceof Error ? err : new Error('Failed to initialize sync'));
          }
        });
    } catch (err) {
      // ...
    }
  }
  
  // ...
}, [db, connectionAttempted]);

// PROPOSED:
// Simplified initialization with no wake-up logic
useEffect(() => {
  let mounted = true;

  // Set up a listener for sync state changes
  syncClient.onStateChange = (newState) => {
    if (mounted) {
      setState(newState);
    }
  };

  async function initSync() {
    try {
      if (!db) {
        return;
      }

      // Initialize the sync client only once
      syncClient.initialize();

      // Only attempt connection if we haven't tried yet globally
      if (!connectionAttempted && !globalInitialized) {
        setConnectionAttempted(true);
        globalInitialized = true;
        
        console.log('🔄 Initial connection attempt from SyncProvider');
        
        // Connect directly - the WebSocket connection itself will wake up the Durable Object
        syncClient.connect()
          .then(() => {
            if (mounted) {
              setIsInitialized(true);
              setState(syncClient.getState());
            }
          })
          .catch((err) => {
            console.error('Failed to initialize sync:', err);
            if (mounted) {
              setError(err instanceof Error ? err : new Error('Failed to initialize sync'));
            }
          });
      } else if (syncClient.getConnectionStatus() === WebSocket.OPEN) {
        // If already connected, just update state
        setIsInitialized(true);
        setState(syncClient.getState());
      }
    } catch (err) {
      console.error('Failed to initialize sync:', err);
      if (mounted) {
        setError(err instanceof Error ? err : new Error('Failed to initialize sync'));
      }
    }
  }

  initSync();

  return () => {
    mounted = false;
    syncClient.onStateChange = null;
    
    // Don't disconnect immediately on unmount
    // This allows any in-progress sync operations to complete
    // Only disconnect if the page is actually unloading
    window.addEventListener('beforeunload', () => {
      syncClient.disconnect(false); // Force disconnect on page unload
    }, { once: true });
  };
}, [db, connectionAttempted]);
```

#### 2.4. Enhance Visibility Handler to Trigger Sync

**File**: `apps/web/src/sync/connection/visibility-handler.ts`

```typescript
// CURRENT:
private handleActivityChange(state: { isVisible: boolean; isFocused: boolean; isHovering: boolean }): void {
  // Skip if the state hasn't actually changed
  if (state.isVisible === this.lastState.isVisible && 
      state.isFocused === this.lastState.isFocused &&
      state.isHovering === this.lastState.isHovering) {
    return;
  }
  
  // Update last state
  this.lastState = { ...state };
  
  // Log state change
  console.log(`👁️ Tab activity changed:`, {
    isVisible: state.isVisible,
    isFocused: state.isFocused,
    isHovering: state.isHovering
  });

  // Handle connection based on visibility, focus, and hover
  this.handleConnectionState(state);
}

// PROPOSED:
private handleActivityChange(state: { isVisible: boolean; isFocused: boolean; isHovering: boolean }): void {
  // Skip if the state hasn't actually changed
  if (state.isVisible === this.lastState.isVisible && 
      state.isFocused === this.lastState.isFocused &&
      state.isHovering === this.lastState.isHovering) {
    return;
  }
  
  // Update last state
  this.lastState = { ...state };
  
  // Log state change
  console.log(`👁️ Tab activity changed:`, {
    isVisible: state.isVisible,
    isFocused: state.isFocused,
    isHovering: state.isHovering
  });

  // Handle connection based on visibility, focus, and hover
  this.handleConnectionState(state);
  
  // If tab becomes visible, trigger a sync operation
  // This serves as a natural "wake-up" signal for the Durable Object
  if (state.isVisible) {
    const ws = this.connectionManager.getWebSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        // Send a sync message to wake up the Durable Object
        // We're using our existing sync message format rather than creating a separate heartbeat
        ws.send(JSON.stringify({
          type: 'sync',
          lastLSN: this.connectionManager.getState().lastLSN,
          clientId: this.connectionManager.getState().clientId
        }));
        
        console.log('🔄 Sent sync message after visibility change');
      } catch (err) {
        console.error('❌ Failed to send sync message:', err);
      }
    } else {
      // If not connected, establish connection
      this.connectionManager.connect().catch(err => {
        console.error('❌ Failed to connect after visibility change:', err);
      });
    }
  }
}
```

### 3. Connection Tracking Improvements

#### 3.1. Simplify Global Connection Tracker

**File**: `apps/web/src/sync/connection/tracker.ts`

```typescript
export const globalConnectionTracker = {
  activeConnectionAttempts: new Set<string>(),
  
  /**
   * Check if a connection attempt is already in progress for the given client ID
   */
  isAttemptingConnection(clientId: string): boolean {
    return this.activeConnectionAttempts.has(clientId);
  },
  
  /**
   * Register a new connection attempt for the given client ID
   */
  startConnectionAttempt(clientId: string): void {
    this.activeConnectionAttempts.add(clientId);
  },
  
  /**
   * Unregister a connection attempt for the given client ID
   */
  endConnectionAttempt(clientId: string): void {
    this.activeConnectionAttempts.delete(clientId);
  },
  
  /**
   * Wait for an existing connection attempt to complete
   * @returns Promise that resolves when the connection attempt is no longer in progress
   */
  async waitForExistingAttempt(clientId: string): Promise<void> {
    if (!this.isAttemptingConnection(clientId)) {
      return;
    }
    
    return new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.isAttemptingConnection(clientId)) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }
};
```

### 4. Logging Improvements

#### 4.1. Structured Logging

Implement a structured logging system that categorizes logs by severity and context:

```typescript
// apps/web/src/utils/logger.ts
export const logger = {
  debug(message: string, data?: any): void {
    if (import.meta.env.DEV) {
      console.debug(`[DEBUG] ${message}`, data);
    }
  },
  
  info(message: string, data?: any): void {
    console.log(`[INFO] ${message}`, data);
  },
  
  warn(message: string, data?: any): void {
    console.warn(`[WARN] ${message}`, data);
  },
  
  error(message: string, error?: any, data?: any): void {
    console.error(`[ERROR] ${message}`, error, data);
  },
  
  // Specific categories
  connection: {
    debug(message: string, data?: any): void {
      logger.debug(`[CONNECTION] ${message}`, data);
    },
    info(message: string, data?: any): void {
      logger.info(`[CONNECTION] ${message}`, data);
    },
    warn(message: string, data?: any): void {
      logger.warn(`[CONNECTION] ${message}`, data);
    },
    error(message: string, error?: any, data?: any): void {
      logger.error(`[CONNECTION] ${message}`, error, data);
    }
  }
};
```

## Implementation Phases

### Phase 1: Server-Side Changes

1. Update Durable Object ID generation to be consistent
2. Remove the wake endpoint entirely
3. Properly use the WebSocket Hibernation API in SyncDO
4. Enhance error handling in WebSocket event handlers
5. Implement structured logging

### Phase 2: Client-Side Changes

1. Simplify the connection manager to remove all wake-up logic
2. Remove the reconnection manager's wake-up method
3. Enhance the visibility handler to trigger sync messages on visibility changes
4. Simplify the React provider
5. Update the global connection tracker
6. Implement client-side structured logging

### Phase 3: Testing and Validation

1. Develop comprehensive tests for connection scenarios
2. Validate that connections are properly managed
3. Ensure error handling is robust
4. Verify that race conditions are minimized
5. Test that sync messages effectively wake up the Durable Object

### Phase 4: Monitoring and Optimization

1. Implement connection metrics
2. Add performance monitoring
3. Optimize connection establishment
4. Reduce unnecessary reconnections
5. Monitor sync message frequency and optimize if needed

## Success Criteria

1. **Single Durable Object Per Client**: Verify that only one Durable Object instance is created per client ID.
2. **No Duplicate Connections**: Ensure that duplicate connections are properly handled without errors.
3. **Graceful Error Handling**: All errors should be caught and handled appropriately.
4. **Reduced Log Noise**: Logs should be structured and meaningful.
5. **Improved Connection Stability**: Connections should remain stable and recover gracefully from errors.
6. **Eliminated Wake-up Logic**: The client should not need any separate wake-up logic as the WebSocket connection and sync messages themselves wake up the Durable Object.
7. **Efficient Connection Maintenance**: Verify that existing sync messages effectively maintain the connection without the need for separate heartbeat messages.

## Conclusion

This refactor plan leverages the WebSocket Hibernation API to significantly simplify our connection management approach. By properly using `state.acceptWebSocket(ws)` and letting the Cloudflare Workers runtime handle the hibernation and reactivation of Durable Objects, we can eliminate all wake-up logic and endpoints.

The key insight is that the WebSocket connection itself is the wake-up mechanism:
1. When a client establishes a WebSocket connection, it automatically wakes up the Durable Object
2. The Durable Object can hibernate while the WebSocket connection remains open
3. When a message arrives on the WebSocket, the runtime automatically recreates the Durable Object
4. No separate wake-up endpoint or logic is needed

Additionally, we're leveraging our existing sync messages as natural "wake-up" signals:
1. Each sync message sent through the WebSocket automatically wakes up the Durable Object
2. We can trigger sync messages on visibility changes and other key events
3. This dual-purpose approach is more efficient than adding separate heartbeat messages
4. We maintain connection activity while performing useful work

By embracing this built-in functionality, we can create a more robust, reliable, and maintainable system with less code and fewer potential points of failure.

## Progress Update (Current Status)

We have successfully implemented several key components of the refactor plan:

### Completed:

1. **Server-Side Changes**:
   - ✅ Removed the wake endpoint from `apps/server/src/api/sync.ts`
   - ✅ Added a simple ping endpoint for health checks
   - ✅ Updated Durable Object ID generation to be consistent with `client:` prefix
   - ✅ Properly implemented WebSocket Hibernation API in `SyncDO.ts`
   - ✅ Added WebSocket event handlers (`webSocketMessage`, `webSocketClose`, `webSocketError`)
   - ✅ Improved error handling in WebSocket event handlers
   - ✅ Enhanced hibernation scheduling with better error handling
   - ✅ Removed legacy `sync.ts` file after migrating functionality to the modular structure
   - ✅ Removed legacy `connection.ts` file after migrating functionality to the connection directory
   - ✅ Updated imports to use the new modular structure
   - ✅ Updated documentation in `README.md` to reflect the new structure

2. **Client-Side Changes**:
   - ✅ Removed `wakeUpServer()` method from `ConnectionManager` and replaced with `checkServerHealth()`
   - ✅ Removed `wakeUpServer()` method from `ReconnectionManager` and replaced with `checkServerHealth()`
   - ✅ Removed `wakeUpServer()` method from `SyncClient` and replaced with `checkServerHealth()`
   - ✅ Updated the `connect()` method in `ConnectionManager` to directly establish WebSocket connections
   - ✅ Enhanced the `VisibilityHandler` to send sync messages when the tab becomes visible
   - ✅ Updated hover handling to directly connect instead of waking up the server
   - ✅ Simplified `ConnectionManager` with better error handling and connection state management
   - ✅ Improved `ReconnectionManager` with exponential backoff and reduced logging
   - ✅ Enhanced `SyncClient` with cleaner connection logic and a new `forceConnect()` method
   - ✅ Modularized the connection system into smaller, more focused files

### In Progress:

1. **Client-Side Changes**:
   - 🔄 Update the React provider to simplify initialization
   - 🔄 Implement structured logging

### Next Steps (Prioritized)

Based on our progress so far, here are the recommended next steps in order of priority:

1. **Complete Server-Side Modularization**:
   - ✅ Remove legacy `sync.ts` file (COMPLETED)
   - ✅ Remove legacy `connection.ts` file (COMPLETED)
   - 🔄 Ensure all imports are updated to use the new modular structure
   - 🔄 Add comprehensive documentation for the new modules

2. **Enhance React Provider**:
   - Simplify the initialization logic in `provider.tsx`
   - Improve error handling and recovery
   - Add better state management for connection status
   - Implement proper cleanup on unmount

3. **Implement Structured Logging**:
   - Create a dedicated logger module with severity levels
   - Add context-aware logging for different components
   - Reduce log noise in production environments
   - Add correlation IDs for tracking related log entries

4. **Connection Deduplication**:
   - Enhance the global connection tracker to better handle concurrent connection attempts
   - Implement a more robust waiting mechanism for existing connection attempts
   - Add timeout handling for stalled connection attempts

5. **Comprehensive Testing**:
   - Develop test cases for various connection scenarios
   - Test reconnection behavior under different network conditions
   - Verify proper cleanup of resources
   - Test hibernation and wake-up behavior

6. **Performance Monitoring**:
   - Add metrics for connection success rates
   - Track reconnection attempts and success rates
   - Monitor message processing times
   - Implement performance tracing for debugging

The changes made so far have significantly simplified the connection logic by removing the unnecessary wake-up endpoint and related client-side logic. We're now leveraging the WebSocket connection itself and existing sync messages to wake up the Durable Object, which is more efficient and reliable.

### Key Improvements

1. **WebSocket Hibernation API Implementation**:
   - We've properly implemented the WebSocket Hibernation API in the `SyncDO` class
   - Added the required event handlers (`webSocketMessage`, `webSocketClose`, `webSocketError`)
   - Ensured we're not manually closing WebSockets that were registered with the Hibernation API
   - Added proper error handling to prevent errors from propagating to the Cloudflare Workers runtime

2. **Consistent Durable Object ID Generation**:
   - Updated the Durable Object ID generation to use a consistent `client:` prefix
   - This ensures that each client ID maps to exactly one Durable Object instance
   - Prevents issues with duplicate Durable Object instances for the same client

3. **Improved Connection Management**:
   - Removed all wake-up logic and endpoints
   - Leveraging the WebSocket connection itself to wake up the Durable Object
   - Using existing sync messages as natural "wake-up" signals
   - Enhanced error handling and recovery mechanisms

4. **Modular Code Structure**:
   - Refactored the monolithic `sync.ts` and `connection.ts` files into smaller, focused modules
   - Each module has a clear responsibility and well-defined interfaces
   - Improved code organization and maintainability
   - Better separation of concerns for easier testing and debugging

These improvements have made the connection system more robust, reliable, and maintainable. By properly leveraging the WebSocket Hibernation API and adopting a modular code structure, we've eliminated the need for separate wake-up logic and endpoints, resulting in a simpler and more efficient system.

## Updated Approach: Simplified Connection Management

After reviewing our implementation progress and current challenges, we've decided to further simplify our approach to connection management. The key insight is that we can achieve a more robust and maintainable system by removing the complex activity-based reconnection logic and replacing it with a simple, reliable timed message system.

### Key Changes in This Updated Approach

1. **Remove Activity-Based Reconnection**:
   - Eliminate the complex visibility, focus, and hover tracking
   - Remove the `VisibilityHandler` class entirely
   - Stop tracking user activity for connection decisions

2. **Implement Simple Timed Messages**:
   - Add a simple heartbeat mechanism that sends periodic messages
   - Use a consistent interval (e.g., every 30 seconds) rather than activity-based triggers
   - Leverage existing sync messages as the heartbeat format

3. **Centralize Connection Management**:
   - Move all connection logic into the `ConnectionManager`
   - Remove the separate `ReconnectionManager` class
   - Simplify the interface between `SyncClient` and `ConnectionManager`

4. **Reduce Component Count**:
   - Consolidate functionality into fewer, more focused components
   - Eliminate unnecessary abstractions and indirection
   - Create clearer responsibility boundaries

### Benefits of This Approach

1. **Simplicity**: Much easier to understand, maintain, and debug
2. **Reliability**: More predictable behavior with fewer edge cases
3. **Testability**: Easier to write comprehensive tests
4. **Performance**: Reduced overhead from complex activity tracking
5. **Maintainability**: Fewer components and clearer responsibilities

### Implementation Plan for Simplified Connection Management

#### 1. Remove Activity Tracking

**File**: `apps/web/src/sync/connection/manager.ts`

```typescript
// CURRENT:
// Complex connection manager with visibility handler integration
constructor(
  initialState: SyncState,
  config: SyncConfig,
  onStateChange: (newState: SyncState) => void
) {
  // ...
  
  this.visibilityHandler = new VisibilityHandler(
    this,
    (state) => {
      // Complex visibility state handling
    }
  );
  
  // Enable visibility handling
  this.visibilityHandler.enable();
}

// PROPOSED:
// Simplified connection manager without visibility handler
constructor(
  initialState: SyncState,
  config: SyncConfig,
  onStateChange: (newState: SyncState) => void
) {
  this.state = initialState;
  this.config = config;
  this.onStateChange = onStateChange;
  
  // Initialize sub-managers (fewer of them)
  this.messageHandler = new MessageHandler(
    () => this.state,
    this.updateState.bind(this),
    () => this.ws,
    () => this.ensureDatabase()
  );
  
  this.eventHandlers = new EventHandlers(
    () => this.state,
    this.updateState.bind(this),
    () => this.ws,
    this.messageHandler,
    async () => { await this.connect(); },
    this.config
  );
  
  // No visibility handler initialization
}
```

#### 2. Implement Simple Heartbeat Mechanism

**File**: `apps/web/src/sync/connection/manager.ts`

```typescript
// Add a new method for starting the heartbeat
startHeartbeat(intervalMs: number = 30000): void {
  // Clear any existing interval
  this.stopHeartbeat();
  
  connectionLogger.info('Starting connection heartbeat', { intervalMs });
  
  // Set up a new interval
  this.heartbeatInterval = setInterval(() => {
    this.sendHeartbeat();
  }, intervalMs);
}

// Add a method to stop the heartbeat
stopHeartbeat(): void {
  if (this.heartbeatInterval) {
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
    connectionLogger.info('Stopped connection heartbeat');
  }
}

// Add a method to send a single heartbeat
sendHeartbeat(): void {
  // Only send if connected
  if (this.ws?.readyState !== WebSocket.OPEN) {
    connectionLogger.debug('Skipping heartbeat - not connected');
    return;
  }
  
  try {
    // Use existing sync message format as the heartbeat
    this.messageHandler.sendMessage({
      type: 'sync',
      lastLSN: this.state.lastLSN,
      clientId: this.state.clientId
    }, false); // Not a user action
    
    connectionLogger.debug('Sent heartbeat message');
  } catch (err) {
    connectionLogger.error('Failed to send heartbeat', err);
  }
}
```

#### 3. Simplify Connection Tracking

**File**: `apps/web/src/sync/connection/tracker.ts`

```typescript
/**
 * Simplified global connection tracker
 */
export const globalConnectionTracker = {
  // Track connection attempts with timestamps
  activeConnectionAttempts: new Map<string, number>(),
  
  /**
   * Check if a connection attempt is already in progress for the given client ID
   */
  isAttemptingConnection(clientId: string): boolean {
    // Check if there's an active attempt that's not too old
    const timestamp = this.activeConnectionAttempts.get(clientId);
    if (!timestamp) return false;
    
    // Consider attempts older than 30 seconds as stale
    const now = Date.now();
    if (now - timestamp > 30000) {
      this.activeConnectionAttempts.delete(clientId);
      return false;
    }
    
    return true;
  },
  
  /**
   * Register a new connection attempt for the given client ID
   * @returns A function to mark the attempt as complete
   */
  startConnectionAttempt(clientId: string): () => void {
    this.activeConnectionAttempts.set(clientId, Date.now());
    
    // Return a function to mark the attempt as complete
    return () => {
      this.endConnectionAttempt(clientId);
    };
  },
  
  /**
   * Unregister a connection attempt for the given client ID
   */
  endConnectionAttempt(clientId: string): void {
    this.activeConnectionAttempts.delete(clientId);
  },
  
  /**
   * Wait for an existing connection attempt to complete
   * @returns Promise that resolves when the connection attempt is no longer in progress
   */
  async waitForExistingAttempt(clientId: string): Promise<void> {
    // Simple polling approach to wait for the attempt to complete
    if (!this.isAttemptingConnection(clientId)) {
      return;
    }
    
    return new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.isAttemptingConnection(clientId)) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }
};
```

#### 4. Update SyncClient to Use Simplified Connection Management

**File**: `apps/web/src/sync/client.ts`

```typescript
/**
 * Initialize the sync client
 * This should be called once by the SyncProvider
 * @param shouldConnect Whether to attempt an initial connection
 */
public initialize(shouldConnect: boolean = false): void {
  // Prevent duplicate initialization
  if (this.initialized) {
    syncLogger.warn('SyncClient already initialized, ignoring duplicate call');
    return;
  }
  
  syncLogger.info('Initializing SyncClient');
  this.initialized = true;
  
  // Start heartbeat - this replaces visibility-based connection management
  this.connectionManager.startHeartbeat();
  
  // Attempt initial connection if requested
  if (shouldConnect) {
    this.connect().catch(err => {
      syncLogger.error('Initial connection attempt failed', err);
    });
  }
}

/**
 * Clean up all resources used by the client
 */
cleanup(): void {
  // Stop heartbeat
  this.connectionManager.stopHeartbeat();
  
  // Disconnect and clean up resources
  this.disconnect(false);
  
  // Clean up the connection manager
  this.connectionManager.cleanup();
  
  // Remove from global connection tracker
  globalConnectionTracker.endConnectionAttempt(this.state.clientId);
}
```

#### 5. Simplify SyncProvider

**File**: `apps/web/src/sync/provider.tsx`

```typescript
// Initialize sync client and set up event listeners
useEffect(() => {
  let mounted = true;
  
  // Initialize the sync client only once globally
  if (!globalInitialized) {
    globalInitialized = true;
    syncLogger.info('First SyncProvider initialization');
    
    // Initialize with connection attempt
    syncClient.initialize(true);
  } else {
    syncLogger.info('SyncProvider already initialized globally, skipping initialization');
  }

  // Set up a listener for sync state changes
  const handleStateChange = (newState: SyncState) => {
    if (!mounted) return;
    
    setState(newState);
    
    // If we're now connected, update initialized state
    if (newState.isConnected && !isInitialized) {
      setIsInitialized(true);
    }
  };
  
  syncClient.onStateChange = handleStateChange;
  
  // Clean up on unmount
  return () => {
    mounted = false;
    
    // Remove state change handler
    syncClient.onStateChange = null;
    
    // Don't disconnect immediately on unmount
    // This allows any in-progress sync operations to complete
    
    // Only disconnect if the page is actually unloading
    const handleBeforeUnload = () => {
      syncClient.disconnect(false); // Force disconnect on page unload
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload, { once: true });
    
    // For normal component unmounting (not page unload), use graceful disconnect
    // with a delay to allow any in-progress operations to complete
    const timeoutId = setTimeout(() => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      
      // Only disconnect if we're not remounting
      if (!(window as any).__syncRemounting) {
        syncClient.disconnect(true); // Graceful disconnect after timeout
      }
    }, 5000);
    
    // In case the component remounts quickly, we need to be able to cancel this
    (window as any).__syncCleanupTimeout = timeoutId;
  };
}, [db, isInitialized]);
```

### Next Steps for Implementation

1. **Remove Visibility Handler**:
   - Delete the `VisibilityHandler` class
   - Remove all visibility-related code from `ConnectionManager`
   - Update imports and references

2. **Implement Heartbeat Mechanism**:
   - Add heartbeat methods to `ConnectionManager`
   - Ensure proper cleanup of intervals
   - Add logging for heartbeat events

3. **Simplify Connection Tracker**:
   - Update the global connection tracker to use the simpler implementation
   - Remove promise-based tracking in favor of timestamp-based tracking
   - Ensure proper cleanup of stale connection attempts

4. **Update SyncClient**:
   - Remove visibility-related methods
   - Update initialization to use heartbeat
   - Simplify connection logic

5. **Update SyncProvider**:
   - Remove visibility change handlers
   - Simplify initialization logic
   - Ensure proper cleanup on unmount

### Success Criteria for This Phase

1. **Simplified Codebase**: Fewer components and clearer responsibilities
2. **Reliable Connections**: Connections remain active with periodic heartbeats
3. **Reduced Complexity**: No activity tracking or visibility handling
4. **Improved Maintainability**: Easier to understand and modify
5. **Better Error Handling**: More robust error recovery
6. **Reduced Race Conditions**: Fewer edge cases and race conditions

This simplified approach will provide a solid foundation for future enhancements while addressing the immediate issues with connection management. By focusing on a simple, reliable heartbeat mechanism instead of complex activity tracking, we can create a more robust and maintainable system. 