# Architecture Guide

This document outlines the architecture of our TinyBase Durable Object implementation, following Hono's best practices and our type safety goals.

## Project Structure

```typescript
src/
  do/
    middleware/           // Cross-cutting concerns
      logger.ts          // Request/response logging
      metrics.ts         // Performance metrics
      validation.ts      // Request validation
      error.ts          // Error handling

    store/              // TinyBase core
      manager.ts        // Store operations
      persister.ts      // DO storage persistence
      transactions.ts   // Transaction helpers

    routes/             // Direct route handlers
      store.ts         // Store status/health
      tables.ts        // Table operations
      sync.ts          // WebSocket endpoints

    utils/             // Shared utilities
      serialization.ts // Type serialization
      validation.ts    // Schema validation
      errors.ts        // Error types

    index.ts           // Main DO class
```

## Key Principles

1. **Middleware-First**
   - Use middleware for cross-cutting concerns
   - Keep route handlers focused on business logic
   - Enable easy testing and composition

```typescript
// Example middleware pattern
const metricsMiddleware = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const start = Date.now();
  try {
    await next();
  } finally {
    const duration = Date.now() - start;
    c.header('X-Response-Time', duration.toString());
  }
};
```

2. **Direct Route Handlers**
   - No controller classes
   - Routes close to their handlers
   - Proper type inference through chaining

```typescript
// Example route pattern
const storeApp = new Hono<{ Bindings: Env }>()
  .get('/', (c) => c.json({
    tables: c.get('store').getTableIds()
  }))
  .get('/tables/:table', (c) => {
    const table = c.req.param('table');
    return c.json(c.get('store').getTable(table));
  });
```

3. **Type Safety**
   - Strict TypeScript configuration
   - Runtime validation at boundaries
   - Generated type guards from schemas

```typescript
// Example type validation
const validateUser = (data: unknown): UserSyncable => {
  const result = userSyncableSchema.safeParse(data);
  if (!result.success) {
    throw new ValidationError('Invalid user data', result.error);
  }
  return result.data;
};
```

## Main Components

### 1. Store Management

```typescript
export class TinybaseStore extends WsServerDurableObject {
  private store = createMergeableStore();
  private app = new Hono<{ Bindings: Env }>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.setupStore();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupStore() {
    this.persister = this.createPersister();
    this.persister.startAutoLoad();
    this.persister.startAutoSave();
  }

  private setupMiddleware() {
    this.app.use('*', loggerMiddleware);
    this.app.use('*', metricsMiddleware);
    this.app.use('*', errorMiddleware);
    this.app.use('*', async (c, next) => {
      c.set('store', this.store);
      await next();
    });
  }

  private setupRoutes() {
    this.app
      .route('/store', storeApp)
      .route('/tables', tablesApp);
  }
}
```

### 2. Data Operations

```typescript
// store/manager.ts
export const getStoreStats = (store: Store) => ({
  users: store.getRowCount('users'),
  projects: store.getRowCount('projects'),
  tasks: store.getRowCount('tasks')
});

export const initializeTables = (store: Store) => {
  store.transaction(() => {
    store.setTables({
      users: {},
      projects: {},
      tasks: {}
    });
  });
};
```

### 3. WebSocket Handling

```typescript
override webSocketMessage(ws: WebSocket, data: string) {
  try {
    const message = validateWsMessage(JSON.parse(data));
    handleWsMessage(this.store, message);
  } catch (error) {
    console.error('WebSocket message error:', error);
  }
}
```

### 4. WAL Subscription Flow

1. **Initialization**
```
Store DO ⟶ WAL DO WebSocket connection
       ⟶ Subscribe to relevant tables
       ⟶ Send initial LSN state
```

2. **WAL Updates**
```
Postgres WAL ⟶ WAL DO
            ⟶ Process & Filter
            ⟶ Notify Subscribers
            ⟶ Store DO Updates TinyBase
            ⟶ Store DO Updates LSN
```

