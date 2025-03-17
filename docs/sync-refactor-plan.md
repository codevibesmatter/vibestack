# SyncDO Refactor Plan

## Current Issues

1. **Inconsistent Routing**: WebSocket connections are handled differently from HTTP requests
2. **Complex Connection Management**: The ClientManager adds unnecessary complexity
3. **Redundant State Tracking**: The server tracks client state (LSN) that clients already track themselves
4. **Unclear Separation of Concerns**: Responsibilities are spread across multiple files in an inconsistent manner

## Architecture Overview

Our system uses two types of Durable Objects:

1. **SyncDO**: One instance per client, responsible for managing the WebSocket connection for that client
2. **ReplicationDO**: A single instance that handles database replication and notifies clients about changes

This separation is intentional and should be maintained. Each SyncDO should continue to manage its own WebSocket connection, but we should simplify it by removing unnecessary client state tracking.

## Client Notification System

A key aspect of our architecture is how the ReplicationDO notifies clients about changes:

1. **ReplicationDO** detects changes in the database
2. **ReplicationDO** needs to notify affected clients
3. Each **SyncDO** instance manages a WebSocket connection for a single client

We need to maintain this notification system while simplifying the implementation. The current approach uses:

- **Client tracking in ReplicationDO**: The ReplicationDO tracks which clients are active and their last known state
- **Client notification**: When changes occur, the ReplicationDO sends HTTP requests to wake up the relevant SyncDO instances

This approach should be preserved, but we can simplify the SyncDO implementation by removing redundant state tracking.

## Handling Hibernation

Durable Objects can hibernate when inactive, which presents a challenge for maintaining the list of active clients. Instead of storing the client registry in the ReplicationDO's durable storage, we can use a KV store:

1. **KV-Based Client Registry**: ✅ Store client information in a KV namespace
2. **Simple Registration**: ✅ When a client connects to SyncDO, it registers in the KV store
3. **Disconnection Cleanup**: ✅ When a client disconnects, remove it from the KV store
4. **Failure-Tolerant Notification**: ✅ When a SyncDO no longer has an active client, it responds with a specific status code (410 Gone)
5. **Automatic Cleanup**: Remove clients from the KV store when they respond with a "gone" status

Using a KV store provides several advantages:
- **Scalability**: KV stores are designed for high-throughput access patterns
- **Simplicity**: No need to manage complex state in the ReplicationDO

## Future Extensibility

This approach also enables future enhancements to client context:

1. **Rich Client Metadata**: Store additional information about clients in the KV store
2. **Activity Tracking**: Track when clients were last active
3. **Analytics**: Generate reports on client activity
4. **Selective Notification**: Only notify clients that need specific changes

## Authentication Integration

We can integrate authentication information into the KV-based client registry:

1. **Secure Connections**: Associate authentication tokens with client registrations
2. **Personalized Experiences**: Use authentication to customize the sync experience
3. **Access Control**: Restrict synchronization operations based on user permissions

## Security Features

The refactored implementation should include:

1. **Fine-Grained Access Control**: Control which clients can access which data
2. **Multi-Tenant Data Isolation**: Ensure clients only receive data for their tenant
3. **Session Validation**: Validate client sessions and detect potential security issues
4. **Security Monitoring**: Track suspicious activity and potential attacks
5. **User Activity Reporting**: Generate reports on user activity for admin users
6. **Role-Based Sync Filtering**: Filter synchronized data based on user roles

## High-Level Goals

1. **Consolidate Sync Routing**: ✅ Ensure all sync-related requests are handled consistently
2. **Simplify SyncDO**: ✅ Remove the ClientManager and simplify the SyncDO implementation
3. **Ensure ReplicationDO Can Notify**: ✅ Make sure the ReplicationDO can notify the appropriate clients

## Implementation Plan

### Routing Cleanup

1. ✅ Ensure WebSocket upgrade requests are properly routed to SyncDO instances
2. ✅ Maintain the separation between SyncDO and ReplicationDO

### SyncDO Simplification

1. ✅ Remove the ClientManager class
2. ✅ Store client information directly on the WebSocket object
3. ✅ Simplify the WebSocket message handling
4. ✅ Update the handleNewChanges function to work with WebSockets directly

### KV-Based Client Registration

1. ✅ Create a KV namespace for client tracking
2. ✅ Update the SyncDO to register clients in the KV store
3. ✅ Update the SyncDO to remove clients from the KV store on disconnection
4. ✅ Implement a "gone" response when there are no active clients

## Connection Management Improvements

1. ✅ Simplify connection handling in SyncDO
2. ✅ Track WebSocket connections without redundant state
3. ✅ Ensure proper resource cleanup on connection closure

## handleNewChanges Updates

1. ✅ Update the handleNewChanges function to work directly with WebSocket connections
2. ✅ Allow clients to filter changes based on their state

## Code Cleanup

1. ✅ Remove unnecessary files
2. ✅ Update type definitions
3. ✅ Ensure consistent error handling
4. ✅ Add comments and documentation

