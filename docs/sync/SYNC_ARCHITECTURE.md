# Sync Architecture

## Overview

The sync system provides real-time synchronization of database changes across web clients using:
- Neon Postgres WAL replication for capturing and distributing database changes
- ReplicationDO for continuous WAL polling and change management
- Direct API endpoints for client change submission
- Permanent change_history table for reliable change tracking and distribution
- Per-client SyncDO instances for change filtering and delivery
- PGlite for client-side SQL storage and execution
- TypeORM for server-side schema management
- Client migration system using extracted SQL for schema synchronization

## System Components

### 1. Server-Side Data Source

The system captures changes from Neon PostgreSQL through:
- WAL (Write-Ahead Log) replication for change capture
- WAL2JSON plugin for structured change data
- Replication slots and publications for change streaming
- LSN (Log Sequence Number) tracking for synchronization
- Transaction filtering and batching for efficiency
- Direct integration with change_history table
- Reliable change ordering and distribution

Key Benefits:
- Complete change history through WAL and change_history table
- Reliable change ordering via LSN comparison
- Efficient change capture and distribution
- Built-in transaction support
- Direct path to client synchronization

### 2. ReplicationDO

The ReplicationDO provides real-time change detection with robust state management and monitoring:

#### Core Functionality
- Maintains persistent database connection
- Manages replication slot lifecycle
- Continuous WAL polling (1-second intervals)
- Built-in error recovery with backoff
- Direct change_history table updates
- Transaction boundary tracking
- Schema change detection and propagation

#### State Management
The ReplicationDO implements LSN tracking with change_history:
- Writes changes directly to change_history table
- Tracks LSN progression for each change
- Maintains safe replication slot advancement
- Provides reliable LSN querying for WAL polling
- Handles failure recovery using last processed LSN
- Monitors schema version changes
- Tracks client migration status

#### Health Monitoring
The system actively monitors replication health:
- Tracks LSN advancement progress
- Detects stalled replication
- Measures replication lag
- Provides health status notifications
- Enables automated recovery procedures
- Monitors schema synchronization
- Tracks client migration progress

Benefits:
- Direct change_history updates for reliability
- No intermediate message queues
- Clear tracking of change progression
- Automatic retry from last processed LSN
- Built-in monitoring of LSN progress
- Reliable schema version tracking
- Coordinated client migration status

### 3. Change History Management

The system uses a permanent change_history table for reliable change tracking:

#### Table Structure
```sql
CREATE TABLE change_history (
  id UUID PRIMARY KEY,
  lsn TEXT NOT NULL,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  data JSONB,
  old_data JSONB,
  transaction_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  metadata JSONB,
  client_id TEXT
);
```

#### Key Features
- Permanent storage of all WAL changes
- LSN-based change ordering
- Transaction boundary preservation
- Schema version tracking
- Client origin identification
- Complete change metadata
- Efficient change querying

#### Change Processing
- Direct writes from ReplicationDO
- Efficient filtering by LSN and client_id
- Transaction boundary preservation
- Schema version validation
- Change metadata enrichment
- Client change tracking

Benefits:
- Complete change history
- Reliable change ordering
- Efficient change queries
- Transaction integrity
- Schema version control
- Client change filtering
- Simple recovery process

### 4. Change Processing

The system maintains two simple processing paths:

1. **WAL Changes**
   - ReplicationDO captures WAL changes
   - Changes sent directly to queue
   - SyncDO instances receive from queue
   - Each SyncDO filters and forwards to its client

2. **Client Changes**
   - Client processes changes locally
   - Sends changes via API to database
   - Changes appear in WAL automatically
   - Follow WAL change path back to clients

This direct approach provides:
- Minimal processing overhead
- Clear, separate paths for changes
- Natural ordering through WAL
- Simple, reliable delivery

### 5. SyncDO

The system creates a unique SyncDO (Durable Object) instance for each connected client. Each instance acts as a dedicated notification bridge for WAL changes to its specific client:

1. **Instance Management**
   - One SyncDO instance per connected client
   - Instance created on client connection
   - Maintains isolated state per client
   - Hibernates when client disconnects

2. **WAL Change Distribution**
   - Receives WAL changes from server
   - Filters out changes originating from the connected client
   - Filters out duplicate WAL changes using LSN tracking
   - Maintains WebSocket connection to client
   - Forwards relevant changes to client
   - Handles client connection lifecycle

Each SyncDO instance maintains:
- Dedicated WebSocket connection
- Client-specific state
- LSN-based change tracking
- Change filtering state
- Connection lifecycle management

Flow Overview:
```
Client Side:                          Server Side:
Change → client_changes table         WAL change from database
          ↓                                   ↓
     Process locally                  Processing Queue
          ↓                                   ↓
    Server API Call              [SyncDO Instance Pool]
          ↓                             ↓
     [Client's SyncDO] ←── (filters & forwards relevant WAL changes)

(Each client has its own SyncDO instance with dedicated WebSocket)
```