3. **Store Updates**
```
Store Change ⟶ Update Postgres
           ⟶ Send LSN to WAL DO
           ⟶ WAL DO Updates State
```

### 5. WAL Message Types

```typescript
type WalMessage = 
  | { type: 'subscribe'; tables: string[] }
  | { type: 'lsn_update'; table: string; lsn: string }
  | { type: 'wal_event'; table: string; lsn: string; data: any }
  | { type: 'error'; code: string; message: string };

interface WalEvent {
  table: string;
  lsn: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  data: Record<string, any>;
}
```

### 6. LSN Tracking Strategy

[Previous LSN tracking section remains unchanged...]

## Type Safety Strategy

1. **Build Time**
   - Strict TypeScript checks
   - Complete type coverage
   - No type assertions

2. **Runtime**
   - Schema validation
   - Type guards
   - Error boundaries

3. **Development**
   - Type checking middleware
   - Validation logging
   - Performance monitoring

## Testing Approach

1. **Unit Tests**
   - Pure function testing
   - Middleware isolation
   - Type validation

2. **Integration Tests**
   - Route testing
   - WebSocket flows
   - Store operations

3. **Type Tests**
   - Schema validation
   - Type guard coverage
   - Boundary checks

## Performance Considerations

1. **Type Instantiation**
   - Manual type arguments where needed
   - Split routes for better IDE performance
   - Pre-compile types for client

2. **Validation Strategy**
   - Selective runtime checks
   - Cached validations
   - Development-only deep validation

3. **Store Operations**
   - Efficient transactions
   - Batched updates
   - Optimized queries

## Table System Architecture

### 1. Core Table System

```typescript
// Table definition system
interface TableDefinition<T> {
  name: string;
  schema: Schema<T>;
  indexes: Index[];
  transformers: DataTransformers<T>;
  validators: Validator<T>[];
  operations: CustomOperations<T>;
  migrations?: SchemaMigration[];
}

// Table registration system
class TableRegistry {
  private tables: Map<string, TableDefinition<any>>;
  private operations: Map<string, CustomOperations<any>>;
  private transformers: Map<string, DataTransformers<any>>;
  
  registerTable<T>(definition: TableDefinition<T>): void;
  getTable<T>(name: string): TableDefinition<T>;
  getOperations<T>(name: string): CustomOperations<T>;
  getTransformers<T>(name: string): DataTransformers<T>;
}

// Table operations interface
interface CustomOperations<T> {
  [key: string]: (...args: any[]) => Promise<any>;
}

// Data transformation system
interface DataTransformers<T> {
  toPostgres: (data: T) => PostgresRecord;
  fromPostgres: (record: PostgresRecord) => T;
  toTinyBase: (data: T) => TinyBaseRecord;
  fromTinyBase: (record: TinyBaseRecord) => T;
}

// Schema migration system
interface SchemaMigration {
  version: number;
  up: (data: any) => any;
  down: (data: any) => any;
}
```

### 2. Example Table Module

```typescript
// users/table.ts
export const UsersTable = defineTable({
  name: 'users',
  schema: userSchema,
  indexes: [
    { fields: ['email'], unique: true },
    { fields: ['createdAt'] }
  ],
  transformers: {
    toPostgres: userToPostgres,
    fromPostgres: userFromPostgres,
    toTinyBase: userToTinyBase,
    fromTinyBase: userFromTinyBase
  },
  operations: {
    findByEmail: async (email: string) => {...},
    updateProfile: async (id: string, profile: Profile) => {...},
    searchUsers: async (criteria: SearchCriteria) => {...}
  },
  validators: [
    validateEmail,
    validateProfile,
    validatePermissions
  ],
  migrations: [
    {
      version: 1,
      up: (data) => ({ ...data, newField: defaultValue }),
      down: ({ newField, ...data }) => data
    }
  ]
});

// users/operations.ts
export const userOperations: CustomOperations<User> = {
  findByEmail: async (email: string) => {...},
  updateProfile: async (id: string, profile: Profile) => {...},
  searchUsers: async (criteria: SearchCriteria) => {...}
};

// users/transformers.ts
export const userTransformers: DataTransformers<User> = {
  toPostgres: (user) => ({...}),
  fromPostgres: (record) => ({...}),
  toTinyBase: (user) => ({...}),
  fromTinyBase: (record) => ({...})
};

// users/validators.ts
export const userValidators: Validator<User>[] = [
  validateEmail,
  validateProfile,
  validatePermissions
];
```

