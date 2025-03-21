# VibeStack

## Overview

VibeStack is a sophisticated real-time synchronization system that enables seamless data synchronization between clients and servers. It's designed to be modular, type-safe, and highly performant, making it ideal for applications requiring real-time updates and state management.

> **TODO:** Client-side alignment and simplification to align with server-side changes.

## Features

- ✨ **Offline-First Architecture** - Continue working without an internet connection
- 🔄 **Bi-directional Sync** - Changes flow seamlessly between server and clients
- 🚀 **Edge-Powered Backend** - Globally distributed with minimal latency
- 💾 **Full SQL in the Browser** - Complete PostgreSQL capabilities via WebAssembly
- 🧠 **Local LLM & NLP Support** - PGLite pgvector extension support for vector embeddings and AI features
- 🛡️ **Enterprise-Grade Security** - End-to-end data protection with access controls
- 🔌 **Zero Infrastructure** - Serverless deployment with no management overhead
- 🧰 **Developer Experience** - Type-safe APIs with excellent tooling support


## Core Components

### 1. Server Architecture

- **Single Cloudflare Worker**: Serverless edge runtime for the entire backend
  - Zero infrastructure management
  - Global edge distribution
  - Automatic scaling with traffic demands
- **Hono HTTP Framework**: Lightweight, high-performance API server
- **Neon PostgreSQL**: Serverless Postgres database
  - WAL (Write-Ahead Log) based change capture
  - Built-in replication capabilities
  - Branching for development environments
- **ReplicationDO (Durable Object)**: Manages database replication with PostgreSQL's WAL
  - Polls for changes in the database
  - Maintains replication state and log sequence numbers (LSN)
  - Notifies clients of changes in real-time
- **SyncDO (Durable Object)**: Per-client sync manager
  - Manages WebSocket connections for individual clients
  - Filters changes relevant to specific clients
  - Handles client-to-server data synchronization
  - Maintains client session state
  - Implements conflict resolution and last-write-wins semantics

### 2. Client Application

- **React Frontend**: Modern, responsive user interface
- **PGLite Integration**: PostgreSQL in WebAssembly
  - Full SQL database running in the browser
  - Persistent storage with IndexedDB
  - Support for complex queries and transactions
- **WebSocket Sync**: Real-time data synchronization
  - Bidirectional communication with server
  - Efficient change propagation
  - Conflict resolution

### 3. DataForge Entity Manager

- **TypeORM Integration**: ORM and database toolkit
  - Entity definition with decorators
  - Relationship mapping
  - Direct SQL queries instead of query builders
- **Schema Management**: Define entities with TypeScript decorators
- **Type Generation**: Automatic TypeScript type generation
- **Multi-Database Support**: Works with both server PostgreSQL and client PGLite
- **Migration System**: Consistent schema across environments
- **Table Categories**: Domain, System, and Utility table classifications
- **Custom Entity Generator**: Smart context-aware entity management
  - Generates separate server and client entity exports
  - Uses decorators to control property/entity visibility (@ServerOnly, @ClientOnly)
  - Automatically discovers and analyzes entity relationships
  - Builds dependency hierarchies for efficient data synchronization
  - Handles complex entity metadata filtering

> **TODO:** Implement full CRUD API code generation to automatically create type-safe endpoints from entity definitions.

## Project Structure

```
vibestack/
├── apps/                    # Application implementations
│   ├── server/             # Hono server with ReplicationDO and SyncDO
│   └── web/                # React client with PGLite integration
├── packages/               # Shared packages
│   ├── sync-test/         # Testing utilities for sync functionality
│   ├── dataforge/         # Database integration and entity management
│   ├── sync-types/        # Shared type definitions for sync
│   ├── config/            # Configuration packages
│   └── typescript-config/ # TypeScript configuration
└── docs/                  # Project documentation
```

## Change Tracking and Sync Flow

- **WAL-Based Change Capture**: Uses PostgreSQL's Write-Ahead Log for efficient change detection
- **LSN (Log Sequence Number) Tracking**: Precisely tracks database changes without extra tables
- **Sync Flow Types**:
  1. **Initial Sync**: Complete data download for new clients
  2. **Catchup Sync**: Selective updates for reconnecting clients
  3. **Live Sync**: Real-time bidirectional updates

## Prerequisites

- Node.js >= 18
- pnpm >= 8
- TypeScript >= 5.5

## Getting Started

1. Clone the repository:
   ```bash
   git clone git@github.com:codevibesmatter/vibestack.git
   cd vibestack
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Build the project:
   ```bash
   pnpm build
   ```

4. Start development servers:
   ```bash
   pnpm dev
   ```

> **TODO:** Add proper steps for entity generation (`pnpm run generate:entities`) and initial migrations (`pnpm run migration:generate:server` and `pnpm run migration:generate:client`), followed by migration execution (`pnpm run deploy`).

## Development

- `pnpm build` - Build all packages and applications
- `pnpm dev` - Start development servers
- `pnpm lint` - Run ESLint
- `pnpm lint:fix` - Fix ESLint issues
- `pnpm format` - Format code with Prettier
- `pnpm quality` - Run code quality checks

## Testing

The project includes a comprehensive test suite for the sync functionality:

```bash
# Run sync tests
pnpm --filter @repo/sync-test test
```

## License

This project is private and proprietary. All rights reserved.

## Support

For support, please contact the maintainers or open an issue in the repository. 