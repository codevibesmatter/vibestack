# Entity Changes - Usage Guide

This document explains how to use the simplified entity-changes system in your scripts and tests.

## Basic Setup

To use the entity-changes system in your scripts, you first need to initialize it with a DataSource:

```typescript
import { DataSource } from 'typeorm';
import { serverEntities } from '@repo/dataforge/server-entities';
import { initialize } from '../path/to/entity-changes';

// Create a DataSource instance directly
const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: serverEntities,
  synchronize: false,
  logging: false
});

// Initialize the entity-changes system
await initialize(dataSource);
```

## Creating Entities

Use the factory functions to create entities:

```typescript
import { 
  createUser, 
  createProject, 
  createTask, 
  createComment 
} from '../path/to/entity-changes';

// Create a user
const user = createUser();

// Create a project owned by the user
const project = createProject({ 
  owner: user 
});

// Create a task assigned to the user in the project
const task = createTask({ 
  project, 
  assignee: user 
});

// Create a comment on the task by the user
const comment = createComment({ 
  author: user, 
  entity: task 
});
```

The factory functions automatically generate random, unique data for your entities.

## Converting Entities to Changes

Convert entities to changes using the `entityToChange` function:

```typescript
import { entityToChange } from '../path/to/entity-changes';
import { TableChange } from '@repo/sync-types';

// Create a TableChange for inserting the user
const insertUserChange: TableChange = entityToChange(user, 'insert');

// Create a TableChange for updating the project
const updateProjectChange: TableChange = entityToChange(project, 'update');

// Create a TableChange for deleting the task
const deleteTaskChange: TableChange = entityToChange(task, 'delete');
```

## Applying Changes to the Database

Apply changes to the database using the `applyChanges` function:

```typescript
import { applyChanges } from '../path/to/entity-changes';

// Create an array of changes
const changes: TableChange[] = [
  entityToChange(user, 'insert'),
  entityToChange(project, 'insert'),
  entityToChange(task, 'insert')
];

// Apply the changes
const appliedChanges = await applyChanges(changes);
console.log(`Applied ${appliedChanges.length} changes`);
```

## Direct Deletions

To delete entities directly, create delete changes and apply them:

```typescript
// Create delete changes for specific entities
const deleteChanges: TableChange[] = [
  // Delete entities in a safe order (child entities first)
  entityToChange(comment, 'delete'),
  entityToChange(task, 'delete')
];

// Apply the delete changes
const deletedEntities = await applyChanges(deleteChanges);
console.log(`Deleted ${deletedEntities.length} entities`);
```

## Cascade Deletes

For cascade deletions that automatically handle dependencies:

```typescript
import { cascadeDelete } from '../path/to/entity-changes';

// Delete a project and all its related entities (tasks, comments, etc.)
const deletedEntities = await cascadeDelete('project', projectId);
console.log(`Cascade delete removed ${deletedEntities.length} entities`);

// Optional: Perform a dry run to see what would be deleted without actually deleting
const dryRunChanges = await cascadeDelete('project', projectId, { dryRun: true });
console.log(`Dry run would delete ${dryRunChanges.length} entities`);
```

## Fetching Existing IDs

To fetch IDs of entities already in the database:

```typescript
import { fetchExistingIds } from '../path/to/entity-changes';

// Get IDs of existing entities in the database
const existingIds = await fetchExistingIds();
console.log(`Found ${existingIds.user.length} users`);
console.log(`Found ${existingIds.project.length} projects`);
```

## Complete Script Example

Here's a complete example script:

```typescript
import { DataSource } from 'typeorm';
import { serverEntities } from '@repo/dataforge/server-entities';
import { 
  initialize, 
  createUser, 
  createProject, 
  entityToChange, 
  applyChanges,
  cascadeDelete
} from '../path/to/entity-changes';

async function run() {
  // Set up database connection
  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: serverEntities,
    synchronize: false
  });
  
  // Initialize entity-changes
  await initialize(dataSource);
  
  // Create entities
  const user = createUser();
  const project = createProject({ owner: user });
  
  // Apply insert changes
  const insertChanges = [
    entityToChange(user, 'insert'),
    entityToChange(project, 'insert')
  ];
  
  const inserted = await applyChanges(insertChanges);
  console.log(`Inserted ${inserted.length} entities`);
  
  // Modify and update project
  project.name = 'Updated Project Name';
  project.updatedAt = new Date();
  
  const updateChanges = [
    entityToChange(project, 'update')
  ];
  
  const updated = await applyChanges(updateChanges);
  console.log(`Updated ${updated.length} entities`);
  
  // Delete with cascade
  const deleted = await cascadeDelete('project', project.id);
  console.log(`Deleted ${deleted.length} entities in total`);
  
  // Clean up
  await dataSource.destroy();
}

run().catch(console.error);
``` 