### 3. Store Integration

```typescript
// store/index.ts
export class ExtensibleStore {
  private registry: TableRegistry;
  private store: TinybaseStore;

  constructor() {
    this.registry = new TableRegistry();
    this.store = createStore();
  }

  registerTable<T>(definition: TableDefinition<T>) {
    this.registry.registerTable(definition);
    this.setupTableOperations(definition);
    this.setupTableIndexes(definition);
    this.setupTableValidators(definition);
  }

  private setupTableOperations<T>(definition: TableDefinition<T>) {
    const operations = this.registry.getOperations(definition.name);
    // Bind operations to store context
    Object.entries(operations).forEach(([name, operation]) => {
      this[`${definition.name}_${name}`] = operation.bind(this);
    });
  }

  private setupTableIndexes<T>(definition: TableDefinition<T>) {
    definition.indexes.forEach(index => {
      this.store.createIndex(definition.name, index.fields, { unique: index.unique });
    });
  }

  private setupTableValidators<T>(definition: TableDefinition<T>) {
    this.store.addValidator(definition.name, async (data) => {
      for (const validator of definition.validators) {
        await validator(data);
      }
    });
  }
}
```

## Implementation Plan

### Phase 1: Core Infrastructure (COMPLETED) ✅

1. **Project Setup** ✅
   - ✓ Initialize monorepo structure
   - ✓ Configure TypeScript and build tools
   - ✓ Basic project structure

2. **Base Server Implementation** ✅
   - ✓ Hono framework setup
   - ✓ Basic middleware stack
   - ✓ Health endpoints
   - ✓ WebSocket routing

3. **Initial DO Setup** ✅
   - ✓ TinybaseStore DO structure
   - ✓ WebSocket integration
   - ✓ Basic store initialization
   - ✓ Route handling

### Phase 2: Store Implementation (Current Phase - Week 1-2)

1. **Table System Foundation**
   - Implement TableDefinition interface
   - Create TableRegistry system
   - Add table operation binding
   - Implement index management

2. **Type System**
   - Define schema interfaces
   - Create table-specific types
   - Implement generic type helpers
   - Add schema validation

3. **Store Operations**
   - Implement base CRUD
   - Add table-specific operations
   - Create operation registry
   - Set up operation binding

4. **Data Transformation**
   - Create transformer interface
   - Implement base transformers
   - Add custom transformers
   - Set up transformation pipeline

### Phase 3: WAL Integration (Week 3-4)

1. **WAL Durable Object**
   - Table-aware WAL tracking
   - Per-table WebSocket channels
   - Table-specific LSN tracking
   - Custom event processing

2. **Postgres Integration**
   - Table-specific clients
   - Custom WAL polling
   - Per-table transformers
   - Table-aware error handling

3. **Sync Logic**
   - Table-based LSN management
   - Per-table conflict resolution
   - Table-specific recovery
   - Custom sync strategies

### Phase 4: API & Client (Week 5)

1. **API Layer**
   - Table-specific endpoints
   - Custom operation routes
   - Table-aware middleware
   - Operation authentication

2. **Client SDK**
   - Table-specific clients
   - Type-safe operations
   - Custom query builders
   - Table event handling

3. **Developer Tools**
   - Table scaffolding
   - Operation generators
   - Schema migration tools
   - Table debugging utils

### Phase 5: Production (Week 6)

1. **Security**
   - Table-level permissions
   - Operation authorization
   - Custom rate limits
   - Data encryption

2. **Monitoring**
   - Table-specific metrics
   - Operation tracking
   - Custom alerts
   - Performance monitoring

