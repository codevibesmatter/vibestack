# Replication System

A modular, robust database replication system for tracking and propagating database changes to clients. The system uses PostgreSQL's logical replication capabilities combined with a clean, modular architecture for maximum maintainability and reliability.

## Architecture Overview

The replication system is built with a modular architecture where each component has a single responsibility:

### Core Components

- **ReplicationDO** (`ReplicationDO.ts`): A thin wrapper that orchestrates the interaction between modules
- **State Manager** (`state-manager.ts`): Manages replication state persistence and recovery
- **Client Manager** (`client-manager.ts`): Handles client registration and connection management
- **Polling Manager** (`polling.ts`): Manages WAL polling and slot advancement
- **Changes Processor** (`changes.ts`): Transforms WAL data into table changes

### Supporting Modules

- **Slot Management** (`slot.ts`): Handles replication slot operations and status
- **Health Check** (`health-check.ts`): Provides verification and data consistency tools
- **Types** (`types.ts`): Centralizes type definitions and interfaces

## Module Details

### ReplicationDO

The ReplicationDO serves as a thin coordination layer that:
- Initializes and coordinates other modules
- Handles high-level error management
- Provides the HTTP API interface
- Manages module lifecycle

### State Manager

Responsible for:
- Loading and persisting replication state
- Managing state transitions
- Handling recovery scenarios
- Maintaining replication metrics

### Client Manager

Handles:
- Client registration and deregistration
- Connection state tracking
- Client notification routing
- Connection cleanup

### Polling Manager

Manages:
- WAL polling configuration
- Slot advancement logic
- Change detection
- Polling frequency optimization

### Changes Processor

Processes:
- WAL data transformation
- Change record creation
- Data consistency validation
- Change history management

## Health Check System

The health check system provides comprehensive monitoring and verification:

### Features

- Regular health checks with configurable frequency
- Initial data cleanup for pre-replication records
- Change verification against current table state
- Synthetic change creation for consistency

### Verification Capabilities

- Table record count validation
- Change history completeness checks
- Per-record operation history
- Detailed discrepancy reporting

### Metrics

The system tracks detailed metrics including:
- Tables checked
- Records scanned
- Missing changes detected
- Synthetic changes created
- Operation duration
- Error counts

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

The system exposes several HTTP endpoints:

### Core Operations
- `GET /status`: Current replication status
- `POST /check-changes`: Manual change check
- `POST /client-connected`: Register new client
- `POST /client-disconnected`: Remove client
- `POST /client-ping`: Update client activity

### Health & Verification
- `POST /verify-changes`: Run change verification
- `POST /run-initial-cleanup`: Perform initial cleanup
- `POST /run-health-check`: Execute manual health check

## Error Handling

The system implements comprehensive error handling:
- Automatic retry mechanisms
- Error categorization
- Metric tracking per error type
- Recovery procedures

## Monitoring

### Available Metrics

\`\`\`typescript
interface ReplicationMetrics {
  changes: {
    processed: number;
    failed: number;
  };
  errors: Map<string, {
    count: number;
    lastError: string;
    timestamp: number;
  }>;
  notifications: {
    totalNotificationsSent: number;
  };
}
\`\`\`

### Lag Monitoring

\`\`\`typescript
interface ReplicationLagStatus {
  replayLag: number;  // Seconds behind
  writeLag: number;   // Bytes behind in WAL
  flushLag: number;   // Bytes not yet flushed
}
\`\`\`

## Best Practices

1. **Health Checks**
   - Run regular health checks during low-traffic periods
   - Monitor the `health_check_state` table
   - Review synthetic changes periodically

2. **Performance**
   - Keep the `change_history` table properly indexed
   - Monitor replication lag metrics
   - Adjust polling frequency based on load

3. **Maintenance**
   - Regularly verify change consistency
   - Monitor error metrics
   - Keep client registry clean

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
   - Run verification
   - Check health check logs
   - Review synthetic change creation

3. **Client Issues**
   - Verify client registration
   - Check connection status
   - Review notification logs 