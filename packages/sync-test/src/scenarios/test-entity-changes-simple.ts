/**
 * Simple test script for entity changes module
 */
import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { createMixedChanges } from '../changes/entity-changes.ts';

// Load environment variables from .env file
config();

// Get database URL from environment
function getDatabaseURL(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return url;
}

async function testEntityChanges() {
  console.log('Testing entity changes module...');
  
  try {
    // Initialize database connection
    console.log('Initializing database connection...');
    const sql = neon(getDatabaseURL());
    
    // Verify connection
    console.log('Verifying database connection...');
    const connectionCheck = await sql`SELECT 1 as connection_test`;
    if (!connectionCheck || !Array.isArray(connectionCheck) || connectionCheck.length === 0) {
      throw new Error('Database connection verification failed');
    }
    console.log('Database connection verified successfully');
    
    // Create a small batch of changes (20 total)
    console.log('\nCreating mixed entity changes...');
    const results = await createMixedChanges(sql, 20, {
      task: 0.5,      // 50% tasks
      project: 0.2,   // 20% projects
      user: 0.2,      // 20% users
      comment: 0.1    // 10% comments
    });
    
    // Count total changes
    let totalChanges = 0;
    Object.entries(results).forEach(([entityType, result]) => {
      if (result) {
        const entityTotal = 
          (result.created?.length || 0) + 
          (result.updated?.length || 0) + 
          (result.deleted?.length || 0);
        
        console.log(`- ${entityType}: ${entityTotal} changes`);
        totalChanges += entityTotal;
      }
    });
    
    console.log(`\nTotal changes created: ${totalChanges}`);
    console.log('Test completed successfully');
    
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testEntityChanges()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  }); 