3. **Deploy**
   - Table validation
   - Migration checks
   - Backup verification
   - Recovery testing

### Updated Milestones

1. **Table System (Current)**
   - Table registry working
   - Operation binding
   - Custom operations
   - Index management

2. **WAL Integration**
   - Table-aware sync
   - Custom transformers
   - Per-table LSN

3. **API & Client**
   - Table-specific APIs
   - Type-safe operations
   - Custom queries

4. **Production Ready**
   - Table validation
   - Operation security
   - Migration support

### Immediate Next Steps

1. **Table System**
   - Implement TableRegistry
   - Create operation binding
   - Add index support
   - Set up validators

2. **Type System**
   - Table-specific types
   - Operation types
   - Transformer types
   - Validation types

3. **Store Operations**
   - Base CRUD
   - Custom operations
   - Query builders
   - Index operations

## Development Workflow

1. **Local Development**
   - Wrangler for DO testing
   - WebSocket debugging
   - Type checking

2. **Deployment**
   - Type check
   - Build validation
   - Runtime checks

## Future Considerations

1. **Schema Evolution**
   - Version management
   - Migration support
   - Backward compatibility

2. **Scale**
   - Multiple DOs
   - Data partitioning
   - Performance optimization

3. **Monitoring**
   - Metrics collection
   - Error tracking
   - Performance analysis

## Postgres Synchronization Layer

### 1. Core Components

```typescript
src/do/
  store/             // Main TinyBase store DO
    [existing structure]
  
  wal/              // WAL tracking DO
    index.ts        // WAL DO implementation
    client.ts       // Neon serverless client
    processor.ts    // WAL event processing
    routes.ts       // WAL WebSocket routes
    types.ts        // WAL message types

  sync/
    postgres/
      client.ts     // Neon serverless client
      lsn.ts       // LSN management
      transformers/ // Data transformers
        users.ts
        projects.ts
        tasks.ts
```

### 2. WAL Durable Object

```typescript
// Example WAL DO structure
export class WalTrackerDO extends DurableObject {
  private walClient: Client;
  private subscribers: Map<string, WebSocket[]>;
  private lsnState: Map<string, string>;

  constructor(state: DurableObjectState, env: Env) {
    super(state);
    this.subscribers = new Map();
    this.lsnState = new Map();
  }

  // Handle WebSocket connections for WAL updates
  async webSocketMessage(ws: WebSocket, data: string) {
    const message = JSON.parse(data);
    switch (message.type) {
      case 'subscribe':
        // Subscribe to specific tables
        this.handleSubscribe(ws, message.tables);
        break;
      case 'lsn_update':
        // Update LSN state
        this.handleLsnUpdate(message.table, message.lsn);
        break;
    }
  }

  // Process WAL events and notify subscribers
  private async processWalEvent(event: WalEvent) {
    const { table, lsn, data } = event;
    const subscribers = this.subscribers.get(table) || [];
    
    // Check if we should process this LSN
    if (this.shouldSkipLsn(table, lsn)) {
      return;
    }

    // Notify all subscribers
    for (const ws of subscribers) {
      ws.send(JSON.stringify({
        type: 'wal_event',
        table,
        lsn,
        data
      }));
    }
  }
}
```

### 3. Integration with Main Store

```typescript
// In main index.ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    
    // Route WAL WebSocket connections to WAL DO
    if (url.pathname.startsWith('/wal')) {
      const walId = env.WalTrackerDO.idFromName('wal-tracker');
      const walDO = env.WalTrackerDO.get(walId);
      return walDO.fetch(request);
    }

    // Route store WebSocket connections to Store DO
    if (request.headers.get('Upgrade') === 'websocket') {
      const storeId = url.searchParams.get('store') || 'default';
      const storeDO = env.TinybaseStore.get(
        env.TinybaseStore.idFromName(storeId)
      );
      return storeDO.fetch(request);
    }

    return app.fetch(request, env, ctx);
  }
}
```

