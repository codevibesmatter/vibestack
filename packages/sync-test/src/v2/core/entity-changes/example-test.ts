/**
 * Entity Changes - Example Test
 * 
 * This file demonstrates how to use the simplified entity-changes system
 * for creating, modifying, and deleting entities for testing.
 */

import 'dotenv/config';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { TableChange } from '@repo/sync-types';
import { DataSource } from 'typeorm';
import { 
  TaskStatus, 
  serverEntities 
} from '@repo/dataforge/server-entities';

// Import from the new simplified API
import {
  // Initialization and database utilities
  initialize,
  fetchExistingIds,
  
  // Entity factories
  createUser,
  createProject,
  createTask,
  createComment,
  
  // Change generation and application
  entityToChange,
  applyChanges,
  cascadeDelete
} from './index.ts';

// Create a logger for this test
import { createLogger } from '../logger.ts';
const logger = createLogger('EntityChanges:Example');

// Determine the correct path to .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Go up 4 directories: /entity-changes -> /core -> /v2 -> /src -> /sync-test (root)
const rootDir = resolve(__dirname, '../../../../');

// Log environment status
logger.info(`Environment loaded`);
logger.info(`Database URL configured: ${process.env.DATABASE_URL ? 'Yes' : 'No'}`);

// Check if the DATABASE_URL environment variable is set
if (!process.env.DATABASE_URL) {
  logger.error('No DATABASE_URL configured. Tests cannot run.');
  logger.error('Please ensure you have configured a proper database connection in .env file.');
  process.exit(1);
}

// Create a DataSource instance directly
const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: serverEntities,
  synchronize: false,
  logging: false
});

/**
 * Run the complete example test
 */
async function runExample() {
  logger.info('Starting entity-changes example test');
  
  // Step 1: Initialize the database connection with our custom DataSource
  logger.info('Initializing database connection');
  
  const isInitialized = await initialize(dataSource);
  if (!isInitialized) {
    logger.error('Failed to initialize database connection');
    return;
  }
  
  logger.info('Database initialized successfully');
  
  // Step 2: Create some entities using the factory functions
  logger.info('Creating test entities');
  
  // Create a user
  const randomId = uuidv4().substring(0, 8);
  const user = createUser({
    name: `Test User ${randomId}`,
    email: `testuser-${randomId}@example.com`
  });
  
  // Create a second user that we'll delete directly
  const deleteId = uuidv4().substring(0, 8);
  const userToDelete = createUser({
    name: `User To Delete ${deleteId}`,
    email: `delete-${deleteId}@example.com`
  });
  
  // Create a project owned by the user
  const project = createProject({ 
    owner: user 
  }, {
    name: `Test Project ${randomId}`,
    description: 'A project for testing entity changes'
  });
  
  // Create another project for direct deletion
  const projectToDelete = createProject({
    owner: user
  }, {
    name: `Project To Delete ${deleteId}`,
    description: 'This project will be deleted directly'
  });
  
  // Create tasks for the project
  const tasks = [
    createTask({ project, assignee: user }, { title: 'Task 1' }),
    createTask({ project, assignee: user }, { title: 'Task 2' }),
    createTask({ project, assignee: user }, { title: 'Task 3' }),
    // Create a task to delete directly
    createTask({ project: projectToDelete, assignee: user }, { title: 'Task To Delete' })
  ];
  
  // Create comments on tasks
  const comments = [
    createComment({ 
      author: user, 
      entity: tasks[0] 
    }, { 
      content: 'Comment on Task 1'
    }),
    createComment({ 
      author: user, 
      entity: tasks[1] 
    }, { 
      content: 'Comment on Task 2'
    }),
    createComment({ 
      author: user, 
      entity: project 
    }, { 
      content: 'Comment on Project'
    }),
    // Create a comment to delete directly
    createComment({
      author: userToDelete,
      entity: projectToDelete
    }, {
      content: 'Comment To Delete'
    })
  ];
  
  // Step 3: Convert entities to changes
  logger.info('Converting entities to changes');
  const changes: TableChange[] = [
    // Create users
    entityToChange(user, 'insert'),
    entityToChange(userToDelete, 'insert'),
    
    // Create projects
    entityToChange(project, 'insert'),
    entityToChange(projectToDelete, 'insert'),
    
    // Create tasks
    ...tasks.map(task => entityToChange(task, 'insert')),
    
    // Create comments
    ...comments.map(comment => entityToChange(comment, 'insert'))
  ];
  
  // Step 4: Apply changes to the database
  logger.info(`Applying ${changes.length} changes to database`);
  const appliedChanges = await applyChanges(changes);
  logger.info(`Successfully applied ${appliedChanges.length} changes`);
  
  // Step 5: Modify some entities
  logger.info('Modifying entities');
  
  // Update project
  project.name = 'Updated Project Name';
  project.updatedAt = new Date();
  
  // Update a task
  tasks[0].title = 'Updated Task 1';
  tasks[0].status = TaskStatus.IN_PROGRESS;
  tasks[0].updatedAt = new Date();
  
  // Create update changes
  const updateChanges: TableChange[] = [
    entityToChange(project, 'update'),
    entityToChange(tasks[0], 'update')
  ];
  
  // Apply updates
  logger.info(`Applying ${updateChanges.length} update changes`);
  const appliedUpdateChanges = await applyChanges(updateChanges);
  logger.info(`Successfully applied ${appliedUpdateChanges.length} update changes`);
  
  // Step 6: Perform direct deletions of individual entities
  logger.info('Performing direct deletions of specific entities');
  
  // Create delete changes for specific entities
  const deleteChanges: TableChange[] = [
    // Delete the comment first to avoid foreign key constraints
    entityToChange(comments[3], 'delete'),
    // Delete the task
    entityToChange(tasks[3], 'delete'),
    // Delete the project
    entityToChange(projectToDelete, 'delete'),
    // Delete the user
    entityToChange(userToDelete, 'delete')
  ];
  
  // Apply the deletes
  logger.info(`Applying ${deleteChanges.length} delete changes`);
  const appliedDeleteChanges = await applyChanges(deleteChanges);
  logger.info(`Successfully deleted ${appliedDeleteChanges.length} entities directly`);
  
  // Step 7: Perform a cascade delete on the remaining project
  logger.info(`Performing cascade delete on project ${project.id}`);
  
  // Perform cascade delete directly without dry run
  const cascadeDeleteChanges = await cascadeDelete('project', project.id);
  logger.info(`Cascade delete removed ${cascadeDeleteChanges.length} entities`);
  
  // Step 8: Verify the deletion by attempting to fetch remaining entities
  const remainingIds = await fetchExistingIds();
  logger.info('Remaining entity counts after all deletions:');
  Object.entries(remainingIds).forEach(([type, ids]) => {
    logger.info(`  ${type}: ${ids.length} entities`);
  });
  
  // Clean up resources
  await dataSource.destroy();
  
  logger.info('Example test completed successfully');
}

// Run the example if this file is executed directly
const isMainModule = import.meta.url.endsWith('example-test.ts');
if (isMainModule) {
  runExample().catch(error => {
    logger.error(`Error running example: ${error}`);
    process.exit(1);
  });
}

// Export for testing
export { runExample }; 