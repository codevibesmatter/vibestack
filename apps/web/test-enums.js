// Simple Node.js script to test importing enums from the TypeORM package
console.log('Testing imports from TypeORM package...\n');

// Try importing directly from client-entities
try {
  console.log('Testing import from client-entities:');
  const clientEntities = require('../../packages/typeorm/dist/client-entities.js');
  console.log('Available exports from client-entities:', Object.keys(clientEntities));
  
  // Check for TaskStatus
  if (clientEntities.TaskStatus) {
    console.log('\nTaskStatus enum from client-entities:', clientEntities.TaskStatus);
  } else {
    console.log('\nTaskStatus enum is not available in client-entities');
  }
  
  // Check for TaskPriority
  if (clientEntities.TaskPriority) {
    console.log('\nTaskPriority enum from client-entities:', clientEntities.TaskPriority);
  } else {
    console.log('\nTaskPriority enum is not available in client-entities');
  }
  
  // Check for ProjectStatus
  if (clientEntities.ProjectStatus) {
    console.log('\nProjectStatus enum from client-entities:', clientEntities.ProjectStatus);
  } else {
    console.log('\nProjectStatus enum is not available in client-entities');
  }
} catch (error) {
  console.error('Error importing from client-entities:', error);
}

// Try importing directly from entity files
try {
  console.log('\n\nTesting import from Task.js entity:');
  const taskEntity = require('../../packages/typeorm/dist/entities/Task.js');
  console.log('Available exports from Task.js:', Object.keys(taskEntity));
  
  // Check for TaskStatus in Task entity
  if (taskEntity.TaskStatus) {
    console.log('\nTaskStatus enum from Task.js:', taskEntity.TaskStatus);
  } else {
    console.log('\nTaskStatus enum is not available in Task.js');
  }
  
  // Check for TaskPriority in Task entity
  if (taskEntity.TaskPriority) {
    console.log('\nTaskPriority enum from Task.js:', taskEntity.TaskPriority);
  } else {
    console.log('\nTaskPriority enum is not available in Task.js');
  }
} catch (error) {
  console.error('Error importing from Task.js:', error);
}

try {
  console.log('\n\nTesting import from Project.js entity:');
  const projectEntity = require('../../packages/typeorm/dist/entities/Project.js');
  console.log('Available exports from Project.js:', Object.keys(projectEntity));
  
  // Check for ProjectStatus in Project entity
  if (projectEntity.ProjectStatus) {
    console.log('\nProjectStatus enum from Project.js:', projectEntity.ProjectStatus);
  } else {
    console.log('\nProjectStatus enum is not available in Project.js');
  }
} catch (error) {
  console.error('Error importing from Project.js:', error);
} 