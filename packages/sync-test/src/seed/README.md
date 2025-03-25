# Seed Data Generator

This module provides functionality to generate realistic, interconnected test data for testing sync operations with different dataset sizes.

## Prerequisites

Before running the seed data generator:

1. Make sure your database is properly set up with all required schemas and tables
2. Run all migrations to create the necessary database structure
3. The seed data generator will only populate data, not create or modify schema

## Features

- Generates realistic data using Faker.js
- Creates interconnected data across users, projects, tasks, and comments
- Supports different dataset sizes: 25, 200, and 1000 users
- Interactive CLI for easy usage
- Command-line options for automation
- Cleans existing data using `TRUNCATE` before seeding (optional)

## Usage

### Interactive Mode

To run the seed data generator in interactive mode:

```bash
pnpm seed
```

This will prompt you to:
- Select a dataset size (small, medium, large, or custom)
- Choose whether to clear existing data
- Optionally provide a client ID

### Command Line Options

You can also run the seed data generator with preset configurations:

```bash
# Seed with the small preset (25 users) and clear existing data
pnpm seed:small

# Seed with the medium preset (200 users) and clear existing data
pnpm seed:medium

# Seed with the large preset (1000 users) and clear existing data
pnpm seed:large

# Additional options
pnpm seed -- --size=small --clear=true --clientId=your-client-id
```

## Dataset Configurations

| Preset | Users | Projects/User | Tasks/Project | Comments/Task |
|--------|-------|---------------|--------------|--------------|
| Small  | 25    | 2             | 8            | 3            |
| Medium | 200   | 1.5           | 6            | 2            |
| Large  | 1000  | 1.2           | 4            | 1.5          |

## Programmatic Usage

You can also use the seed functionality programmatically in your code:

```typescript
import { DataSource } from 'typeorm';
import { 
  seedData, 
  clearAllData, 
  SEED_PRESETS, 
  SeedConfig 
} from '@repo/sync-test/src/seed';

// Example: Seed with the small preset
async function seedTestData(dataSource: DataSource) {
  // Optionally clear existing data
  await clearAllData(dataSource);
  
  // Use a preset configuration
  const config = SEED_PRESETS.small;
  // Or create a custom configuration
  const customConfig: SeedConfig = {
    userCount: 50,
    projectsPerUser: 2,
    tasksPerProject: 5,
    commentsPerTask: 2,
    memberAssignmentRate: 0.5,
    taskAssignmentRate: 0.6,
    clientId: 'optional-client-id'
  };
  
  // Seed the database
  const result = await seedData(dataSource, config);
  console.log(`Generated ${result.metrics.userCount} users`);
} 