## Progress Update (Current Status)

We have successfully implemented most of the planned refactoring:

1. ✅ Removed the ClientManager and simplified SyncDO
2. ✅ Implemented KV-based client registration
3. ✅ Created modular WebSocket handlers
4. ✅ Updated the connection handling to work directly with WebSocket objects
5. ✅ Implemented proper "gone" responses for disconnected clients
6. ✅ Added comprehensive documentation
7. ✅ Reorganized code into modular components with clear responsibilities
8. ✅ Ensured proper cleanup of resources on connection closure
9. ✅ Implemented WebSocket message handling with direct access to client data

## Next Steps

1. **Testing with Real Clients**:
   - Set up test environment with multiple clients
   - Verify synchronization works correctly with the new implementation
   - Test reconnection scenarios and hibernation recovery
   - Measure performance improvements from the refactoring

2. **ReplicationDO Updates**:
   - Update ReplicationDO to query the KV-based client registry
   - Implement more efficient client notification based on KV lookups
   - Add support for batch notifications to multiple clients
   - Ensure proper error handling for client notification failures

3. **Selective Notification Features**:
   - Extend client registration to include metadata about subscribed tables/entities
   - Implement filtering logic in the notification system
   - Add support for client-specific notification preferences
   - Create an API for clients to update their notification preferences

4. **Authentication Integration**:
   - Add user authentication information to client registrations
   - Implement permission checks before sending changes to clients
   - Create tenant isolation for multi-tenant deployments
   - Add audit logging for security-sensitive operations

5. **Security Enhancements**:
   - Implement session validation on reconnection attempts
   - Add rate limiting for connection attempts
   - Create monitoring for suspicious activity patterns
   - Develop admin tools for managing client connections

## Technical Details

### Simplified SyncDO Class

```typescript
export class SyncDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private client: Client | null = null;
  private webSocket: WebSocket | null = null;
  
  // ... constructor and other methods ...
  
  async fetch(request: Request): Promise<Response> {
    // Handle WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      // Create WebSocket pair
      const { 0: client, 1: server } = new WebSocketPair();
      
      // Store client info directly on the WebSocket
      server.clientData = {
        clientId: url.searchParams.get('clientId'),
        lastLSN: '0/0',
        connected: true,
        lastActivity: Date.now()
      };
      
      // Accept the WebSocket
      this.state.acceptWebSocket(server);
      this.webSocket = server;
      
      // Register client in KV store
      await registerClient(this.env, server.clientData.clientId, this.id);
      
      return new Response(null, { status: 101, webSocket: client });
    }
    
    // Handle new changes notification
    if (url.pathname.endsWith('/new-changes')) {
      // If no active WebSocket, return Gone status
      if (!this.webSocket || this.webSocket.readyState !== WebSocket.OPEN) {
        return new Response('Client disconnected', { status: 410 });
      }
      
      // Send changes to client
      // ...
    }
  }
  
  // WebSocket event handlers
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Process message
    // ...
  }
  
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    // Unregister client from KV store
    if (ws.clientData) {
      await unregisterClient(this.env, ws.clientData.clientId);
    }
  }
}
```

### Extended WebSocket Type

```typescript
declare global {
  interface WebSocket {
    clientData?: {
      clientId: string;
      lastLSN: string;
      connected: boolean;
      lastActivity: number;
    };
  }
}
```

### Environment Configuration

Add the KV namespace binding to wrangler.toml:

```toml
[[kv_namespaces]]
binding = "CLIENT_REGISTRY"
id = "client-registry"
preview_id = "client-registry-preview"
```

Update the Env interface:

```typescript
export interface Env {
  // ... existing bindings ...
  CLIENT_REGISTRY: KVNamespace;
}
```

## Testing Plan

1. **WebSocket Connection**: Verify that clients can connect via WebSocket
2. **Reconnection**: Test client reconnection after disconnection
3. **KV Registry**: Verify that clients are properly registered in the KV store
4. **Change Notification**: Test that clients receive change notifications
5. **Gone Response**: Verify that SyncDO returns a 410 Gone status when the client is disconnected
6. **Hibernation**: Test that the system works correctly across hibernation cycles

## Rollout Plan

1. ✅ Implement changes in a feature branch
2. ✅ Review code and run tests
3. ✅ Refactor SyncDO to use modular components
4. ✅ Implement KV-based client registry
5. ✅ Update documentation to reflect changes
6. **Deployment and Testing**:
   - Deploy to staging environment
   - Run comprehensive integration tests
   - Monitor performance and resource usage
   - Verify hibernation and recovery behavior
7. **Production Rollout**:
   - Deploy to a subset of production instances (canary deployment)
   - Monitor for issues and performance impacts
   - Gradually roll out to all production instances
   - Keep previous implementation available for rollback if needed
8. **Post-Deployment**:
   - Monitor error rates and performance metrics
   - Collect feedback from users
   - Address any issues discovered in production
   - Document lessons learned for future refactoring efforts 