# VibeStack

A modular, type-safe real-time sync system built with TypeScript and WebSocket technology.

## Overview

VibeStack is a sophisticated real-time synchronization system that enables seamless data synchronization between clients and servers. It's designed to be modular, type-safe, and highly performant, making it ideal for applications requiring real-time updates and state management.

## Features

- 🔄 Real-time bidirectional synchronization
- 📦 Modular architecture with clear separation of concerns
- 🔒 Type-safe implementation with TypeScript
- 🚀 Efficient WebSocket-based communication
- 📊 Built-in support for chunked data transfer
- 🔍 Comprehensive testing suite
- 🛠️ Monorepo structure using Turborepo and pnpm

## Project Structure

```
vibestack/
├── apps/                    # Application implementations
├── packages/               # Shared packages
│   ├── sync-test/         # Testing utilities for sync functionality
│   ├── typeorm/           # Database integration layer
│   ├── sync-types/        # Shared type definitions for sync
│   ├── shared-types/      # Common type definitions
│   ├── config/            # Configuration packages
│   └── typescript-config/ # TypeScript configuration
└── docs/                  # Project documentation
```

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