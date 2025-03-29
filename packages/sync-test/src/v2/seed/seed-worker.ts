import { faker } from '@faker-js/faker';
import { v4 as uuidv4 } from 'uuid';
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { EventEmitter } from 'events';
import type { SeedConfig, SeedMessage, SeedStats } from './types.ts';
import { DbRecord } from '../types.ts';
import { DB_TABLES } from '../config.ts';

// Load environment variables
dotenv.config();

// Define the SqlQueryFunction type based on what neon() returns
type SqlQueryFunction = ReturnType<typeof neon>;

export class SeedWorker extends EventEmitter {
  private seedConfig: SeedConfig | null = null;
  private seedStats: SeedStats = {
    userCount: 0,
    projectCount: 0,
    taskCount: 0,
    commentCount: 0,
    timeTaken: 0,
    entityTimings: {
      users: 0,
      projects: 0,
      tasks: 0,
      comments: 0
    }
  };
  private sql: SqlQueryFunction | null = null;

  constructor() {
    super();
    this.initialize();
  }

  private initialize(): void {
    try {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        throw new Error('DATABASE_URL environment variable is not set');
      }
      this.sql = neon(dbUrl);
      this.sendStatus('waiting');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendError(new Error(`Failed to initialize database connection: ${errorMessage}`));
    }
  }

  /**
   * Handle incoming messages
   */
  sendMessage(message: SeedMessage): void {
    if (message.type === 'initialize' && message.payload?.seedConfig) {
      this.seedConfig = message.payload.seedConfig;
    } else if (message.type === 'seed') {
      this.handleSeed(message);
    } else if (message.type === 'clear') {
      this.handleClear();
    }
  }

  /**
   * Send status updates
   */
  private sendStatus(status: 'processing' | 'waiting' | 'complete', current?: number, total?: number): void {
    this.emit('message', {
      type: 'status',
      payload: {
        status,
        current,
        total
      }
    });
  }

  /**
   * Send error messages
   */
  private sendError(error: Error): void {
    this.emit('message', {
      type: 'error',
      payload: {
        error
      }
    });
  }

  /**
   * Handle seed message
   */
  private async handleSeed(message: SeedMessage): Promise<void> {
    if (!this.seedConfig && message.payload?.seedConfig) {
      this.seedConfig = message.payload.seedConfig;
    }
    
    await this.seedData();
  }

  /**
   * Handle clear message
   */
  private async handleClear(): Promise<void> {
    await this.clearAllData();
  }

  /**
   * Clear all data from the database
   */
  private async clearAllData(): Promise<void> {
    if (!this.sql) {
      this.sendError(new Error('Database connection not initialized'));
      return;
    }
    
    this.sendStatus('processing');
    try {
      // Disable foreign key constraints temporarily for faster truncation
      await this.sql`SET session_replication_role = 'replica'`;
      
      // Truncate tables in reverse dependency order - using plural table names
      await this.sql`TRUNCATE TABLE "${DB_TABLES.COMMENTS}" CASCADE`;
      this.sendStatus('processing', 1, 4);
      
      await this.sql`TRUNCATE TABLE "${DB_TABLES.TASKS}" CASCADE`;
      this.sendStatus('processing', 2, 4);
      
      await this.sql`TRUNCATE TABLE "${DB_TABLES.PROJECTS}" CASCADE`;
      this.sendStatus('processing', 3, 4);
      
      await this.sql`TRUNCATE TABLE "${DB_TABLES.USERS}" CASCADE`;
      this.sendStatus('processing', 4, 4);
      
      // Also clear change history table if it exists
      try {
        await this.sql`TRUNCATE TABLE "change_history" CASCADE`;
      } catch (e) {
        // Ignore if table doesn't exist
      }
      
      // Re-enable foreign key constraints
      await this.sql`SET session_replication_role = 'origin'`;
      
      this.sendStatus('complete');
      this.emit('message', {
        type: 'clear_complete',
        payload: {}
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendError(new Error(`Error clearing data: ${errorMessage}`));
    }
  }

  /**
   * Seed the database with test data
   */
  private async seedData(): Promise<void> {
    if (!this.sql) {
      this.sendError(new Error('Database connection not initialized'));
      return;
    }
    
    if (!this.seedConfig) {
      this.sendError(new Error('Seed configuration not provided'));
      return;
    }
    
    // Reset stats
    this.seedStats = {
      userCount: 0,
      projectCount: 0,
      taskCount: 0,
      commentCount: 0,
      timeTaken: 0,
      entityTimings: {
        users: 0,
        projects: 0,
        tasks: 0,
        comments: 0
      }
    };
    
    const startTime = Date.now();
    
    try {
      // Verify connection
      try {
        const result = await this.sql`SELECT 1 as connection_test`;
        const testResult = result as DbRecord[];
        
        // Check if we got a valid result
        if (!testResult || testResult.length === 0 || 
            !testResult[0] || testResult[0].connection_test !== 1) {
          throw new Error('Database connection verification failed');
        }
      } catch (error) {
        throw new Error(`Database connection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      // Create users
      this.sendStatus('processing', 0, 4);
      const userStartTime = Date.now();
      await this.createUsers();
      this.seedStats.entityTimings.users = Date.now() - userStartTime;
      
      // Create projects
      this.sendStatus('processing', 1, 4);
      const projectStartTime = Date.now();
      await this.createProjects();
      this.seedStats.entityTimings.projects = Date.now() - projectStartTime;
      
      // Create tasks
      this.sendStatus('processing', 2, 4);
      const taskStartTime = Date.now();
      await this.createTasks();
      this.seedStats.entityTimings.tasks = Date.now() - taskStartTime;
      
      // Create comments
      this.sendStatus('processing', 3, 4);
      const commentStartTime = Date.now();
      await this.createComments();
      this.seedStats.entityTimings.comments = Date.now() - commentStartTime;
      
      // Calculate total time
      this.seedStats.timeTaken = Date.now() - startTime;
      
      // Send completion message with stats
      this.sendStatus('complete');
      this.emit('message', {
        type: 'seed_complete',
        payload: {
          stats: this.seedStats
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendError(new Error(`Error seeding data: ${errorMessage}`));
    }
  }
  
  /**
   * Create users in the database
   */
  private async createUsers(): Promise<void> {
    if (!this.sql || !this.seedConfig) return;
    
    const { userCount } = this.seedConfig;
    const batchSize = 10; // Insert users in smaller batches for better API compatibility
    const userIds: string[] = [];
    
    // Generate user data first
    const users = [];
    for (let i = 0; i < userCount; i++) {
      const userId = uuidv4();
      userIds.push(userId);
      
      users.push({
        id: userId,
        name: faker.person.fullName(),
        email: faker.internet.email(),
        role: faker.helpers.arrayElement(['ADMIN', 'USER', 'GUEST']),
        avatar_url: faker.image.avatar(),
        client_id: this.seedConfig.clientId,
        created_at: faker.date.past(),
        updated_at: new Date()
      });
    }
    
    // Insert users in batches
    for (let i = 0; i < users.length; i += batchSize) {
      const chunk = users.slice(i, i + batchSize);
      
      // Insert each user in the chunk - with correct plural table name
      for (const user of chunk) {
        await this.sql`
          INSERT INTO "${DB_TABLES.USERS}" (id, name, email, role, avatar_url, client_id, created_at, updated_at)
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
      
      this.seedStats.userCount += chunk.length;
      
      // Update progress occasionally
      if (i % (batchSize * 2) === 0 || i + batchSize >= users.length) {
        this.sendStatus('processing', 0, 4);
      }
    }
    
    return;
  }
  
  /**
   * Create projects in the database
   */
  private async createProjects(): Promise<void> {
    if (!this.sql || !this.seedConfig) return;
    
    const { projectsPerUser } = this.seedConfig;
    
    // Get all user IDs - with correct plural table name
    const userResult = await this.sql`SELECT id FROM "${DB_TABLES.USERS}"`;
    const users = userResult as DbRecord[];
    
    const userIds = users.map(user => user.id as string);
    const projectIds: string[] = [];
    const totalProjects = Math.ceil(userIds.length * projectsPerUser);
    const batchSize = 10;
    
    // Generate project data
    const projects = [];
    
    for (const userId of userIds) {
      // Each user creates some projects
      const numProjects = Math.round(faker.number.float({ 
        min: projectsPerUser * 0.5, 
        max: projectsPerUser * 1.5 
      }));
      
      for (let i = 0; i < numProjects; i++) {
        const projectId = uuidv4();
        projectIds.push(projectId);
        
        projects.push({
          id: projectId,
          name: faker.company.catchPhrase(),
          description: faker.lorem.paragraph(),
          status: faker.helpers.arrayElement(['ACTIVE', 'COMPLETED', 'ARCHIVED']),
          owner_id: userId,
          client_id: this.seedConfig.clientId,
          created_at: faker.date.past(),
          updated_at: new Date()
        });
      }
    }
    
    // Insert projects in batches
    for (let i = 0; i < projects.length; i += batchSize) {
      const chunk = projects.slice(i, i + batchSize);
      
      // Insert each project in the chunk - with correct plural table name
      for (const project of chunk) {
        await this.sql`
          INSERT INTO "${DB_TABLES.PROJECTS}" (id, name, description, status, owner_id, client_id, created_at, updated_at)
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
      
      this.seedStats.projectCount += chunk.length;
      
      // Update progress occasionally
      if (i % (batchSize * 4) === 0 || i + batchSize >= projects.length) {
        this.sendStatus('processing', 1, 4);
      }
    }
    
    return;
  }
  
  /**
   * Create tasks in the database
   */
  private async createTasks(): Promise<void> {
    if (!this.sql || !this.seedConfig) return;
    
    const { tasksPerProject, taskAssignmentRate } = this.seedConfig;
    
    // Get all project IDs - with correct plural table name
    const projectResult = await this.sql`SELECT id FROM "${DB_TABLES.PROJECTS}"`;
    const projects = projectResult as DbRecord[];
    
    // Get all user IDs for task assignment - with correct plural table name
    const userResult = await this.sql`SELECT id FROM "${DB_TABLES.USERS}"`;
    const users = userResult as DbRecord[];
    
    const projectIds = projects.map(project => project.id as string);
    const userIds = users.map(user => user.id as string);
    const taskIds: string[] = [];
    const totalTasks = Math.ceil(projectIds.length * tasksPerProject);
    const batchSize = 5;
    
    // Generate task data
    const tasks = [];
    
    for (const projectId of projectIds) {
      // Each project gets some tasks
      const numTasks = Math.round(faker.number.float({ 
        min: tasksPerProject * 0.5, 
        max: tasksPerProject * 1.5 
      }));
      
      for (let i = 0; i < numTasks; i++) {
        const taskId = uuidv4();
        taskIds.push(taskId);
        
        // Randomly assign a user to the task (or leave unassigned)
        let assigneeId: string | null = null;
        
        if (Math.random() < taskAssignmentRate && userIds.length > 0) {
          // Get a random user as assignee
          assigneeId = userIds[Math.floor(Math.random() * userIds.length)];
        }
        
        const tags = Array.from({ length: faker.number.int({ min: 0, max: 5 }) }, 
          () => faker.hacker.adjective()
        );
        
        tasks.push({
          id: taskId,
          title: faker.hacker.phrase().substring(0, 100),
          description: faker.lorem.paragraphs(2),
          status: faker.helpers.arrayElement(['TODO', 'IN_PROGRESS', 'DONE']),
          priority: faker.helpers.arrayElement(['LOW', 'MEDIUM', 'HIGH']),
          due_date: Math.random() > 0.3 ? faker.date.future() : null,
          completed_at: Math.random() > 0.7 ? faker.date.past() : null,
          tags: tags,
          project_id: projectId,
          assignee_id: assigneeId,
          client_id: this.seedConfig.clientId,
          created_at: faker.date.past(),
          updated_at: new Date()
        });
      }
    }
    
    // Insert tasks in batches
    for (let i = 0; i < tasks.length; i += batchSize) {
      const chunk = tasks.slice(i, i + batchSize);
      
      // Insert each task in the chunk - with correct plural table name
      for (const task of chunk) {
        await this.sql`
          INSERT INTO "${DB_TABLES.TASKS}" (
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
      
      this.seedStats.taskCount += chunk.length;
      
      // Update progress occasionally
      if (i % (batchSize * 10) === 0 || i + batchSize >= tasks.length) {
        this.sendStatus('processing', 2, 4);
      }
    }
    
    return;
  }
  
  /**
   * Create comments in the database
   */
  private async createComments(): Promise<void> {
    if (!this.sql || !this.seedConfig) return;
    
    const { commentsPerTask } = this.seedConfig;
    
    // Get all task IDs - with correct plural table name
    const taskResult = await this.sql`SELECT id FROM "${DB_TABLES.TASKS}"`;
    const tasks = taskResult as DbRecord[];
    
    // Get all user IDs for comment authors - with correct plural table name
    const userResult = await this.sql`SELECT id FROM "${DB_TABLES.USERS}"`;
    const users = userResult as DbRecord[];
    
    const taskIds = tasks.map(task => task.id as string);
    const userIds = users.map(user => user.id as string);
    
    // Only continue if we have users to author comments
    if (userIds.length === 0) {
      return;
    }
    
    const batchSize = 20;
    const comments = [];
    const primaryCommentIds: {[taskId: string]: string[]} = {};
    
    // Generate primary comments for tasks
    for (const taskId of taskIds) {
      // Each task gets some comments
      const numComments = Math.round(faker.number.float({ 
        min: commentsPerTask * 0.5, 
        max: commentsPerTask * 1.5 
      }));
      
      primaryCommentIds[taskId] = [];
      
      // Generate primary comments
      for (let i = 0; i < numComments; i++) {
        const commentId = uuidv4();
        primaryCommentIds[taskId].push(commentId);
        
        // Random user as author
        const authorId = userIds[Math.floor(Math.random() * userIds.length)];
        
        comments.push({
          id: commentId,
          content: faker.lorem.paragraph(),
          entity_type: 'task',
          entity_id: taskId,
          author_id: authorId,
          parent_id: null,
          created_at: faker.date.past(),
          updated_at: new Date()
        });
      }
      
      // Add some replies to comments (30% chance per comment)
      for (const parentId of primaryCommentIds[taskId]) {
        if (Math.random() < 0.3) {
          // Random user as reply author
          const replyAuthorId = userIds[Math.floor(Math.random() * userIds.length)];
          const replyId = uuidv4();
          
          comments.push({
            id: replyId,
            content: faker.lorem.paragraph(),
            entity_type: 'task',
            entity_id: taskId,
            author_id: replyAuthorId,
            parent_id: parentId,
            created_at: faker.date.past(),
            updated_at: new Date()
          });
        }
      }
    }
    
    // Insert comments in batches
    for (let i = 0; i < comments.length; i += batchSize) {
      const chunk = comments.slice(i, i + batchSize);
      
      // Insert each comment in the chunk - with correct plural table name
      for (const comment of chunk) {
        await this.sql`
          INSERT INTO "${DB_TABLES.COMMENTS}" (id, content, entity_type, entity_id, author_id, parent_id, created_at, updated_at)
          VALUES (
            ${comment.id}, 
            ${comment.content}, 
            ${comment.entity_type}, 
            ${comment.entity_id}, 
            ${comment.author_id}, 
            ${comment.parent_id}, 
            ${comment.created_at}, 
            ${comment.updated_at}
          )
        `;
      }
      
      this.seedStats.commentCount += chunk.length;
      
      // Update progress occasionally
      if (i % (batchSize * 5) === 0 || i + batchSize >= comments.length) {
        this.sendStatus('processing', 3, 4);
      }
    }
    
    return;
  }
} 