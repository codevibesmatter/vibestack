/**
 * Seed data generator for sync-test package
 * 
 * This module provides functionality to generate realistic interconnected test data
 * for testing sync operations with different dataset sizes.
 */

import { faker } from '@faker-js/faker';
import { v4 as uuidv4 } from 'uuid';
import { neon, neonConfig } from '@neondatabase/serverless';
import { 
  Task, TaskStatus, TaskPriority,
  Project, ProjectStatus,
  User, UserRole,
  Comment
} from '@repo/dataforge/server-entities';

// Define the SqlQueryFunction type based on what neon() returns
type SqlQueryFunction = ReturnType<typeof neon>;
type DbClient = SqlQueryFunction;

// Define batch sizes for different operations
const BATCH_SIZES = {
  users: 50,
  projects: 100,
  tasks: 200,
  comments: 500
};

/**
 * Configuration for seeding data
 */
export interface SeedConfig {
  userCount: number;          // Number of users to create
  projectsPerUser: number;    // Average projects owned per user
  tasksPerProject: number;    // Average tasks per project 
  commentsPerTask: number;    // Average comments per task
  memberAssignmentRate: number; // Probability (0-1) of adding a user as project member
  taskAssignmentRate: number; // Probability (0-1) of assigning a task to a user
  clientId?: string;          // Optional client ID to associate with entities
  progressInterval?: number;  // How often to show progress updates (in items)
}

/**
 * Preset configurations for different dataset sizes
 */
export const SEED_PRESETS = {
  small: {
    userCount: 25,
    projectsPerUser: 2,
    tasksPerProject: 8,
    commentsPerTask: 1,
    memberAssignmentRate: 0.6,
    taskAssignmentRate: 0.7,
    progressInterval: 5
  },
  medium: {
    userCount: 200,
    projectsPerUser: 1.5,
    tasksPerProject: 6,
    commentsPerTask: 2,
    memberAssignmentRate: 0.4,
    taskAssignmentRate: 0.6,
    progressInterval: 25
  },
  large: {
    userCount: 1000,
    projectsPerUser: 1.2,
    tasksPerProject: 4,
    commentsPerTask: 1.5,
    memberAssignmentRate: 0.3,
    taskAssignmentRate: 0.5,
    progressInterval: 100
  }
};

/**
 * Result of seed operation
 */
export interface SeedResult {
  metrics: {
    userCount: number;
    projectCount: number;
    taskCount: number;
    commentCount: number;
    timeTaken: number;
    entityTimings: {
      users: number;
      projects: number; 
      tasks: number;
      comments: number;
    };
  };
}

/**
 * Progress formatter helper - creates a progress bar and percentage display
 * with optional rate and ETA information
 * 
 * @param current Current progress value
 * @param total Total target value
 * @param startTime Start time in milliseconds (for rate calculation)
 * @param barLength Length of progress bar in characters
 * @returns Formatted progress string
 */
function formatProgress(
  current: number, 
  total: number, 
  startTime?: number, 
  barLength: number = 20
): string {
  // Ensure all numbers are valid and positive
  current = Math.max(0, current);
  total = Math.max(1, total); // Avoid division by zero
  const percentage = Math.min(100, Math.floor((current / total) * 100));
  
  // Calculate bar segments
  const filledLength = Math.min(barLength, Math.max(0, Math.floor((current / total) * barLength)));
  const emptyLength = Math.max(0, barLength - filledLength);
  
  // Create the bar
  const bar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
  
  // Basic progress text
  let progressText = `[${bar}] ${percentage}% (${current}/${total})`;
  
  // Add rate and ETA if start time is provided
  if (startTime && current > 0) {
    const elapsedMs = Math.max(1, Date.now() - startTime); // Prevent division by zero
    const itemsPerSecond = (current / elapsedMs) * 1000;
    const remainingItems = Math.max(0, total - current);
    
    // Only calculate ETA if we have a positive rate
    let etaText = 'calculating...';
    if (itemsPerSecond > 0) {
      const estimatedRemainingMs = remainingItems / itemsPerSecond * 1000;
      
      // Format ETA
      if (estimatedRemainingMs < 1000) {
        etaText = '<1s';
      } else if (estimatedRemainingMs < 60000) {
        etaText = `${Math.round(estimatedRemainingMs / 1000)}s`;
      } else if (estimatedRemainingMs < 3600000) {
        etaText = `${Math.floor(estimatedRemainingMs / 60000)}m ${Math.round((estimatedRemainingMs % 60000) / 1000)}s`;
      } else {
        etaText = `${Math.floor(estimatedRemainingMs / 3600000)}h ${Math.floor((estimatedRemainingMs % 3600000) / 60000)}m`;
      }
    }
    
    // Format rate
    const rateText = itemsPerSecond >= 1 
      ? `${itemsPerSecond.toFixed(1)}/s` 
      : `${(itemsPerSecond * 60).toFixed(1)}/min`;
    
    // Add rate and ETA to progress text
    progressText += ` • ${rateText} • ETA: ${etaText}`;
  }
  
  return progressText;
}

