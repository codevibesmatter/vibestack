// Simple test script to check imports
const typeorm = require('./packages/typeorm/dist/client-entities.js');

console.log('Imported typeorm package:');
console.log(Object.keys(typeorm));

// Try to access TaskStatus
console.log('\nTaskStatus enum value:');
console.log(typeorm.TaskStatus);

// Try to access TaskPriority
console.log('\nTaskPriority enum value:');
console.log(typeorm.TaskPriority); 