Key Aspects:
- One-to-one client-SyncDO mapping
- Isolated state per client
- Focused on WAL change distribution
- Intelligent change filtering
- Simple WebSocket management
- Clean separation from client processing

Benefits:
1. **Simplified Architecture**
   - Natural client isolation
   - Independent state per client
   - Clear responsibility boundaries
   - Easier to maintain

2. **Client Control**
   - Dedicated processing per client
   - Direct server communication
   - Local processing control
   - Better error handling

3. **Performance**
   - Independent client processing
   - Efficient change filtering
   - No duplicate notifications
   - Lower latency for client changes

### 6. Data Flow

```
WAL Changes:
External Changes → WAL → ReplicationDO → Processing Queue → SyncDO Instance → Client

Client Changes:
Client Changes → client_changes table → Process Locally → Server API → Database → WAL → Client's SyncDO Instance (filters out own changes)
```

### 7. Error Handling

1. **Connection Errors**
   - Per-instance exponential backoff
   - Instance state persistence across reconnections
   - Automatic change replay for specific client
   - Instance-specific API retry handling

2. **Data Conflicts**
   - Per-client change ID tracking
   - Instance-specific ordered change application
   - Last-write-wins resolution
   - Source-based conflict resolution
   - Change deduplication within instance

3. **Processing Errors**
   - WAL change retries via queue
   - Instance-specific error handling
   - Per-client error monitoring and logging
   - Instance state recovery capabilities

### 8. Performance Optimizations

1. **Change Processing**
   - Transaction marker filtering
   - Instance-specific change tracking
   - Optimized API endpoints
   - Per-client change batching

2. **Change Distribution**
   - Per-instance WAL filtering
   - Client-specific payloads
   - Instance-based change routing
   - Efficient state management

3. **System Optimizations**
   - Instance pool management
   - Per-client resource monitoring
   - Instance-specific caching
   - Efficient state persistence

### 9. Future Enhancements

1. **Multi-Tenant Architecture**
   - Per-tenant instance management
   - Tenant-aware instance routing
   - Security isolation per instance
   - Resource allocation strategies

2. **Multi-User Support**
   - Instance lifecycle management
   - Cross-instance collaboration features
   - Instance-based access control
   - State synchronization between instances

3. **Scalability**
   - Instance pool horizontal scaling
   - Resource optimization per instance
   - Instance distribution strategies
   - Load balancing across instances

4. **Operational**
   - Monitoring
   - Management
   - Maintenance

5. **Data History and Recovery**
   - Client-side undo feature using PGlite
     - Local change history
     - Transaction grouping
     - Immediate undo operations
     - Session-based history
   - Server-side version history
     - Full history from unified changes table
     - Point-in-time recovery
     - Cross-client version tracking
     - Data restoration workflows

### 10. Schema Management

The system uses TypeORM with a centralized `@db` package to maintain a unified schema across server and client:

1. **Centralized Entity Management**
- All entities defined and managed in `@db` package
- Shared package imported by server and client
- TypeORM entities define core database schema
- Base entity class with common fields:
  ```typescript
  class BaseEntity {
    id: string;           // UUID primary key
    createdAt: Date;      // Creation timestamp
    updatedAt: Date;      // Last update timestamp
    version: number;      // Optimistic locking
  }
  ```
- Shared type definitions between server and client
- Automatic SQL generation for PostgreSQL
- Runtime type checking and validation

2. **Build System**
- Centralized build process in `@db` package:
  ```typescript
  // build.ts
  async function build() {
    // 1. Generate TypeScript declarations
    await generateTypes();
    
    // 2. Build server bundle (Node.js)
    await buildServer();
    
    // 3. Build client bundle (ESM)
    await buildBrowser();
    
    // 4. Process migrations
    await processMigrations();
    
    // 5. Generate meta files
    await generateMetaFiles();
  }
  ```
- Output artifacts:
  - `dist/server.js` - Node.js CJS bundle
  - `dist/browser.js` - Browser ESM bundle
  - `dist/types/` - TypeScript declarations
  - `dist/migrations/` - Processed SQL migrations
- Build-time validations:
  - Entity relationship verification
  - Migration SQL validation
  - Circular dependency detection
  - Type consistency checks

3. **Migration System**

Server-side Processing:
```typescript
// store-migration-sql.ts
async function processMigration(migration: Migration) {
  // 1. Extract SQL from TypeORM migration
  const upQueries = await extractQueries(migration.up);
  const downQueries = await extractQueries(migration.down);
  
  // 2. Store in client_migration table
  await storeMigrationSQL({
    name: migration.name,
    timestamp: extractTimestamp(migration.name),
    upQueries: JSON.stringify(upQueries),
    downQueries: JSON.stringify(downQueries)
  });
}
```

Client-side API:
```typescript
interface MigrationAPI {
  // Get pending migrations
  getPendingMigrations(): Promise<Migration[]>;
  
  // Apply specific migration
  applyMigration(name: string): Promise<void>;
  
  // Check migration status
  getMigrationStatus(): Promise<MigrationStatus>;
  
  // Rollback migration
  rollbackMigration(name: string): Promise<void>;
}
```