/**
 * Format time duration in milliseconds to human readable format
 */
function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

/**
 * Get database URL from environment variables
 */
export function getDatabaseURL(): string {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return process.env.DATABASE_URL;
}

/**
 * Seed database with interconnected test data
 * 
 * @param dbUrl Database URL
 * @param config Seed configuration
 * @returns Result summary
 */
export async function seedData(dbUrl: string, config: SeedConfig): Promise<SeedResult> {
  const startTime = Date.now();
  const entityTimings = {
    users: 0,
    projects: 0,
    tasks: 0,
    comments: 0
  };
  
  // Initialize the database client
  const sql = neon(dbUrl);
  
  // Verify connection
  try {
    const result = await sql`SELECT 1 as connection_test`;
    if (!result || !Array.isArray(result) || result.length === 0 || 
        !result[0] || (result[0] as any).connection_test !== 1) {
      throw new Error('Database connection verification failed');
    }
    console.log('✅ Database connection verified');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    throw error;
  }
  
  // Get progress interval or set default
  const progressInterval = config.progressInterval || 
    (config.userCount <= 50 ? 5 : 
     config.userCount <= 500 ? 50 : 100);
  
  // Initialize counters
  let userCount = 0;
  let projectCount = 0;
  let taskCount = 0;
  let commentCount = 0;
  
  // Generate users
  console.log(`\n🧑‍💼 Generating ${config.userCount} users...`);
  const userIds: string[] = [];
  const userStartTime = Date.now();
  
  // Prepare user data
  const users = [];
  
  for (let i = 0; i < config.userCount; i++) {
    const userId = uuidv4();
    userIds.push(userId);
    
    users.push({
      id: userId,
      name: faker.person.fullName(),
      email: faker.internet.email(),
      role: faker.helpers.arrayElement(Object.values(UserRole)),
      avatar_url: faker.image.avatar(),
      client_id: config.clientId,
      created_at: faker.date.past(),
      updated_at: new Date()
    });
    
    // Log progress during data generation
    if (i === 0 || (i + 1) % progressInterval === 0 || i + 1 === config.userCount) {
      process.stdout.write(`\r  Generating: ${formatProgress(i + 1, config.userCount, userStartTime)}`);
    }
  }
  console.log(); // New line after generation phase
  
  // Insert users in batches
  console.log(`  Inserting ${users.length} users into database...`);
  const insertStartTime = Date.now();
  const chunkSize = 10; // Process users in smaller chunks
  for (let i = 0; i < users.length; i += chunkSize) {
    const chunk = users.slice(i, i + chunkSize);
    
    // Insert each user in the chunk
    for (const user of chunk) {
      await sql`
        INSERT INTO users (id, name, email, role, avatar_url, client_id, created_at, updated_at)
        VALUES (
          ${user.id}, 
          ${user.name}, 
          ${user.email}, 
          ${user.role}, 
          ${user.avatar_url}, 
          ${user.client_id}, 
          ${user.created_at}, 
          ${user.updated_at}
        )
      `;
    }
    
    userCount += chunk.length;
    
    // Update progress after each chunk
    process.stdout.write(`\r  Inserting: ${formatProgress(userCount, users.length, insertStartTime)}`);
  }
  
  // Final progress update
  process.stdout.write(`\r  Inserted: ${formatProgress(userCount, users.length, insertStartTime)}  \n`);
  
  entityTimings.users = Date.now() - userStartTime;
  console.log(`✅ Created ${userCount} users in ${formatTime(entityTimings.users)}`);
  
  // Estimate project count for progress tracking
  const estimatedProjectCount = Math.round(config.userCount * config.projectsPerUser);
  
  // Generate projects
  console.log(`\n🏢 Generating projects (est. ${estimatedProjectCount})...`);
  const projectIds: string[] = [];
  const projectStartTime = Date.now();
  let projectProgressCount = 0;
  
  // Prepare project data
  const projects = [];
  
  for (const userId of userIds) {
    // Each user creates some projects
    const numProjects = Math.round(faker.number.float({ 
      min: config.projectsPerUser * 0.5, 
      max: config.projectsPerUser * 1.5 
    }));
    
    for (let i = 0; i < numProjects; i++) {
      const projectId = uuidv4();
      projectIds.push(projectId);
      
      projects.push({
        id: projectId,
        name: faker.company.catchPhrase(),
        description: faker.lorem.paragraph(),
        status: faker.helpers.arrayElement(Object.values(ProjectStatus)),
        owner_id: userId,
        client_id: config.clientId,
        created_at: faker.date.past(),
        updated_at: new Date()
      });
      
      projectProgressCount++;
      
      // Log progress at intervals or for the last item
      if (projectProgressCount === 1 || 
          projectProgressCount % progressInterval === 0 || 
          projectProgressCount === estimatedProjectCount) {
        process.stdout.write(`\r  Generating: ${formatProgress(projectProgressCount, estimatedProjectCount, projectStartTime)}`);
      }
    }
  }
  console.log(); // New line after generation phase
  
  // Insert projects in batches
  console.log(`  Inserting ${projects.length} projects into database...`);
  const projectInsertStartTime = Date.now();
  const projectChunkSize = 10; // Process projects in smaller chunks
  projectCount = 0; // Reset counter
  for (let i = 0; i < projects.length; i += projectChunkSize) {
    const chunk = projects.slice(i, i + projectChunkSize);
    
    // Insert each project in the chunk
    for (const project of chunk) {
      await sql`
        INSERT INTO projects (id, name, description, status, owner_id, client_id, created_at, updated_at)
        VALUES (
          ${project.id}, 
          ${project.name}, 
          ${project.description}, 
          ${project.status}, 
          ${project.owner_id}, 
          ${project.client_id}, 
          ${project.created_at}, 
          ${project.updated_at}
        )
      `;
    }
    
    projectCount += chunk.length;
    
    // Update progress after each chunk
    process.stdout.write(`\r  Inserting: ${formatProgress(projectCount, projects.length, projectInsertStartTime)}`);
  }
  
  // Final progress update
  process.stdout.write(`\r  Inserted: ${formatProgress(projectCount, projects.length, projectInsertStartTime)}  \n`);
  
  entityTimings.projects = Date.now() - projectStartTime;
  console.log(`✅ Created ${projectCount} projects in ${formatTime(entityTimings.projects)}`);
  
  // Estimate task count for progress tracking
  const estimatedTaskCount = Math.round(projectCount * config.tasksPerProject);
  
  // Generate tasks
  console.log(`\n📝 Generating tasks (est. ${estimatedTaskCount})...`);
  const taskIds: string[] = [];
  const taskStartTime = Date.now();
  let taskProgressCount = 0;
  
  // Prepare task data
  const tasks = [];
  
  for (const projectId of projectIds) {
    // Each project gets some tasks
    const numTasks = Math.round(faker.number.float({ 
      min: config.tasksPerProject * 0.5, 
      max: config.tasksPerProject * 1.5 
    }));
    
    for (let i = 0; i < numTasks; i++) {
      const taskId = uuidv4();
      taskIds.push(taskId);
      
      // Randomly assign a user to the task (or leave unassigned)
      let assigneeId: string | null = null;
      
      if (Math.random() < config.taskAssignmentRate) {
        // Get a random user as assignee
        assigneeId = faker.helpers.arrayElement(userIds);
      }
      
      const tags = Array.from({ length: faker.number.int({ min: 0, max: 5 }) }, 
        () => faker.hacker.adjective()
      );
      
      tasks.push({
        id: taskId,
        title: faker.hacker.phrase().substring(0, 100),
        description: faker.lorem.paragraphs(2),
        status: faker.helpers.arrayElement(Object.values(TaskStatus)),
        priority: faker.helpers.arrayElement(Object.values(TaskPriority)),
        due_date: Math.random() > 0.3 ? faker.date.future() : null,
        completed_at: Math.random() > 0.7 ? faker.date.past() : null,
        tags: tags,
        project_id: projectId,
        assignee_id: assigneeId,
        client_id: config.clientId,
        created_at: faker.date.past(),
        updated_at: new Date()
      });
      
      taskProgressCount++;
      
      // Log progress at intervals or for the last item
      if (taskProgressCount === 1 || 
          taskProgressCount % (progressInterval * 2) === 0 || 
          taskProgressCount === estimatedTaskCount) {
        process.stdout.write(`\r  Generating: ${formatProgress(taskProgressCount, estimatedTaskCount, taskStartTime)}`);
      }
    }
  }
  console.log(); // New line after generation phase
  
  // Insert tasks in batches
  console.log(`  Inserting ${tasks.length} tasks into database...`);
  const taskInsertStartTime = Date.now();
  const taskChunkSize = 5; // Process tasks in smaller chunks
  taskCount = 0; // Reset counter
  for (let i = 0; i < tasks.length; i += taskChunkSize) {
    const chunk = tasks.slice(i, i + taskChunkSize);
    
    // Insert each task in the chunk
    for (const task of chunk) {
      await sql`
        INSERT INTO tasks (
          id, title, description, status, priority, due_date, completed_at, 
          tags, project_id, assignee_id, client_id, created_at, updated_at
        ) VALUES (
          ${task.id}, 
          ${task.title}, 
          ${task.description}, 
          ${task.status}, 
          ${task.priority}, 
          ${task.due_date}, 
          ${task.completed_at}, 
          ${task.tags}, 
          ${task.project_id}, 
          ${task.assignee_id}, 
          ${task.client_id}, 
          ${task.created_at},
          ${task.updated_at}
        )
      `;
    }
    
    taskCount += chunk.length;
    
    // Update progress after each chunk
    process.stdout.write(`\r  Inserting: ${formatProgress(taskCount, tasks.length, taskInsertStartTime)}`);
  }
  
  // Final progress update
  process.stdout.write(`\r  Inserted: ${formatProgress(taskCount, tasks.length, taskInsertStartTime)}  \n`);
  
  entityTimings.tasks = Date.now() - taskStartTime;
  console.log(`✅ Created ${taskCount} tasks in ${formatTime(entityTimings.tasks)}`);
  
  // Estimate comment count for progress tracking
  const estimatedCommentCount = Math.round(taskCount * config.commentsPerTask * 1.3); // Accounting for replies
  
  // Generate comments
  console.log(`\n💬 Generating comments (est. ${estimatedCommentCount})...`);
  const commentStartTime = Date.now();
  let commentProgressCount = 0;
  
  // Prepare comment data
  const comments = [];
  
  for (const taskId of taskIds) {
    // Each task gets some comments
    const numComments = Math.round(faker.number.float({ 
      min: config.commentsPerTask * 0.5, 
      max: config.commentsPerTask * 1.5 
    }));
    
    // Generate primary comments
    const primaryCommentIds: string[] = [];
    for (let i = 0; i < numComments; i++) {
      const commentId = uuidv4();
      primaryCommentIds.push(commentId);
      
      // Random user as author
      const authorId = faker.helpers.arrayElement(userIds);
      
      comments.push({
        id: commentId,
        content: faker.lorem.paragraph(),
        entityType: 'task',
        entityId: taskId,
        authorId: authorId,
        parentId: null,
        createdAt: faker.date.past(),
        updatedAt: new Date()
      });
      
      commentProgressCount++;
      
      // Log progress at intervals
      if (commentProgressCount === 1 || 
          commentProgressCount % (progressInterval * 5) === 0 || 
          commentProgressCount === estimatedCommentCount) {
        process.stdout.write(`\r  Generating: ${formatProgress(commentProgressCount, estimatedCommentCount, commentStartTime)}`);
      }
    }
    
    // Add some replies to comments (30% chance per comment)
    for (const parentId of primaryCommentIds) {
      if (Math.random() < 0.3) {
        // Random user as reply author
        const replyAuthorId = faker.helpers.arrayElement(userIds);
        const replyId = uuidv4();
        
        comments.push({
          id: replyId,
          content: faker.lorem.paragraph(),
          entityType: 'task',
          entityId: taskId,
          authorId: replyAuthorId,
          parentId: parentId,
          createdAt: faker.date.past(),
          updatedAt: new Date()
        });
        
        commentProgressCount++;
        
        // Log progress at intervals (less frequently for replies)
        if (commentProgressCount % (progressInterval * 10) === 0 || 
            commentProgressCount === estimatedCommentCount) {
          process.stdout.write(`\r  Generating: ${formatProgress(commentProgressCount, estimatedCommentCount, commentStartTime)}`);
        }
      }
    }
  }
  
  // Insert comments in batches
  console.log(`  Inserting ${comments.length} comments into database...`);
  const commentInsertStartTime = Date.now();
  const commentChunkSize = 20; // Process comments in smaller chunks
  commentCount = 0; // Reset counter
  for (let i = 0; i < comments.length; i += commentChunkSize) {
    const chunk = comments.slice(i, i + commentChunkSize);
    
    // Insert each comment in the chunk
    for (const comment of chunk) {
      await sql`
        INSERT INTO comments (id, content, "entityType", "entityId", "authorId", "parentId", "createdAt", "updatedAt")
        VALUES (
          ${comment.id}, 
          ${comment.content}, 
          ${comment.entityType}, 
          ${comment.entityId}, 
          ${comment.authorId}, 
          ${comment.parentId}, 
          ${comment.createdAt}, 
          ${comment.updatedAt}
        )
      `;
    }
    
    commentCount += chunk.length;
    
    // Update progress after each chunk
    process.stdout.write(`\r  Inserting: ${formatProgress(commentCount, comments.length, commentInsertStartTime)}`);
  }
  
  // Final progress update
  process.stdout.write(`\r  Inserted: ${formatProgress(commentCount, comments.length, commentInsertStartTime)}  \n`);
  
  entityTimings.comments = Date.now() - commentStartTime;
  console.log(`✅ Created ${commentCount} comments in ${formatTime(entityTimings.comments)}`);
  
  // Calculate time taken
  const timeTaken = Date.now() - startTime;
  
  // Return summary
  return {
    metrics: {
      userCount,
      projectCount,
      taskCount,
      commentCount,
      timeTaken,
      entityTimings
    }
  };
}

/**
 * Clear all data from the database
 * Useful before seeding to start with a clean slate
 * 
 * @param dbUrl Database URL
 */
export async function clearAllData(dbUrl: string): Promise<void> {
  console.log('🔄 Clearing all existing data...');
  
  // Initialize the database client
  const sql = neon(dbUrl);
  
  try {
    // Clear in reverse order of dependencies
    console.log('  Truncating comments table...');
    await sql`TRUNCATE TABLE comments CASCADE`;
    
    console.log('  Truncating tasks table...');
    await sql`TRUNCATE TABLE tasks CASCADE`;
    
    console.log('  Truncating projects table...');
    await sql`TRUNCATE TABLE projects CASCADE`;
    
    console.log('  Truncating users table...');
    await sql`TRUNCATE TABLE users CASCADE`;
    
    console.log('  Truncating change_history table...');
    await sql`TRUNCATE TABLE change_history CASCADE`;
    
    console.log('✅ Cleared all existing data');
  } catch (error) {
    console.error('❌ Error clearing data:', error);
    throw error;
  }
} 