### 4. LSN Tracking Strategy

```typescript
// db/schema.ts - LSN tracking table
import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const lsnTracking = pgTable('_lsn_tracking', {
  tableName: text('table_name').primaryKey(),
  currentLsn: text('current_lsn').notNull(),
  lastSync: timestamp('last_sync').notNull(),
  lastOperation: text('last_operation', { enum: ['store', 'postgres'] }).notNull(),
  metadata: jsonb('metadata'),
  updatedAt: timestamp('updated_at').defaultNow()
}, (table) => ({
  excludeFromWal: true // This table is explicitly excluded from WAL tracking
}));

// types/lsn.ts
interface LsnState {
  currentLsn: string;
  lastSync: Date;
  lastOperation: 'store' | 'postgres';
  metadata?: Record<string, unknown>;
}

// wal/lsn-manager.ts
export class LsnManager {
  private cache: Map<string, LsnState>;
  private lastFlush: number;
  private flushInterval: number;

  constructor(
    private db: ReturnType<typeof createDb>,
    private state: DurableObjectState,
    options: { flushIntervalMs?: number } = {}
  ) {
    this.cache = new Map();
    this.lastFlush = Date.now();
    this.flushInterval = options.flushIntervalMs || 5000;
  }

  async initialize() {
    // Load initial state from Postgres
    const records = await this.db
      .select()
      .from(lsnTracking);
    
    for (const record of records) {
      this.cache.set(record.tableName, {
        currentLsn: record.currentLsn,
        lastSync: record.lastSync,
        lastOperation: record.lastOperation,
        metadata: record.metadata
      });
    }
  }

  async updateLsn(
    table: string,
    lsn: string,
    operation: 'store' | 'postgres'
  ) {
    // Update in-memory cache
    this.cache.set(table, {
      currentLsn: lsn,
      lastSync: new Date(),
      lastOperation: operation
    });

    // Schedule flush if needed
    if (Date.now() - this.lastFlush > this.flushInterval) {
      await this.flush();
    }
  }

  private async flush() {
    const batch = [];
    for (const [table, state] of this.cache.entries()) {
      batch.push(
        this.db
          .insert(lsnTracking)
          .values({
            tableName: table,
            ...state
          })
          .onConflictDoUpdate({
            target: lsnTracking.tableName,
            set: state
          })
      );
    }
    
    await Promise.all(batch);
    this.lastFlush = Date.now();
  }

  async getLsnState(table: string): Promise<LsnState | undefined> {
    // Check cache first
    const cached = this.cache.get(table);
    if (cached) return cached;

    // Fall back to database
    const record = await this.db
      .select()
      .from(lsnTracking)
      .where(eq(lsnTracking.tableName, table))
      .limit(1);

    return record[0] ? {
      currentLsn: record[0].currentLsn,
      lastSync: record[0].lastSync,
      lastOperation: record[0].lastOperation,
      metadata: record[0].metadata
    } : undefined;
  }

  async getHistory(
    table: string,
    options: { limit?: number; since?: Date } = {}
  ) {
    return this.db
      .select()
      .from(lsnTracking)
      .where(eq(lsnTracking.tableName, table))
      .orderBy(desc(lsnTracking.updatedAt))
      .limit(options.limit || 100);
  }
}

// Enhanced WAL DO with LSN Manager
export class WalTrackerDO extends DurableObject {
  private lsnManager: LsnManager;
  
  async initialize() {
    this.lsnManager = new LsnManager(this.db, this.state);
    await this.lsnManager.initialize();
  }

  private async shouldProcessWalEvent(
    table: string,
    lsn: string
  ): Promise<boolean> {
    const state = await this.lsnManager.getLsnState(table);
    if (!state) return true;

    // Compare LSNs and check if we should process
    return compareLsn(lsn, state.currentLsn) > 0 &&
           state.lastOperation !== 'postgres';
  }

  async processWalEvent(event: WalEvent) {
    const { table, lsn } = event;
    
    if (await this.shouldProcessWalEvent(table, lsn)) {
      // Process the event
      await this.handleWalEvent(event);
      // Update LSN state
      await this.lsnManager.updateLsn(table, lsn, 'postgres');
    }
  }
}
```

