# Authentication Strategy for VibeStack

This document outlines the authentication implementation strategy for VibeStack, focusing on integrating Better Auth with our PostgreSQL database and WebSocket-based sync system.

## Table of Contents

1. [Overview](#overview)
2. [Authentication Architecture](#authentication-architecture)
3. [Better Auth Integration](#better-auth-integration)
4. [WebSocket Authentication](#websocket-authentication)
5. [Row-Level Security (RLS)](#row-level-security-rls)
6. [Client Registry & SyncDO Integration](#client-registry--syncdo-integration)
7. [Local Sync Metadata Storage](#local-sync-metadata-storage)
8. [Changes History Access Control](#changes-history-access-control)
9. [Implementation Plan](#implementation-plan)

## Overview

Our authentication system needs to support:

- User registration and login
- Session management
- WebSocket connection authentication
- Fine-grained access control for synced data
- Multi-level permissions (admin, org admin, project member)

We've chosen Better Auth as our authentication framework because it provides a comprehensive set of features while allowing seamless integration with our existing PostgreSQL database on Neon.

## Authentication Architecture

We'll implement a **session-based authentication** approach for the following reasons:

- **Server-Side Control**: Ability to invalidate sessions instantly
- **WebSocket Compatibility**: Natural integration with WebSocket connections
- **Security**: Sensitive data stays on the server
- **Revocation**: Easy to terminate specific sessions when needed

The authentication flow will be:

1. User authenticates via Better Auth
2. Session cookie is set and used for all subsequent HTTP requests
3. WebSocket connections use the same session cookie for authentication
4. Database queries apply RLS based on the authenticated user
5. Sync system filters changes based on user permissions

## Better Auth Integration

### Database Connection

Better Auth will connect to our existing Neon PostgreSQL database using the `@neondatabase/serverless` client. We'll configure it to use the same connection parameters as our main application database for consistency.

Key integration points:
- Use the same DATABASE_URL environment variable
- Configure SSL settings appropriately for Neon
- Implement proper connection lifecycle management

### Hono Middleware

We'll implement three core middleware components:

1. **authHandler**: Processes auth-specific API requests
   - Routes Better Auth requests to the appropriate handler
   - Handles login, registration, and session verification

2. **requireAuth**: Protects routes with authentication
   - Validates session existence and validity
   - Rejects unauthenticated requests with 401 status
   - Makes user and session info available to route handlers

3. **setUserContext**: Sets database user context
   - Sets PostgreSQL session variables for RLS
   - Configures role-based access parameters
   - Determines admin status for privileged operations

### Application Structure

The authentication middleware will be integrated into the Hono application structure:

- Public routes remain accessible without authentication
- Protected routes use the requireAuth middleware
- WebSocket connections validate session before upgrade
- Database queries executed with user context

## WebSocket Authentication

### Server-Side Authentication

For WebSocket connections through our sync system:

1. Authenticate the session from cookies before accepting the WebSocket upgrade
2. Add user identity information to the WebSocket connection parameters
3. Pass authenticated user context to the Durable Object handling the connection
4. Enforce access controls based on the authenticated user's permissions

### In Durable Objects

Each SyncDO instance will:

1. Extract user identity from connection parameters
2. Store user information with the connection context
3. Filter sync data based on user permissions
4. Reject operations for resources the user cannot access

## Row-Level Security (RLS)

### Database Schema Updates

Our database schema will be extended to support roles and organizations:

- **user_roles**: Stores system-wide role information
- **organizations**: Defines multi-user workspaces
- **organization_members**: Links users to organizations with roles

### RLS Policies

PostgreSQL Row-Level Security policies will enforce access control at the database level:

- **Projects**: Accessible to owners, members, organization admins, and system admins
- **Tasks**: Accessible when the parent project is accessible
- **Comments**: Accessible when the parent task is accessible

These policies will use PostgreSQL session variables that are set during query execution:
- `app.user_id`: The ID of the authenticated user
- `app.is_admin`: Whether the user has system-wide admin privileges

## Client Registry & SyncDO Integration

### Client Registry KV Usage

Our existing CLIENT_REGISTRY KV namespace will be leveraged for authenticated client tracking:

- **User-Client Association**: Store which user owns each sync client
- **Multi-Device Support**: Track all client IDs belonging to a user
- **Auth Verification**: Validate client ownership during sync operations

### SyncDO Integration

Each SyncDO instance will integrate with the authentication system:

- **Identity Verification**: Validate user identity from session before processing sync
- **User-Aware Sync**: Store user ID with connection context
- **Client Ownership**: Ensure clients only access their own sync state
- **Hierarchical Access**: Filter sync changes based on user permissions

### Client Metadata Strategy

Our client metadata approach will be enhanced with authentication awareness:

- **Local Storage**: Continue storing client-specific sync metadata in browser storage
- **Client Identity**: Maintain existing client ID generation for device uniqueness
- **Server Registration**: Associate client IDs with authenticated users in KV store
- **Authentication Boundaries**: Prevent unauthorized access to sync streams

### Cross-Device Experience

The authenticated sync system will support:

- **Multi-Device Access**: Users can access their data from any device
- **Device-Specific Sync**: Maintain separate sync streams per device
- **Consistent Permissions**: Apply the same access rules across all user devices
- **Client Coordination**: Track active client connections per user

## Local Sync Metadata Storage

### Browser-Local Storage

The client-side sync system will continue using browser-local storage for sync metadata:

- **IndexedDB/LocalStorage**: Maintain existing storage mechanism for sync state
- **Client-Specific Data**: Each browser instance keeps its own unique sync metadata
- **Device Boundary**: No sharing of sync state between different browsers or devices

### Authentication Integration

Local sync metadata will be authentication-aware:

- **Pre-Connection Auth Check**: Verify authentication before initiating sync connection
- **Auth State Reactions**: Handle connection/disconnection based on auth state changes
- **Session Cookie Usage**: WebSocket connections automatically include auth cookies
- **No Local User Switching**: Local metadata remains tied to the browser/device, not the user

### Sync Lifecycle with Auth

The sync lifecycle will integrate with authentication:

- **Auth Required**: Sync connection will require valid authentication
- **Auth Expiry**: Handle authentication expiration during long-lived connections
- **Auth State Changes**: React to sign-in/sign-out events appropriately
  - Sign-out: Disconnect sync, retain local sync metadata
  - Sign-in: Reconnect sync with authenticated context

### Client-Side Security

Enhanced security for client-side sync:

- **Auth Verification**: Check authentication status before performing sensitive sync operations
- **Auth Boundary**: Ensure client ID uniqueness is maintained per browser instance
- **Multiple Devices**: Support same user connecting from multiple devices simultaneously
- **Disconnection Handling**: Gracefully handle auth-based disconnection scenarios

## Changes History Access Control

### Schema Updates

Our changes history system will track user ownership and permissions:

- Record which user made each change (`user_id`)
- Create optimized access path tables for performance
- Use triggers to maintain access path information

### Hierarchical Access Control

Access to change history will be based on resource hierarchy:

1. **System admins**: Access to all changes
2. **Organization admins**: Access to all changes within their organizations
3. **Project members**: Access to changes in their projects
4. **Regular users**: Access to their own changes and resources they directly interact with

### Performance Optimization

To optimize access checks for large datasets:

- Pre-compute access paths in a dedicated table
- Update access paths when permissions change
- Use efficient database queries with appropriate indexes

## Implementation Plan

1. **Phase 1: Basic Auth Integration**
   - Install Better Auth
   - Create auth module
   - Implement middleware
   - Set up protected routes

2. **Phase 2: Database Schema Updates**
   - Add role and organization tables
   - Update existing tables
   - Implement RLS policies

3. **Phase 3: WebSocket Authentication**
   - Modify WebSocket connection handling
   - Update SyncDO to respect user context
   - Add client-user association in KV store
   - Test authenticated connections

4. **Phase 4: Client-Side Integration**
   - Update SyncManager to verify auth before connection
   - Add auth state change listeners
   - Implement auth-aware sync lifecycle
   - Test multi-device scenarios

5. **Phase 5: Changes History Access Control**
   - Add user_id to changes_history
   - Create access optimization tables
   - Implement change filtering logic

6. **Phase 6: Testing & Hardening**
   - Test all auth flows
   - Verify access control works correctly
   - Load testing with authenticated connections
   - Security review 