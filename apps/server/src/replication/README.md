# Replication System

The replication system provides real-time database change notifications to keep all clients in sync with the latest data. Instead of clients having to poll the database directly, we use an efficient polling system that only retrieves changes newer than our last processed position, ensuring minimal database load while maintaining real-time updates.

## What it Does

- Watches for any changes in our PostgreSQL database (inserts, updates, deletes)
- Captures these changes using PostgreSQL's Write-Ahead Log (WAL)
- Transforms the changes into a format our clients can understand
- Immediately notifies all connected clients about the changes

## Why it's Useful

- **Real-time Updates**: Clients get notified instantly when data changes
- **Efficient Polling**: Only retrieves changes newer than our last position, minimizing database load
- **Consistent**: All clients stay in sync with the latest database state
- **Scalable**: Works with any number of connected clients

## Architecture

The system consists of several key components:

### Core Components

- **Replication DO** (`ReplicationDO.ts`): Main Durable Object that coordinates the replication system
- **State Manager** (`state-manager.ts`): Manages replication slot operations, LSN tracking, and state persistence
- **Client Manager** (`client-manager.ts`): Manages client registry and notifications
- **Polling Manager** (`polling.ts`): Manages the polling cycle for WAL changes
- **Changes** (`changes.ts`): Handles WAL change validation, transformation, and processing

### Flow

1. The Replication DO initializes the state, client, and polling managers
2. Clients register with the Client Manager through the client registry
3. The Polling Manager checks for changes in the WAL:
   - Uses `pg_logical_slot_peek_changes` with a WHERE clause to filter changes after the current LSN
   - This ensures we only get changes newer than our last processed position
   - The WHERE clause is more efficient than using the `upto_lsn` parameter
   - If there are active clients, it polls regularly
   - If no clients are connected, it enters hibernation
4. When changes are found:
   - Changes are validated and transformed into our universal TableChange format
   - Active clients are notified via the client registry
   - The LSN is updated to the most recent change's position
   - Changes are logged for monitoring and debugging

### Hibernation

The system supports hibernation to conserve resources:
- When no clients are connected, polling stops
- A hibernation alarm is set
- When the alarm fires, the system checks for clients and restarts if needed

### Types and Configuration

- **Types** (`types.ts`): Contains shared type definitions
- **Configuration**: Set via the ReplicationConfig interface

## Usage

The system is built on Cloudflare Durable Objects to provide:
- **Stateful Coordination**: The ReplicationDO maintains consistent state across all requests
- **Automatic Hibernation**: Durable Objects automatically hibernate when inactive, conserving resources
- **Global Distribution**: Changes can be distributed to clients across any Cloudflare edge location
- **Consistent Processing**: All change processing happens in one place, preventing race conditions

The ReplicationDO acts as the central coordinator, ensuring that:
- Only one instance processes changes at a time
- State (like LSN tracking) remains consistent
- Clients receive notifications reliably
- Resources are used efficiently through automatic hibernation

## Configuration

The replication system is configured through the `ReplicationConfig` interface:

\`\`\`typescript
interface ReplicationConfig {
  slot: string;
  publication: string;
  hibernationDelay: number;
}
\`\`\`

## API Endpoints

The system exposes the following HTTP endpoints:

- `POST /init`: Initialize the replication system
- `GET /status`: Get current replication status
- `GET /clients`: Get list of active clients

## Error Handling

The system implements comprehensive error handling:
- Automatic retry mechanisms
- Error categorization
- Metric tracking per error type
- Recovery procedures

## Development Guidelines

1. **Module Independence**
   - Keep modules loosely coupled
   - Use defined interfaces for module communication
   - Maintain single responsibility principle

2. **Error Handling**
   - Use typed errors
   - Implement proper error recovery
   - Log errors with context

3. **Testing**
   - Write unit tests per module
   - Include integration tests
   - Test error scenarios

## Troubleshooting

Common issues and their solutions:

1. **Replication Lag**
   - Check system resources
   - Verify network connectivity
   - Review polling configuration

2. **Missing Changes**
   - Verify LSN tracking
   - Check client connections
   - Review polling logs

3. **Client Issues**
   - Verify client registration
   - Check connection status
   - Review notification logs 