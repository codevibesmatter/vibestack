# VibeStack

A modular, type-safe real-time sync system built with TypeScript and WebSocket technology.

## Overview

VibeStack is a sophisticated real-time synchronization system that enables seamless data synchronization between clients and servers. It's designed to be modular, type-safe, and highly performant, making it ideal for applications requiring real-time updates and state management.

> **TODO:** Client-side alignment and simplification to align with server-side changes.

## Features

- 🔄 Real-time bidirectional synchronization
- 📦 Modular architecture with clear separation of concerns
- 🔒 Type-safe implementation with TypeScript
- 🚀 Efficient WebSocket-based communication
- 📊 Built-in support for chunked data transfer
- 📝 WAL-only server-side change tracking (no separate change history table)
- 🔁 Efficient LSN-based polling mechanism
- 🛌 Intelligent hibernation for resource conservation
- 🔍 Comprehensive testing suite
- 🛠️ Monorepo structure using Turborepo and pnpm

## Project Structure

```
vibestack/
├── apps/                    # Application implementations
├── packages/               # Shared packages
│   ├── sync-test/         # Testing utilities for sync functionality
│   ├── dataforge/         # Database integration layer
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