This hybrid LSN tracking approach provides several benefits:

1. **Durability**
   - LSN state persisted in Postgres
   - Excluded from WAL to prevent cycles
   - Reliable recovery path

2. **Performance**
   - In-memory cache for hot LSNs
   - Batched updates to Postgres
   - Minimal latency impact

3. **Debugging**
   - Historical LSN tracking
   - Sync performance metrics
   - Replication diagnostics

4. **Recovery**
   - Clean DO restart path
   - Historical state available
   - Conflict resolution support

The LSN manager handles:
- Cache management
- Periodic flushing
- State recovery
- History tracking
- Conflict detection

## Core Principles

### 1. Type Safety
- **Zero Runtime Type Errors**: Comprehensive type checking at build time
- **Type-Safe Data Flow**: End-to-end type safety from store to database
- **Validation Chain**: Build time ⟶ Runtime validation ⟶ Database constraints

### 2. Performance
- **Efficient Type Instantiation**: Optimized generic type usage
- **Smart Caching**: Validation and transformation result caching
- **Minimal Runtime Overhead**: Strategic runtime checks

### 3. Developer Experience
- **Type Inference**: Maximum type inference with minimal manual typing
- **IDE Support**: Full autocomplete and type hints
- **Error Tracing**: Clear error paths and debugging

## Type System Architecture

### 1. Core Types

```typescript
// types/core.ts
export interface TypedTable<T> {
  schema: TableSchema<T>;
  validate: (data: unknown) => T;
  transform: <U>(data: T, to: DataFormat) => U;
}

export interface TableSchema<T> {
  properties: Record<keyof T, PropertySchema>;
  required: Array<keyof T>;
  additionalProperties: false;
}

type PropertySchema = {
  type: 'string' | 'number' | 'boolean' | 'object';
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
};

export type DataFormat = 'tinybase' | 'postgres' | 'json';
```

### 2. Type Guards and Validation

```typescript
// validation/guards.ts
export const createTypeGuard = <T>(schema: TableSchema<T>) => {
  return (data: unknown): data is T => {
    try {
      validateSchema(schema, data);
      return true;
    } catch {
      return false;
    }
  };
};

export const validateSchema = <T>(
  schema: TableSchema<T>,
  data: unknown
): T => {
  if (!data || typeof data !== 'object') {
    throw new ValidationError('Invalid data type');
  }

  // Validate required properties
  for (const key of schema.required) {
    if (!(key in data)) {
      throw new ValidationError(`Missing required property: ${String(key)}`);
    }
  }

  // Validate property types and formats
  for (const [key, value] of Object.entries(data)) {
    const propertySchema = schema.properties[key];
    if (!propertySchema) {
      if (!schema.additionalProperties) {
        throw new ValidationError(`Unknown property: ${key}`);
      }
      continue;
    }
    validateProperty(key, value, propertySchema);
  }

  return data as T;
};
```

### 3. Type-Safe Store Operations

```typescript
// store/operations.ts
export class TypedStore<Schema extends Record<string, TypedTable<any>>> {
  constructor(
    private store: Store,
    private schema: Schema
  ) {}

  getRow<T extends keyof Schema>(
    table: T,
    id: string
  ): Schema[T]['schema'] extends TableSchema<infer U> ? U | undefined : never {
    const row = this.store.getRow(String(table), id);
    if (!row) return undefined;
    
    return this.schema[table].validate(row);
  }

  setRow<T extends keyof Schema>(
    table: T,
    id: string,
    data: Schema[T]['schema'] extends TableSchema<infer U> ? U : never
  ): void {
    // Validate at runtime in development
    if (process.env.NODE_ENV === 'development') {
      this.schema[table].validate(data);
    }
    
    this.store.setRow(String(table), id, data);
  }
}
```

## Database Integration

