/**
 * Simple test that only creates and updates entities (no deletes)
 * This helps isolate issues with change tracking
 */

import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { faker } from '@faker-js/faker';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import readline from 'readline';
import { TaskStatus, TaskPriority } from '@repo/dataforge/server-entities';
import { DEFAULT_CONFIG } from '../config.js';

// Load environment variables from .env file
config();

// Define a type for the Neon client
type SqlQueryFunction = ReturnType<typeof neon>;

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Promisify readline question
function question(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer);
    });
  });
}

// Get database URL from environment
function getDatabaseURL(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return url;
}

/**
 * Initialize the replication system via HTTP endpoint
 */
async function initializeReplication(): Promise<boolean> {
  try {
    // Convert the WebSocket URL to the base HTTP URL
    const wsUrl = new URL(DEFAULT_CONFIG.wsUrl);
    const baseUrl = `http${wsUrl.protocol === 'wss:' ? 's' : ''}://${wsUrl.host}`;
    const initUrl = `${baseUrl}/api/replication/init`;
    
    console.log(`Initializing replication system via HTTP: ${initUrl}`);
    
    const response = await fetch(initUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.error(`Failed to initialize replication: ${response.status} ${response.statusText}`);
      return false;
    }
    
    const result = await response.json();
    console.log('Replication initialization successful:', result);
    
    return true;
  } catch (error) {
    console.error('Error initializing replication:', error);
    return false;
  }
}

/**
 * Get current replication LSN via HTTP endpoint
 */
async function getCurrentLSN(silent: boolean = false): Promise<string | null> {
  try {
    const wsUrl = new URL(DEFAULT_CONFIG.wsUrl);
    const baseUrl = `http${wsUrl.protocol === 'wss:' ? 's' : ''}://${wsUrl.host}`;
    const lsnUrl = `${baseUrl}/api/replication/lsn`;

    if (!silent) {
      console.log(`Fetching current replication LSN: ${lsnUrl}`);
    }

    const response = await fetch(lsnUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (!silent) {
        console.error(`Failed to fetch LSN: ${response.status} ${response.statusText}`);
      }
      return null;
    }

    const result = await response.json() as { lsn: string };
    if (!silent) {
      console.log('Current LSN:', result.lsn);
    }
    return result.lsn;
  } catch (error) {
    if (!silent) {
      console.error('Error fetching LSN:', error);
    }
    return null;
  }
}

/**
 * Create tasks with exact known attributes - no randomness
 */
async function createExactTasks(sql: SqlQueryFunction, count: number): Promise<string[]> {
  console.log(`Creating ${count} tasks with exact attributes...`);
  const taskIds: string[] = [];
  
  // Get a project ID to use
  let projectId: string;
  try {
    const projects = await sql`SELECT id FROM projects LIMIT 1`;
    if (projects && Array.isArray(projects) && projects.length > 0) {
      projectId = (projects[0] as { id: string }).id;
      console.log(`Using existing project ID: ${projectId}`);
    } else {
      // Create a project if none exists
      projectId = uuidv4();
      await sql`
        INSERT INTO projects (id, name, description, status, created_at, updated_at)
        VALUES (
          ${projectId},
          ${'Test Project'},
          ${'Project for WAL testing'},
          ${'active'},
          ${new Date()},
          ${new Date()}
        )
      `;
      console.log(`Created test project with ID: ${projectId}`);
    }
  } catch (error) {
    console.error('Error getting or creating project:', error);
    throw error;
  }
  
  // Create tasks one by one with predictable values
  for (let i = 0; i < count; i++) {
    const taskId = uuidv4();
    const title = `Task ${i + 1}`;
    const description = `Description for task ${i + 1}`;
    const status = 'todo'; // TaskStatus.TODO as string
    const priority = 'medium'; // TaskPriority.MEDIUM as string
    const now = new Date();
    
    try {
      await sql`
        INSERT INTO tasks (
          id, title, description, status, priority, project_id, created_at, updated_at
        ) VALUES (
          ${taskId}, 
          ${title}, 
          ${description}, 
          ${status}, 
          ${priority}, 
          ${projectId}, 
          ${now},
          ${now}
        )
      `;
      
      console.log(`Created task ${i + 1}/${count}: ${taskId}`);
      taskIds.push(taskId);
    } catch (error) {
      console.error(`Error creating task ${i + 1}:`, error);
      // Continue with other tasks
    }
  }
  
  return taskIds;
}

/**
 * Update tasks with exact known attributes - no randomness
 */
