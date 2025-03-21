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

## Technical Architecture

### Sync System

VibeStack uses a modern, efficient approach to database synchronization:

#### Server-Side Change Tracking

- **WAL-Only Approach**: Directly reads from PostgreSQL's Write-Ahead Log (WAL) without requiring a separate change history table
- **LSN Tracking**: Efficiently tracks Log Sequence Numbers (LSN) to know exactly where to resume synchronization
- **Stateful Management**: Uses Cloudflare Durable Objects to maintain consistent state across requests

#### Replication System

- **Efficient Polling**: Only retrieves changes newer than the last processed position
- **Resource Conservation**: Automatically hibernates when no clients are connected
- **Real-time Notifications**: Immediately pushes changes to connected clients

#### Sync Flow

The system supports three main sync flows:
1. **Initial Sync**: For new clients with no previous state
2. **Catchup Sync**: For clients that have fallen behind
3. **Live Sync**: For real-time bidirectional changes

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

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is private and proprietary. All rights reserved.

## Support

For support, please contact the maintainers or open an issue in the repository. 