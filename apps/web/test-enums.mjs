// ES modules script to test importing enums from the TypeORM package
// We're using .mjs extension to explicitly use ES modules
console.log('Testing imports from TypeORM package...\n');

// Function to test imports
async function testImports() {
  // Try importing directly from client-entities
  try {
    console.log('Testing import from client-entities:');
    const clientEntitiesModule = await import('../../packages/typeorm/dist/client-entities.js');
    console.log('Available exports from client-entities:', Object.keys(clientEntitiesModule));
    
    // Check for TaskStatus
    if (clientEntitiesModule.TaskStatus) {
      console.log('\nTaskStatus enum from client-entities:', clientEntitiesModule.TaskStatus);
    } else {
      console.log('\nTaskStatus enum is not available in client-entities');
    }
    
    // Check for TaskPriority
    if (clientEntitiesModule.TaskPriority) {
      console.log('\nTaskPriority enum from client-entities:', clientEntitiesModule.TaskPriority);
    } else {
      console.log('\nTaskPriority enum is not available in client-entities');
    }
    
    // Check for ProjectStatus
    if (clientEntitiesModule.ProjectStatus) {
      console.log('\nProjectStatus enum from client-entities:', clientEntitiesModule.ProjectStatus);
    } else {
      console.log('\nProjectStatus enum is not available in client-entities');
    }
  } catch (error) {
    console.error('Error importing from client-entities:', error);
  }

  // Try importing directly from entity files
  try {
    console.log('\n\nTesting import from Task.js entity:');
    const taskEntityModule = await import('../../packages/typeorm/dist/entities/Task.js');
    console.log('Available exports from Task.js:', Object.keys(taskEntityModule));
    
    // Check for TaskStatus in Task entity
    if (taskEntityModule.TaskStatus) {
      console.log('\nTaskStatus enum from Task.js:', taskEntityModule.TaskStatus);
    } else {
      console.log('\nTaskStatus enum is not available in Task.js');
    }
    
    // Check for TaskPriority in Task entity
    if (taskEntityModule.TaskPriority) {
      console.log('\nTaskPriority enum from Task.js:', taskEntityModule.TaskPriority);
    } else {
      console.log('\nTaskPriority enum is not available in Task.js');
    }
  } catch (error) {
    console.error('Error importing from Task.js:', error);
  }

  try {
    console.log('\n\nTesting import from Project.js entity:');
    const projectEntityModule = await import('../../packages/typeorm/dist/entities/Project.js');
    console.log('Available exports from Project.js:', Object.keys(projectEntityModule));
    
    // Check for ProjectStatus in Project entity
    if (projectEntityModule.ProjectStatus) {
      console.log('\nProjectStatus enum from Project.js:', projectEntityModule.ProjectStatus);
    } else {
      console.log('\nProjectStatus enum is not available in Project.js');
    }
  } catch (error) {
    console.error('Error importing from Project.js:', error);
  }
}

// Run the tests
testImports().catch(err => console.error('Test failed:', err)); 