async function updateExactTasks(sql: SqlQueryFunction, taskIds: string[]): Promise<number> {
  const count = taskIds.length;
  console.log(`Updating ${count} tasks with exact attributes...`);
  let updatedCount = 0;
  
  for (let i = 0; i < count; i++) {
    const taskId = taskIds[i];
    const newTitle = `Updated Task ${i + 1}`;
    const newStatus = 'in_progress'; // TaskStatus.IN_PROGRESS as string
    const newPriority = 'high'; // TaskPriority.HIGH as string
    const now = new Date();
    
    try {
      await sql`
        UPDATE tasks 
        SET 
          title = ${newTitle}, 
          status = ${newStatus}, 
          priority = ${newPriority},
          updated_at = ${now}
        WHERE id = ${taskId}
      `;
      
      console.log(`Updated task ${i + 1}/${count}: ${taskId}`);
      updatedCount++;
    } catch (error) {
      console.error(`Error updating task ${i + 1}:`, error);
      // Continue with other tasks
    }
  }
  
  return updatedCount;
}

/**
 * Run the exact changes test
 */
async function runExactChangesTest() {
  console.log('========================================');
  console.log('🔍 Exact Changes Test (Create/Update Only)');
  console.log('========================================');
  
  let sql: SqlQueryFunction | undefined;
  
  try {
    // Initialize database connection
    console.log('Initializing database connection...');
    sql = neon(getDatabaseURL());
    
    // Verify connection
    console.log('Verifying database connection...');
    const connectionCheck = await sql`SELECT 1 as connection_test`;
    if (!connectionCheck || !Array.isArray(connectionCheck) || connectionCheck.length === 0) {
      throw new Error('Database connection verification failed');
    }
    console.log('Database connection verified successfully');
    
    // Initialize replication system
    console.log('\nInitializing replication system...');
    const initSuccess = await initializeReplication();
    if (!initSuccess) {
      console.error('Failed to initialize replication system');
      process.exit(1);
    }
    
    // Get current LSN as baseline
    const startLSN = await getCurrentLSN();
    if (!startLSN) {
      console.error('Failed to get starting LSN');
      process.exit(1);
    }
    console.log(`\nStarting LSN: ${startLSN}`);
    
    // Get batch size from user input
    let taskCount = 10; // Default size
    try {
      const countInput = await question('\nHow many tasks to create and update? ');
      const parsedCount = parseInt(countInput.trim(), 10);
      
      if (!isNaN(parsedCount) && parsedCount > 0) {
        taskCount = parsedCount;
      } else {
        console.warn('Invalid count. Using default of 10 tasks.');
      }
    } catch (inputError) {
      console.warn('Error getting input. Using default of 10 tasks.');
    }
    
    console.log(`\nRunning exact changes test with ${taskCount} tasks...`);
    
    // First create tasks
    console.time('create-tasks');
    const taskIds = await createExactTasks(sql, taskCount);
    console.timeEnd('create-tasks');
    console.log(`Created ${taskIds.length} tasks successfully`);
    
    // Wait for LSN advancement after creation
    console.log('\nChecking LSN after task creation...');
    const midLSN = await getCurrentLSN();
    if (midLSN && midLSN !== startLSN) {
      console.log(`LSN advanced after creation: ${startLSN} -> ${midLSN}`);
    } else {
      console.warn('LSN did not advance after task creation!');
    }
    
    // Then update tasks
    console.time('update-tasks');
    const updatedCount = await updateExactTasks(sql, taskIds);
    console.timeEnd('update-tasks');
    console.log(`Updated ${updatedCount} tasks successfully`);
    
    // Wait for LSN advancement after updates
    console.log('\nChecking LSN after task updates...');
    const finalLSN = await getCurrentLSN();
    if (finalLSN && finalLSN !== midLSN) {
      console.log(`LSN advanced after updates: ${midLSN} -> ${finalLSN}`);
    } else {
      console.warn('LSN did not advance after task updates!');
    }
    
    // Display results
    const totalChanges = taskIds.length + updatedCount;
    
    console.log('\n========================================');
    console.log('Exact Changes Test Results Summary');
    console.log('========================================');
    console.log(`Starting LSN: ${startLSN}`);
    console.log(`Mid LSN (after creation): ${midLSN || 'Unknown'}`);
    console.log(`Final LSN: ${finalLSN || 'Unknown'}`);
    console.log(`Tasks created: ${taskIds.length}`);
    console.log(`Tasks updated: ${updatedCount}`);
    console.log(`Total changes: ${totalChanges}`);
    console.log('========================================');
    
    if (finalLSN && finalLSN !== startLSN) {
      console.log('✅ Test completed successfully with LSN advancement');
    } else {
      console.log('❌ Test completed but LSN did not advance as expected');
    }
    
  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    // Close readline interface
    rl.close();
    
    // Close database connection if opened
    console.log('\nClosing database connection...');
    // No explicit close needed for Neon serverless
  }
}

// Run the test
console.log('Starting exact changes test...');
runExactChangesTest()
  .then(() => {
    console.log('Test completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  }); 