### 1. Drizzle Schema with Type Safety

```typescript
// db/schema.ts
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { createTypeGuard } from '../validation/guards';
import type { User, Project, Task } from '../types';

export const users = pgTable('users', {
  id: text('id').primaryKey().$type<User['id']>(),
  createdAt: timestamp('created_at').notNull().$type<User['createdAt']>(),
  updatedAt: timestamp('updated_at').notNull().$type<User['updatedAt']>(),
  email: text('email').notNull().$type<User['email']>(),
  name: text('name').notNull().$type<User['name']>(),
  role: text('role').notNull().$type<User['role']>()
});

// Type guard for runtime validation
export const isUser = createTypeGuard<User>(userSchema);

// Similar for projects and tasks...
```

### 2. Type-Safe Transformers

```typescript
// transformers/index.ts
import type { User, Project, Task } from '../types';
import type { DataFormat } from '../types/core';

export interface Transformer<T> {
  from: (data: unknown, format: DataFormat) => T;
  to: (data: T, format: DataFormat) => unknown;
}

export const createTransformer = <T>(
  validate: (data: unknown) => T
): Transformer<T> => ({
  from: (data: unknown, format: DataFormat) => {
    const validated = validate(data);
    return transformFromFormat(validated, format);
  },
  to: (data: T, format: DataFormat) => {
    return transformToFormat(data, format);
  }
});

export const userTransformer = createTransformer<User>(isUser);
// Similar for projects and tasks...
```

### 3. WAL Integration with Type Safety

```typescript
// wal/processor.ts
export class TypedWalProcessor {
  constructor(
    private transformers: Record<string, Transformer<any>>,
    private subscribers: Map<string, WebSocket[]>
  ) {}

  async processEvent<T>(event: WalEvent<T>) {
    const { table, operation, data } = event;
    const transformer = this.transformers[table];
    
    if (!transformer) {
      throw new Error(`No transformer for table: ${table}`);
    }

    // Transform and validate the data
    const validated = transformer.from(data, 'postgres');
    
    // Notify subscribers with type-safe data
    this.notifySubscribers(table, {
      type: 'wal_event',
      table,
      operation,
      data: validated
    });
  }
}
```

### 4. LSN Tracking Strategy