Migration Storage Schema:
```sql
CREATE TABLE client_migration (
  id UUID PRIMARY KEY,
  migrationName TEXT UNIQUE,
  timestamp BIGINT,
  upQueries JSONB,
  downQueries JSONB,
  clientApplied BOOLEAN DEFAULT false,
  appliedAt TIMESTAMP,
  error TEXT,
  retryCount INTEGER DEFAULT 0
);
```

Version Control:
- Semantic versioning for schema changes
- Migration dependencies tracking
- Version compatibility matrix
- Automatic version resolution
- Rollback support with dependencies

4. **Development Workflow**
- Entity Creation:
  ```
  @db/src/entities/
  ├── core/
  │   ├── user.entity.ts
  │   └── profile.entity.ts
  ├── billing/
  │   ├── invoice.entity.ts
  │   └── payment.entity.ts
  └── shared/
      ├── base.entity.ts
      └── interfaces.ts
  ```
- Migration Process:
  1. Make schema changes in entities
  2. Generate migration: `yarn migration:generate`
  3. Review and test migration
  4. Process SQL: `yarn migration:store-sql`
  5. Build package: `yarn build`
  6. Update dependents: `yarn workspace @app upgrade @db`

5. **CLI Commands**
```bash
# Generate migration from schema changes
yarn migration:generate <name>

# Create empty migration
yarn migration:create <name>

# Run pending migrations
yarn migration:run

# Rollback last migration
yarn migration:revert

# Remove migration
yarn migration:cleanup <name>

# Extract and store SQL
yarn migration:store-sql <path>

# Full build with migrations
yarn build
```

6. **Package Structure**
```
@db
├── src/
│   ├── entities/        # Database entities
│   │   ├── core/       # Core domain entities
│   │   ├── billing/    # Billing domain
│   │   └── shared/     # Shared types
│   ├── migrations/     # TypeORM migrations
│   ├── scripts/        # Build & migration scripts
│   │   ├── build.ts
│   │   └── store-migration-sql.ts
│   └── lib/           # Shared utilities
├── dist/              # Built package
│   ├── server.js      # Node.js bundle
│   ├── browser.js     # Browser bundle
│   └── migrations/    # Processed migrations
├── build.ts          # Build configuration
└── package.json      # Package definition
```

Benefits:
- Single source of truth for schema
- Consistent entity definitions
- Reliable migration process
- Type-safe database access
- Simplified dependency management
- Clear upgrade paths
- Automated build process
- Comprehensive validation
- Reliable client migrations
- Strong version control

### Initial Client Data Hydration

The system uses a hybrid approach combining database snapshots and WAL streaming for efficient client data hydration:

#### 1. Snapshot System

The snapshot system manages database state captures with:

Metadata tracking:
- Version and timestamp information
- LSN position markers
- Table-level statistics
- Data integrity checksums
- Instance-specific tracking

Snapshot contents:
- Full table data captures
- Per-instance change records
- State verification information
- Recovery checkpoints

#### 2. Hydration Process

The client connection flow follows these stages:

```
Client                 API                  Database
   |                    |                      |
   |-- Connect -------->|                      |
   |                    |-- Get Snapshot ----->|
   |                    |<-- Data ------------ |
   |<-- Snapshot Info --|                      |
   |-- Request Data --->|                      |
   |<-- Snapshot Data --|                      |
   |                    |                      |
   |-- Connect to Client's SyncDO Instance     |
   |                    |                      |
   |-- Resume WAL ----->|                      |
   |  (from LSN)        |-- Poll WAL -------->|
   |                    |<-- Changes --------- |
   |<-- Live Updates ---|                      |
```

#### 3. Instance State Management

The system manages three distinct states during hydration:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│              │     │              │     │              │
│   Instance   │ --> │   Snapshot   │ --> │ Live Syncing │
│  Creation    │     │   Loading    │     │  (WAL Mode)  │
│              │     │              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
```

Features:
- Instance creation and initialization
- Per-instance snapshot loading
- Instance-specific WAL tracking
- Clean instance state transitions

#### 4. Performance Optimizations

The hydration process includes several optimizations:

1. **Network Efficiency**
   - Per-instance compressed transfer
   - Instance-specific data formats
   - Optimized instance initialization

2. **Resource Management**
   - Instance-aware connection pooling
   - Per-instance query optimization
   - Efficient instance state management
   - Background processing per instance

3. **Instance Caching**
   - Per-instance LRU caching
   - Instance-specific metadata caching
   - Efficient instance state regeneration

#### 5. Error Handling

Robust error handling ensures reliable instance hydration:

1. **Instance Integrity**
   - Per-instance checksum verification
   - Instance-specific retry logic
   - Instance state recovery
   - Version conflict handling

2. **Instance Transition**
   - Instance-specific LSN validation
   - Per-instance gap detection
   - Instance resync triggers
   - Clean instance recovery

3. **Instance Monitoring**
   - Per-instance metrics tracking
   - Instance-specific error monitoring
   - Instance state logging
   - Instance debug information