```typescript
// db/schema.ts - LSN tracking table
import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const lsnTracking = pgTable('_lsn_tracking', {
  tableName: text('table_name').primaryKey(),
  currentLsn: text('current_lsn').notNull(),
  lastSync: timestamp('last_sync').notNull(),
  lastOperation: text('last_operation', { enum: ['store', 'postgres'] }).notNull(),
  metadata: jsonb('metadata'),
  updatedAt: timestamp('updated_at').defaultNow()
}, (table) => ({
  excludeFromWal: true // This table is explicitly excluded from WAL tracking
}));

// types/lsn.ts
interface LsnState {
  currentLsn: string;
  lastSync: Date;
  lastOperation: 'store' | 'postgres';
  metadata?: Record<string, unknown>;
}

// wal/lsn-manager.ts
export class LsnManager {
  private cache: Map<string, LsnState>;
  private lastFlush: number;
  private flushInterval: number;

  constructor(
    private db: ReturnType<typeof createDb>,
    private state: DurableObjectState,
    options: { flushIntervalMs?: number } = {}
  ) {
    this.cache = new Map();
    this.lastFlush = Date.now();
    this.flushInterval = options.flushIntervalMs || 5000;
  }

  async initialize() {
    // Load initial state from Postgres
    const records = await this.db
      .select()
      .from(lsnTracking);
    
    for (const record of records) {
      this.cache.set(record.tableName, {
        currentLsn: record.currentLsn,
        lastSync: record.lastSync,
        lastOperation: record.lastOperation,
        metadata: record.metadata
      });
    }
  }

  async updateLsn(
    table: string,
    lsn: string,
    operation: 'store' | 'postgres'
  ) {
    // Update in-memory cache
    this.cache.set(table, {
      currentLsn: lsn,
      lastSync: new Date(),
      lastOperation: operation
    });

    // Schedule flush if needed
    if (Date.now() - this.lastFlush > this.flushInterval) {
      await this.flush();
    }
  }

  private async flush() {
    const batch = [];
    for (const [table, state] of this.cache.entries()) {
      batch.push(
        this.db
          .insert(lsnTracking)
          .values({
            tableName: table,
            ...state
          })
          .onConflictDoUpdate({
            target: lsnTracking.tableName,
            set: state
          })
      );
    }
    
    await Promise.all(batch);
    this.lastFlush = Date.now();
  }

  async getLsnState(table: string): Promise<LsnState | undefined> {
    // Check cache first
    const cached = this.cache.get(table);
    if (cached) return cached;

    // Fall back to database
    const record = await this.db
      .select()
      .from(lsnTracking)
      .where(eq(lsnTracking.tableName, table))
      .limit(1);

    return record[0] ? {
      currentLsn: record[0].currentLsn,
      lastSync: record[0].lastSync,
      lastOperation: record[0].lastOperation,
      metadata: record[0].metadata
    } : undefined;
  }

  async getHistory(
    table: string,
    options: { limit?: number; since?: Date } = {}
  ) {
    return this.db
      .select()
      .from(lsnTracking)
      .where(eq(lsnTracking.tableName, table))
      .orderBy(desc(lsnTracking.updatedAt))
      .limit(options.limit || 100);
  }
}

// Enhanced WAL DO with LSN Manager
export class WalTrackerDO extends DurableObject {
  private lsnManager: LsnManager;
  
  async initialize() {
    this.lsnManager = new LsnManager(this.db, this.state);
    await this.lsnManager.initialize();
  }

  private async shouldProcessWalEvent(
    table: string,
    lsn: string
  ): Promise<boolean> {
    const state = await this.lsnManager.getLsnState(table);
    if (!state) return true;

    // Compare LSNs and check if we should process
    return compareLsn(lsn, state.currentLsn) > 0 &&
           state.lastOperation !== 'postgres';
  }

  async processWalEvent(event: WalEvent) {
    const { table, lsn } = event;
    
    if (await this.shouldProcessWalEvent(table, lsn)) {
      // Process the event
      await this.handleWalEvent(event);
      // Update LSN state
      await this.lsnManager.updateLsn(table, lsn, 'postgres');
    }
  }
}
```

This hybrid LSN tracking approach provides several benefits:

1. **Durability**
   - LSN state persisted in Postgres
   - Excluded from WAL to prevent cycles
   - Reliable recovery path

2. **Performance**
   - In-memory cache for hot LSNs
   - Batched updates to Postgres
   - Minimal latency impact

3. **Debugging**
   - Historical LSN tracking
   - Sync performance metrics
   - Replication diagnostics

4. **Recovery**
   - Clean DO restart path
   - Historical state available
   - Conflict resolution support

The LSN manager handles:
- Cache management
- Periodic flushing
- State recovery
- History tracking
- Conflict detection

## Development Tools

### 1. Type Checking Middleware

```typescript
// middleware/typeCheck.ts
export const typeCheckMiddleware = <T>(
  validator: (data: unknown) => T
) => {
  return async (c: Context, next: Next) => {
    if (process.env.NODE_ENV === 'development') {
      const body = await c.req.json();
      try {
        validator(body);
      } catch (error) {
        c.status(400);
        return c.json({ error: 'Type validation failed', details: error });
      }
    }
    await next();
  };
};
```

### 2. Type-Safe Testing Utilities

```typescript
// testing/utils.ts
export const createTypedTestStore = <Schema extends Record<string, TypedTable<any>>>(
  schema: Schema
) => {
  const store = createStore();
  return new TypedStore(store, schema);
};

export const createMockWalEvent = <T>(
  table: string,
  data: T
): WalEvent<T> => ({
  table,
  operation: 'INSERT',
  data,
  lsn: '0/0'
});
```

[rest of document remains unchanged] 