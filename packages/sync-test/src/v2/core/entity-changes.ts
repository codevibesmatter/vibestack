/**
 * Enhanced entity changes implementation for testing WAL processing
 * Based on the schema and patterns from the seed module
 */

import { faker } from '@faker-js/faker';
import { v4 as uuidv4 } from 'uuid';
import { 
  TaskStatus, TaskPriority,
  ProjectStatus,
  UserRole,
  User, Project, Task, Comment
} from '@repo/dataforge/server-entities';
import { ENTITY_OPERATIONS } from '../config.ts';

// Define the SqlQueryFunction type based on what neon() returns
type SqlQueryFunction = any;

// Supported entity types
export type EntityType = 'task' | 'project' | 'user' | 'comment';

// Entity interfaces for type safety - matching the dataforge entity structure
interface TaskData {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date?: Date | null;
  completed_at?: Date | null;
  tags: string[];
  project_id: string;
  assignee_id?: string | null;
  client_id?: string;
  created_at: Date;
  updated_at: Date;
}

interface ProjectData {
  id: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  owner_id: string;
  client_id?: string;
  created_at: Date;
  updated_at: Date;
}

interface UserData {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatar_url?: string;
  client_id?: string;
  created_at: Date;
  updated_at: Date;
}

interface CommentData {
  id: string;
  content: string;
  entityType: string;
  entityId: string;
  authorId: string;
  parentId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Add these interfaces at the top of the file near the other interfaces
interface CommentRecord {
  id: string;
  parentId: string | null;
  entityType?: string;
  entityId?: string;
  authorId?: string;
}

/**
 * Create a batch of entity changes in the database
 * Using the same schema and patterns as the seed module
 */
export async function createBulkEntityChanges(
  sql: SqlQueryFunction,
  entityType: EntityType,
  count: number
): Promise<string[]> {
  console.log(`Creating ${count} ${entityType} changes...`);
  
  switch (entityType) {
    case 'task': 
      return createBulkTasks(sql, count);
    case 'project':
      return createBulkProjects(sql, count);
    case 'user':
      return createBulkUsers(sql, count);
    case 'comment':
      return createBulkComments(sql, count);
    default:
      throw new Error(`Unsupported entity type: ${entityType}`);
  }
}

/**
 * Update a batch of existing entities
 */
export async function updateBulkEntityChanges(
  sql: SqlQueryFunction,
  entityType: EntityType,
  count: number
): Promise<string[]> {
  console.log(`Updating ${count} ${entityType}s...`);
  
  switch (entityType) {
    case 'task': 
      return updateBulkTasks(sql, count);
    case 'project':
      return updateBulkProjects(sql, count);
    case 'user':
      return updateBulkUsers(sql, count);
    case 'comment':
      return updateBulkComments(sql, count);
    default:
      throw new Error(`Unsupported entity type: ${entityType}`);
  }
}

/**
 * Delete a batch of existing entities
 */
export async function deleteBulkEntityChanges(
  sql: SqlQueryFunction,
  entityType: EntityType,
  count: number
): Promise<string[]> {
  console.log(`Deleting ${count} ${entityType}s...`);
  
  // For delete operations we'll use a smaller count to avoid excessive cascading
  const effectiveCount = Math.min(count, 5); // Limit deletes to 5 per batch for safety
  
  // Handle entity dependencies based on relationship hierarchy
  try {
    // Create a proper deletion strategy based on entity type
    switch (entityType) {
      case 'comment':
        return deleteComments(sql, effectiveCount);
      case 'task':
        return deleteTasks(sql, effectiveCount);
      case 'project':
        return deleteProjects(sql, effectiveCount);
      case 'user':
        return deleteUsers(sql, effectiveCount);
      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  } catch (error) {
    console.error(`Error deleting ${entityType}s:`, error);
    throw error;
  }
}

/**
 * Create a balanced mix of create, update, and delete operations
 */
export async function createMixedEntityChanges(
  sql: SqlQueryFunction,
  entityType: EntityType,
  count: number, 
  operations: {create: number, update: number, delete: number} = {create: 0.45, update: 0.45, delete: 0.1}
): Promise<{created: string[], updated: string[], deleted: string[]}> {
  // Calculate counts for each operation type
  const createCount = Math.floor(count * operations.create);
  const updateCount = Math.floor(count * operations.update);
  const deleteCount = count - createCount - updateCount;
  
  console.log(`Creating balanced mix of ${entityType} changes: ${createCount} creates, ${updateCount} updates, ${deleteCount} deletes`);
  
  // Execute operations sequentially to allow connection pool to be released between operations
  let created: string[] = [];
  let updated: string[] = [];
  let deleted: string[] = [];
  
  if (createCount > 0) {
    created = await createBulkEntityChanges(sql, entityType, createCount);
    // Small delay to ensure connection is properly released
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  if (updateCount > 0) {
    updated = await updateBulkEntityChanges(sql, entityType, updateCount);
    // Small delay to ensure connection is properly released
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  if (deleteCount > 0) {
    deleted = await deleteBulkEntityChanges(sql, entityType, deleteCount);
    // Small delay to ensure connection is properly released
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  // Generate duplicate changes to test deduplication with scaled approach based on count
  const duplicates: string[] = [];
  
  // Make additional changes to recently created records (if any)
  if (created.length >= 2) {
    // Choose at least 2 created records to update again (for deduplication testing)
    // Limit the duplicate count to a reasonable maximum of 8 to avoid excessive load
    const dupeRecordCount = Math.min(8, Math.min(created.length, Math.max(2, Math.floor(created.length * 0.3))));
    const recordsToUpdate = created.slice(0, dupeRecordCount);
    console.log(`Creating duplicate changes for ${recordsToUpdate.length} ${entityType}s to test deduplication`);
    
    // Update these records in smaller batches to avoid connection pooling issues
    const batchSize = 2;
    for (let i = 0; i < recordsToUpdate.length; i += batchSize) {
      const batch = recordsToUpdate.slice(i, i + batchSize);
      for (const id of batch) {
        try {
          const duplicateUpdates = await updateEntityRecord(sql, entityType, id);
          if (duplicateUpdates.length > 0) {
            duplicates.push(...duplicateUpdates);
          }
        } catch (error) {
          console.error(`Error creating duplicate update for ${entityType} ${id}:`, error);
        }
      }
      // Small delay between batches to ensure connection release
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } else if (updated.length >= 2) {
    // If no creates, use updates
    const recordsToUpdateAgain = updated.slice(0, Math.min(updated.length, Math.max(2, Math.floor(updated.length * 0.3))));
    console.log(`Creating duplicate changes for ${recordsToUpdateAgain.length} ${entityType}s to test deduplication`);
    
    for (const id of recordsToUpdateAgain) {
      try {
        const duplicateUpdates = await updateEntityRecord(sql, entityType, id);
        if (duplicateUpdates.length > 0) {
          duplicates.push(...duplicateUpdates);
          updated.push(...duplicateUpdates); // Add to updated list
        }
      } catch (error) {
        console.error(`Error creating duplicate update for ${entityType} ${id}:`, error);
      }
    }
  }
  
  if (duplicates.length > 0) {
    console.log(`Created ${duplicates.length} duplicate changes for ${entityType} deduplication testing`);
  }
  
  console.log(`Completed mixed ${entityType} changes: ${created.length} creates, ${updated.length} updates, ${deleted.length} deletes`);
  
  return {
    created,
    updated,
    deleted
  };
}

/**
 * Update a specific entity record to create duplicate changes
 * Helper function for deduplication testing
 */
async function updateEntityRecord(
  sql: SqlQueryFunction,
  entityType: EntityType,
  id: string
): Promise<string[]> {
  switch (entityType) {
    case 'task':
      return updateTaskRecord(sql, id);
    case 'project':
      return updateProjectRecord(sql, id);
    case 'user':
      return updateUserRecord(sql, id);
    case 'comment':
      return updateCommentRecord(sql, id);
    default:
      return [];
  }
}

/**
 * Update a task record with a minimal change to test deduplication
 */
async function updateTaskRecord(sql: SqlQueryFunction, id: string): Promise<string[]> {
  try {
    // First get the current title to check its length
    const currentTasks = await sql`SELECT title FROM tasks WHERE id = ${id}`;
    if (!currentTasks || currentTasks.length === 0) {
      console.warn(`Task not found for ID: ${id}`);
      return [];
    }
    
    const currentTitle = currentTasks[0].title || '';
    
    // Calculate safe update strings based on available space (limit is 100 chars)
    const maxLength = 100;
    const update1 = ' (U1)'; // Shortened update marker
    const update2 = ' (U2)'; // Shortened update marker
    
    let newTitle1, newTitle2;
    
    if (currentTitle.length + update1.length > maxLength) {
      // If current title is already close to the limit, truncate it
      newTitle1 = currentTitle.substring(0, maxLength - update1.length) + update1;
    } else {
      newTitle1 = currentTitle + update1;
    }
    
    if (newTitle1.length + update2.length - update1.length > maxLength) {
      // If after first update we'd exceed limit, truncate again
      newTitle2 = newTitle1.substring(0, maxLength - update2.length + update1.length) + update2;
    } else {
      // Replace update1 marker with update2
      newTitle2 = newTitle1.replace(update1, update2);
    }
    
    // Make two distinct updates to the same record with minor differences
    // First update with safe title
    await sql`
      UPDATE tasks 
      SET title = ${newTitle1},
          status = ${faker.helpers.arrayElement(Object.values(TaskStatus))}
      WHERE id = ${id}
    `;
    
    // Second update to same record with safe title
    await sql`
      UPDATE tasks 
      SET title = ${newTitle2},
          priority = ${faker.helpers.arrayElement(Object.values(TaskPriority))}
      WHERE id = ${id}
    `;
    
    return [id, id]; // Return the ID twice to represent two updates
  } catch (error) {
    console.error(`Error updating task record ${id}:`, error);
    return [];
  }
}

/**
 * Update a project record with a minimal change to test deduplication
 */
async function updateProjectRecord(sql: SqlQueryFunction, id: string): Promise<string[]> {
  try {
    // First update
    await sql`
      UPDATE projects 
      SET name = CONCAT(name, ' (Updated 1)'),
          status = ${faker.helpers.arrayElement(Object.values(ProjectStatus))}
      WHERE id = ${id}
    `;
    
    // Second update to same record
    await sql`
      UPDATE projects 
      SET name = CONCAT(name, ' (Updated 2)'),
          description = CONCAT(description, ' With additional details.')
      WHERE id = ${id}
    `;
    
    return [id, id]; // Return the ID twice to represent two updates
  } catch (error) {
    console.error(`Error updating project record ${id}:`, error);
    return [];
  }
}

/**
 * Update a user record with a minimal change to test deduplication
 */
async function updateUserRecord(sql: SqlQueryFunction, id: string): Promise<string[]> {
  try {
    // First update
    await sql`
      UPDATE users 
      SET name = CONCAT(name, ' (Updated 1)'),
          role = ${faker.helpers.arrayElement(Object.values(UserRole))}
      WHERE id = ${id}
    `;
    
    // Second update to same record
    await sql`
      UPDATE users 
      SET name = CONCAT(name, ' (Updated 2)'),
          avatar_url = ${faker.internet.avatar()}
      WHERE id = ${id}
    `;
    
    return [id, id]; // Return the ID twice to represent two updates
  } catch (error) {
    console.error(`Error updating user record ${id}:`, error);
    return [];
  }
}

/**
 * Update a comment record with a minimal change to test deduplication
 */
async function updateCommentRecord(sql: SqlQueryFunction, id: string): Promise<string[]> {
  try {
    // First update
    await sql`
      UPDATE comments 
      SET content = CONCAT(content, ' (Updated 1)')
      WHERE id = ${id}
    `;
    
    // Second update to same record
    await sql`
      UPDATE comments 
      SET content = CONCAT(content, ' (Updated 2)')
      WHERE id = ${id}
    `;
    
    return [id, id]; // Return the ID twice to represent two updates
  } catch (error) {
    console.error(`Error updating comment record ${id}:`, error);
    return [];
  }
}

/**
 * Create multiple entity types mixed together
 * This is the most realistic scenario for testing WAL processing
 */
export async function createMixedChanges(
  sql: SqlQueryFunction,
  count: number,
  distribution: {[key in EntityType]?: number} = {task: 0.5, project: 0.2, user: 0.2, comment: 0.1}
): Promise<{[key in EntityType]?: {created: string[], updated: string[], deleted: string[]}}> {
  // Validate distribution
  const distSum = Object.values(distribution).reduce((acc, val) => acc + val, 0);
  if (Math.abs(distSum - 1) > 0.0001) {
    console.warn(`Distribution sum (${distSum}) is not 1, normalizing...`);
    // Normalize
    const normFactor = 1 / distSum;
    Object.keys(distribution).forEach(key => {
      const typedKey = key as EntityType;
      distribution[typedKey] = (distribution[typedKey] || 0) * normFactor;
    });
  }
  
  // Calculate entity counts based on distribution
  const entityCounts: {[key in EntityType]?: number} = {};
  const entityTypes = Object.keys(distribution) as EntityType[];
  let remaining = count;
  
  // Distribute values
  for (let i = 0; i < entityTypes.length; i++) {
    const type = entityTypes[i];
    const isLast = i === entityTypes.length - 1;
    
    if (isLast) {
      // Last item gets whatever is left
      entityCounts[type] = remaining;
    } else {
      // Calculate count based on distribution
      const entityCount = Math.max(1, Math.floor(count * (distribution[type] || 0)));
      entityCounts[type] = entityCount;
      remaining -= entityCount;
    }
  }
  
  // Default operations distribution
  const operations = {
    create: ENTITY_OPERATIONS.OPERATION_DISTRIBUTION.create,
    update: ENTITY_OPERATIONS.OPERATION_DISTRIBUTION.update,
    delete: ENTITY_OPERATIONS.OPERATION_DISTRIBUTION.delete
  };
  
  // Create and track changes
  const changes: {[key in EntityType]?: {
    created: string[], 
    updated: string[], 
    deleted: string[]
  }} = {};
  
  // Process each entity type sequentially - avoid connection pool exhaustion
  for (const entityType of entityTypes) {
    if (entityCounts[entityType] && entityCounts[entityType]! > 0) {
      console.log(`Creating mixed changes for ${entityType}, count: ${entityCounts[entityType]}`);
      
      // Create changes for this entity type
      changes[entityType] = await createMixedEntityChanges(
        sql, 
        entityType,
        entityCounts[entityType]!,
        operations
      );
      
      // Allow connection pool to clear between entity types
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return changes;
}

/**
 * Generate a set of mixed changes in memory without database interaction
 * @param count Total number of changes to generate
 * @param distribution Distribution of changes across entity types
 * @param operations Distribution of operations (create, update, delete)
 * @returns Generated changes object
 */
export async function generateMixedChangesInMemory(
  count: number,
  distribution: {[key in EntityType]?: number} = {task: 0.5, project: 0.2, user: 0.2, comment: 0.1},
  operations: {create: number, update: number, delete: number} = {create: 0.45, update: 0.45, delete: 0.1}
): Promise<{
  changes: {
    [key in EntityType]?: {
      create: any[],
      update: any[],
      delete: any[]
    }
  },
  count: number
}> {
  console.log(`Generating ${count} mixed changes in memory (no database interaction)`);
  
  // Normalize the distribution to make sure it sums to 1
  const totalWeight = Object.values(distribution).reduce((sum, weight) => sum + weight, 0);
  const normalizedDist = Object.fromEntries(
    Object.entries(distribution).map(([key, weight]) => [key, weight / totalWeight])
  ) as {[key in EntityType]?: number};
  
  // Calculate counts per entity type
  const entityCounts: {[key in EntityType]?: number} = {};
  let remainingCount = count;
  
  Object.entries(normalizedDist).forEach(([entityType, weight], index, arr) => {
      if (index === arr.length - 1) {
      // Last item gets remainder to ensure total count is exact
      entityCounts[entityType as EntityType] = remainingCount;
      } else {
      const entityCount = Math.floor(count * (weight ?? 0));
      entityCounts[entityType as EntityType] = entityCount;
      remainingCount -= entityCount;
    }
  });
  
  // Initialize result structure
  const result: {
    changes: {
      [key in EntityType]?: {
        create: any[],
        update: any[],
        delete: any[]
      }
    },
    count: number
  } = {
    changes: {},
    count: 0
  };
  
  // Generate changes for each entity type
  for (const [entityType, entityCount] of Object.entries(entityCounts)) {
    if (!entityCount) continue;
    
    const typedEntityType = entityType as EntityType;
    console.log(`Generating ${entityCount} in-memory changes for ${typedEntityType}`);
    
    // Initialize entity type in results
    result.changes[typedEntityType] = {
      create: [],
      update: [],
      delete: []
    };
    
    // Calculate operation counts
    const createCount = Math.floor(entityCount * operations.create);
    const updateCount = Math.floor(entityCount * operations.update);
    const deleteCount = entityCount - createCount - updateCount;
    
    // Generate create operations
    for (let i = 0; i < createCount; i++) {
      const fakeData = generateFakeEntityData(typedEntityType);
      result.changes[typedEntityType]!.create.push(fakeData);
    }
    
    // Generate update operations (with fake IDs since we won't query the DB)
    for (let i = 0; i < updateCount; i++) {
      const fakeData = generateFakeEntityData(typedEntityType);
      result.changes[typedEntityType]!.update.push(fakeData);
    }
    
    // Generate delete operations (just fake IDs)
    for (let i = 0; i < deleteCount; i++) {
      const fakeId = generateFakeId();
      result.changes[typedEntityType]!.delete.push({ id: fakeId });
    }
    
    // Update total count
    result.count += createCount + updateCount + deleteCount;
  }
  
  console.log(`Successfully generated ${result.count} changes in memory`);
  return result;
}

/**
 * Generate fake entity data for a specific entity type
 * @param entityType Type of entity to generate data for
 * @returns Fake entity data with ID
 */
export function generateFakeEntityData(entityType: EntityType): any {
  const id = generateFakeId();
  
  switch (entityType) {
    case 'task':
      return generateFakeTaskData(id);
    case 'project':
      return generateFakeProjectData(id);
    case 'user':
      return generateFakeUserData(id);
    case 'comment':
      return generateFakeCommentData(id);
    default:
      throw new Error(`Unsupported entity type: ${entityType}`);
  }
}

/**
 * Generate a fake UUID
 * @returns UUID string
 */
function generateFakeId(): string {
  return uuidv4();
}

/**
 * Generate fake task data
 * @param id Optional ID to use
 * @returns Fake task data
 */
function generateFakeTaskData(id: string = uuidv4()): any {
  return {
    id,
    title: faker.lorem.sentence({ min: 3, max: 5 }),
    description: faker.lorem.paragraph(),
    status: faker.helpers.arrayElement(Object.values(TaskStatus)),
    priority: faker.helpers.arrayElement(Object.values(TaskPriority)),
    due_date: faker.date.future(),
    completed_at: Math.random() > 0.7 ? faker.date.recent() : null,
    tags: Array.from({ length: Math.floor(Math.random() * 3) }, () => faker.lorem.word()),
    project_id: uuidv4(),
    assignee_id: Math.random() > 0.2 ? uuidv4() : null,
    client_id: uuidv4(),
    created_at: faker.date.past(),
    updated_at: new Date()
  };
}

/**
 * Generate fake project data
 * @param id Optional ID to use
 * @returns Fake project data
 */
function generateFakeProjectData(id: string = uuidv4()): any {
  return {
    id,
    name: faker.company.name(),
    description: faker.lorem.paragraph(),
    status: faker.helpers.arrayElement(Object.values(ProjectStatus)),
    owner_id: uuidv4(),
    client_id: uuidv4(),
    created_at: faker.date.past(),
    updated_at: new Date()
  };
}

/**
 * Generate fake user data
 * @param id Optional ID to use
 * @returns Fake user data
 */
function generateFakeUserData(id: string = uuidv4()): any {
  return {
    id,
    name: faker.person.fullName(),
    email: faker.internet.email(),
    role: faker.helpers.arrayElement(Object.values(UserRole)),
    avatar_url: faker.image.avatar(),
    client_id: uuidv4(),
    created_at: faker.date.past(),
    updated_at: new Date()
  };
}

/**
 * Generate fake comment data
 * @param id Optional ID to use
 * @returns Fake comment data
 */
function generateFakeCommentData(id: string = uuidv4()): any {
  return {
    id,
    content: faker.lorem.paragraph(),
    entityType: faker.helpers.arrayElement(['task', 'project']),
    entityId: uuidv4(),
    authorId: uuidv4(),
    parentId: Math.random() > 0.8 ? uuidv4() : null,
    createdAt: faker.date.past(),
    updatedAt: new Date()
  };
}

/* Individual entity implementations */

async function createBulkTasks(sql: SqlQueryFunction, count: number): Promise<string[]> {
  const taskIds: string[] = [];
  
  // Get a project ID to use
  let projectId: string;
  try {
    const projects = await sql`SELECT id FROM projects LIMIT 1`;
    if (projects && projects.length > 0) {
      projectId = projects[0].id;
    } else {
      // Create a project if none exists
      projectId = uuidv4();
      const projectData: ProjectData = {
        id: projectId,
        name: 'Test Project',
        description: 'Project for WAL testing',
        status: ProjectStatus.ACTIVE,
        owner_id: uuidv4(), // This will be replaced if users exist
        created_at: new Date(),
        updated_at: new Date()
      };
      
      // First check if we have any users to assign as owner
      const users = await sql`SELECT id FROM users LIMIT 1`;
      if (users && users.length > 0) {
        projectData.owner_id = users[0].id;
      } else {
        // Create a user to own this project
        const userId = uuidv4();
        const userData: UserData = {
          id: userId,
          name: 'Test User',
          email: 'test@example.com',
          role: UserRole.ADMIN,
          created_at: new Date(),
          updated_at: new Date()
        };
        
        await sql`
          INSERT INTO users (id, name, email, role, created_at, updated_at)
          VALUES (
            ${userData.id},
            ${userData.name},
            ${userData.email},
            ${userData.role},
            ${userData.created_at},
            ${userData.updated_at}
          )
        `;
        
        projectData.owner_id = userId;
        console.log(`Created test user with ID: ${userId}`);
      }
      
      await sql`
        INSERT INTO projects (id, name, description, status, owner_id, created_at, updated_at)
        VALUES (
          ${projectData.id},
          ${projectData.name},
          ${projectData.description},
          ${projectData.status},
          ${projectData.owner_id},
          ${projectData.created_at},
          ${projectData.updated_at}
        )
      `;
      console.log(`Created test project with ID: ${projectId}`);
    }
  } catch (error) {
    console.error('Error getting or creating project:', error);
    throw error;
  }
  
  // Fetch a sample of users for random assignment
  let userIds: string[] = [];
  try {
    const users = await sql`SELECT id FROM users LIMIT 10`;
    if (users && users.length > 0) {
      userIds = users.map((user: { id: string }) => user.id);
    }
  } catch (error) {
    console.warn('No users found for task assignment');
  }
  
  // Create tasks in small batches for better performance
  const batchSize = 5;
  for (let i = 0; i < count; i += batchSize) {
    const currentBatchSize = Math.min(batchSize, count - i);
    const batch: TaskData[] = [];
    
    for (let j = 0; j < currentBatchSize; j++) {
      const taskId = uuidv4();
      taskIds.push(taskId);
      
      // Randomly assign a user to the task (or leave unassigned)
      let assigneeId: string | null = null;
      if (userIds.length > 0 && Math.random() < 0.7) {
        assigneeId = faker.helpers.arrayElement(userIds);
      }
      
      // Generate 0-5 random tags
      const tags = Array.from({ length: faker.number.int({ min: 0, max: 5 }) }, 
        () => faker.hacker.adjective()
      );
      
      batch.push({
        id: taskId,
        title: faker.hacker.phrase().substring(0, 100),
        description: faker.lorem.paragraphs(1),
        status: faker.helpers.arrayElement(Object.values(TaskStatus)),
        priority: faker.helpers.arrayElement(Object.values(TaskPriority)),
        due_date: Math.random() > 0.3 ? faker.date.future() : null,
        completed_at: Math.random() > 0.7 ? faker.date.past() : null,
        tags: tags,
        project_id: projectId,
        assignee_id: assigneeId,
        created_at: new Date(),
        updated_at: new Date()
      });
    }
    
    // Insert the batch of tasks
    for (const task of batch) {
      try {
        await sql`
          INSERT INTO tasks (
            id, title, description, status, priority, due_date, completed_at, 
            tags, project_id, assignee_id, created_at, updated_at
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
            ${task.created_at},
            ${task.updated_at}
          )
        `;
      } catch (error) {
        console.error(`Error inserting task ${task.id}:`, error);
        // Continue with other tasks
      }
    }
    
    console.log(`Created ${batch.length} tasks (batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(count/batchSize)})`);
  }
  
  return taskIds;
}

async function createBulkProjects(sql: SqlQueryFunction, count: number): Promise<string[]> {
  const projectIds: string[] = [];
  
  // Fetch user IDs for owners
  let userIds: string[] = [];
  try {
    const users = await sql`SELECT id FROM users LIMIT 10`;
    if (users && users.length > 0) {
      userIds = users.map((user: { id: string }) => user.id);
    } else {
      // Create a user if none exists
      const userId = uuidv4();
      const userData: UserData = {
        id: userId,
        name: 'Test User',
        email: 'test@example.com',
        role: UserRole.ADMIN,
        created_at: new Date(),
        updated_at: new Date()
      };
      
      await sql`
        INSERT INTO users (id, name, email, role, created_at, updated_at)
        VALUES (
          ${userData.id},
          ${userData.name},
          ${userData.email},
          ${userData.role},
          ${userData.created_at},
          ${userData.updated_at}
        )
      `;
      userIds.push(userId);
      console.log(`Created test user with ID: ${userId}`);
    }
  } catch (error) {
    console.error('Error getting or creating users:', error);
    throw error;
  }
  
  // Create projects in batches
  const batchSize = 5;
  for (let i = 0; i < count; i += batchSize) {
    const currentBatchSize = Math.min(batchSize, count - i);
    const batch: ProjectData[] = [];
    
    for (let j = 0; j < currentBatchSize; j++) {
      const projectId = uuidv4();
      projectIds.push(projectId);
      
      batch.push({
        id: projectId,
        name: faker.company.catchPhrase(),
        description: faker.lorem.paragraph(),
        status: faker.helpers.arrayElement(Object.values(ProjectStatus)),
        owner_id: faker.helpers.arrayElement(userIds),
        created_at: faker.date.past(),
        updated_at: new Date()
      });
    }
    
    // Insert the batch of projects
    for (const project of batch) {
      try {
        await sql`
          INSERT INTO projects (
            id, name, description, status, owner_id, created_at, updated_at
          ) VALUES (
            ${project.id},
            ${project.name},
            ${project.description},
            ${project.status},
            ${project.owner_id},
            ${project.created_at},
            ${project.updated_at}
          )
        `;
      } catch (error) {
        console.error(`Error inserting project ${project.id}:`, error);
        // Continue with other projects
      }
    }
    
    console.log(`Created ${batch.length} projects (batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(count/batchSize)})`);
  }
  
  return projectIds;
}

async function createBulkUsers(sql: SqlQueryFunction, count: number): Promise<string[]> {
  const userIds: string[] = [];
  
  // Create users in batches
  const batchSize = 5;
  for (let i = 0; i < count; i += batchSize) {
    const currentBatchSize = Math.min(batchSize, count - i);
    const batch: UserData[] = [];
    
    for (let j = 0; j < currentBatchSize; j++) {
      const userId = uuidv4();
      userIds.push(userId);
      
      batch.push({
        id: userId,
        name: faker.person.fullName(),
        email: faker.internet.email(),
        role: faker.helpers.arrayElement(Object.values(UserRole)),
        avatar_url: faker.internet.avatar(),
        created_at: faker.date.past(),
        updated_at: new Date()
      });
    }
    
    // Insert the batch of users
    for (const user of batch) {
      try {
        await sql`
          INSERT INTO users (
            id, name, email, role, avatar_url, created_at, updated_at
          ) VALUES (
            ${user.id},
            ${user.name},
            ${user.email},
            ${user.role},
            ${user.avatar_url},
            ${user.created_at},
            ${user.updated_at}
          )
        `;
      } catch (error) {
        console.error(`Error inserting user ${user.id}:`, error);
        // Continue with other users
      }
    }
    
    console.log(`Created ${batch.length} users (batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(count/batchSize)})`);
  }
  
  return userIds;
}

async function createBulkComments(sql: SqlQueryFunction, count: number): Promise<string[]> {
  const commentIds: string[] = [];
  
  // Fetch task IDs for comments
  let taskIds: string[] = [];
  try {
    const tasks = await sql`SELECT id FROM tasks LIMIT 20`;
    if (tasks && tasks.length > 0) {
      taskIds = tasks.map((task: { id: string }) => task.id);
    } else {
      // Create a task if none exists
      const createdTaskIds = await createBulkTasks(sql, 3);
      if (createdTaskIds.length > 0) {
        taskIds = createdTaskIds;
      } else {
        console.error('Unable to create tasks for comments');
        return [];
      }
    }
  } catch (error) {
    console.error('Error getting tasks for comments:', error);
    throw error;
  }
  
  // Fetch user IDs for authors
  let userIds: string[] = [];
  try {
    const users = await sql`SELECT id FROM users LIMIT 10`;
    if (users && users.length > 0) {
      userIds = users.map((user: { id: string }) => user.id);
    } else {
      // Create a user if none exists
      const createdUserIds = await createBulkUsers(sql, 2);
      if (createdUserIds.length > 0) {
        userIds = createdUserIds;
      } else {
        console.error('Unable to create users for comment authors');
        return [];
      }
    }
  } catch (error) {
    console.error('Error getting users for comment authors:', error);
    throw error;
  }
  
  // Create comments in batches
  const batchSize = 5;
  for (let i = 0; i < count; i += batchSize) {
    const currentBatchSize = Math.min(batchSize, count - i);
    const batch: CommentData[] = [];
    
    for (let j = 0; j < currentBatchSize; j++) {
      const commentId = uuidv4();
      commentIds.push(commentId);
      
      // Create the comment
      batch.push({
        id: commentId,
        content: faker.lorem.paragraph(),
        entityType: 'task',
        entityId: faker.helpers.arrayElement(taskIds),
        authorId: faker.helpers.arrayElement(userIds),
        parentId: Math.random() > 0.7 ? faker.helpers.arrayElement([...commentIds]) : null,  // 30% chance to be a reply
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }
    
    // Insert the batch of comments
    for (const comment of batch) {
      try {
        await sql`
          INSERT INTO comments (
            id, content, entity_type, entity_id, author_id, parent_id, created_at, updated_at
          ) VALUES (
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
      } catch (error) {
        console.error(`Error inserting comment ${comment.id}:`, error);
        // Continue with other comments
      }
    }
    
    console.log(`Created ${batch.length} comments (batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(count/batchSize)})`);
  }
  
  return commentIds;
}

async function updateBulkTasks(sql: SqlQueryFunction, count: number): Promise<string[]> {
  // Fetch existing task IDs
  try {
    const tasks = await sql`SELECT id FROM tasks LIMIT ${count * 2}`; // Fetch extra in case some fail
    if (!tasks || tasks.length === 0) {
      console.warn('No existing tasks found to update');
      return [];
    }
    
    // Update tasks in small batches
    const batchSize = 5;
    const taskIds = tasks.map((task: { id: string }) => task.id);
    const updatedTaskIds: string[] = [];
    
    for (let i = 0; i < Math.min(count, taskIds.length); i += batchSize) {
      const currentBatchSize = Math.min(batchSize, Math.min(count, taskIds.length) - i);
      const batch = taskIds.slice(i, i + currentBatchSize);
      
      for (const taskId of batch) {
        try {
          // Generate random updates
          const taskUpdates = {
            title: faker.hacker.phrase().substring(0, 100),
            status: faker.helpers.arrayElement(Object.values(TaskStatus)),
            priority: faker.helpers.arrayElement(Object.values(TaskPriority))
            // updated_at is handled by database trigger
          };
          
          await sql`
            UPDATE tasks 
            SET 
              title = ${taskUpdates.title}, 
              status = ${taskUpdates.status}, 
              priority = ${taskUpdates.priority}
            WHERE id = ${taskId}
          `;
          
          updatedTaskIds.push(taskId);
        } catch (error) {
          console.error(`Error updating task ${taskId}:`, error);
          // Continue with other tasks
        }
      }
      
      console.log(`Updated ${batch.length} tasks (batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(Math.min(count, taskIds.length)/batchSize)})`);
    }
    
    return updatedTaskIds;
  } catch (error) {
    console.error('Error updating tasks:', error);
    throw error;
  }
}

async function updateBulkProjects(sql: SqlQueryFunction, count: number): Promise<string[]> {
  // Fetch existing project IDs
  try {
    const projects = await sql`SELECT id FROM projects LIMIT ${count * 2}`;
    if (!projects || projects.length === 0) {
      console.warn('No existing projects found to update');
      return [];
    }
    
    // Update projects in small batches
    const batchSize = 5;
    const projectIds = projects.map((project: { id: string }) => project.id);
    const updatedProjectIds: string[] = [];
    
    for (let i = 0; i < Math.min(count, projectIds.length); i += batchSize) {
      const currentBatchSize = Math.min(batchSize, Math.min(count, projectIds.length) - i);
      const batch = projectIds.slice(i, i + currentBatchSize);
      
      for (const projectId of batch) {
        try {
          // Generate random updates
          const projectUpdates = {
            name: faker.company.catchPhrase(),
            status: faker.helpers.arrayElement(Object.values(ProjectStatus))
            // updated_at is handled by database trigger
          };
          
          await sql`
            UPDATE projects 
            SET 
              name = ${projectUpdates.name}, 
              status = ${projectUpdates.status}
            WHERE id = ${projectId}
          `;
          
          updatedProjectIds.push(projectId);
        } catch (error) {
          console.error(`Error updating project ${projectId}:`, error);
          // Continue with other projects
        }
      }
      
      console.log(`Updated ${batch.length} projects (batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(Math.min(count, projectIds.length)/batchSize)})`);
    }
    
    return updatedProjectIds;
  } catch (error) {
    console.error('Error updating projects:', error);
    throw error;
  }
}

async function updateBulkUsers(sql: SqlQueryFunction, count: number): Promise<string[]> {
  // Fetch existing user IDs
  try {
    const users = await sql`SELECT id FROM users LIMIT ${count * 2}`;
    if (!users || users.length === 0) {
      console.warn('No existing users found to update');
      return [];
    }
    
    // Update users in small batches
    const batchSize = 5;
    const userIds = users.map((user: { id: string }) => user.id);
    const updatedUserIds: string[] = [];
    
    for (let i = 0; i < Math.min(count, userIds.length); i += batchSize) {
      const currentBatchSize = Math.min(batchSize, Math.min(count, userIds.length) - i);
      const batch = userIds.slice(i, i + currentBatchSize);
      
      for (const userId of batch) {
        try {
          // Generate random updates
          const userUpdates = {
            name: faker.person.fullName(),
            role: faker.helpers.arrayElement(Object.values(UserRole))
            // updated_at is handled by database trigger
          };
          
          await sql`
            UPDATE users 
            SET 
              name = ${userUpdates.name}, 
              role = ${userUpdates.role}
            WHERE id = ${userId}
          `;
          
          updatedUserIds.push(userId);
        } catch (error) {
          console.error(`Error updating user ${userId}:`, error);
          // Continue with other users
        }
      }
      
      console.log(`Updated ${batch.length} users (batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(Math.min(count, userIds.length)/batchSize)})`);
    }
    
    return updatedUserIds;
  } catch (error) {
    console.error('Error updating users:', error);
    throw error;
  }
}

async function updateBulkComments(sql: SqlQueryFunction, count: number): Promise<string[]> {
  // Fetch existing comment IDs
  try {
    const comments = await sql`SELECT id FROM comments LIMIT ${count * 2}`;
    if (!comments || comments.length === 0) {
      console.warn('No existing comments found to update');
      return [];
    }
    
    // Update comments in small batches
    const batchSize = 5;
    const commentIds = comments.map((comment: { id: string }) => comment.id);
    const updatedCommentIds: string[] = [];
    
    for (let i = 0; i < Math.min(count, commentIds.length); i += batchSize) {
      const currentBatchSize = Math.min(batchSize, Math.min(count, commentIds.length) - i);
      const batch = commentIds.slice(i, i + currentBatchSize);
      
      for (const commentId of batch) {
        try {
          // Generate new content for the update
          const content = faker.lorem.paragraph();
          
          // Only update the content field - leave updated_at to be handled by the database trigger
          await sql`
            UPDATE comments 
            SET content = ${content}
            WHERE id = ${commentId}
          `;
          
          updatedCommentIds.push(commentId);
        } catch (error) {
          console.error(`Error updating comment ${commentId}:`, error);
          // Continue with other comments
        }
      }
      
      console.log(`Updated ${batch.length} comments (batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(Math.min(count, commentIds.length)/batchSize)})`);
    }
    
    return updatedCommentIds;
  } catch (error) {
    console.error('Error updating comments:', error);
    throw error;
  }
}

/**
 * Delete comments with proper constraint handling
 */
async function deleteComments(sql: SqlQueryFunction, count: number): Promise<string[]> {
  try {
    // Fetch leaf comments first (those that don't have child comments)
    const leafComments = await sql`
      SELECT c.id 
      FROM comments c
      WHERE NOT EXISTS (SELECT 1 FROM comments WHERE parent_id = c.id)
      LIMIT ${count * 2}
    `;

    if (!leafComments || leafComments.length === 0) {
      console.warn('No leaf comments found to delete');
      return [];
    }
    
    // Delete up to 'count' leaf comments (no dependencies)
    const commentIds = leafComments.map((comment: { id: string }) => comment.id);
    const deletedIds: string[] = [];
    
    for (let i = 0; i < Math.min(count, commentIds.length); i++) {
      const commentId = commentIds[i];
      try {
        await sql`DELETE FROM comments WHERE id = ${commentId}`;
        deletedIds.push(commentId);
      } catch (error) {
        console.error(`Error deleting comment ${commentId}:`, error);
      }
    }
    
    console.log(`Deleted ${deletedIds.length} comments`);
    return deletedIds;
  } catch (error) {
    console.error('Error deleting comments:', error);
    throw error;
  }
}

/**
 * Delete tasks with proper constraint handling
 */
async function deleteTasks(sql: SqlQueryFunction, count: number): Promise<string[]> {
  try {
    // Find tasks that have no comments
    const tasksWithoutComments = await sql`
      SELECT t.id
      FROM tasks t
      WHERE NOT EXISTS (
        SELECT 1 FROM comments 
        WHERE entity_type = 'task' AND entity_id = t.id
      )
      LIMIT ${count * 2}
    `;
    
    // If we found tasks without comments, those are easier to delete
    let taskIds = [];
    if (tasksWithoutComments && tasksWithoutComments.length > 0) {
      taskIds = tasksWithoutComments.map((task: { id: string }) => task.id);
    } else {
      // Fall back to any tasks, but we'll need to handle their comments
      const anyTasks = await sql`SELECT id FROM tasks LIMIT ${count * 2}`;
      if (!anyTasks || anyTasks.length === 0) {
        console.warn('No tasks found to delete');
        return [];
      }
      taskIds = anyTasks.map((task: { id: string }) => task.id);
    }
    
    const deletedIds: string[] = [];
    for (let i = 0; i < Math.min(count, taskIds.length); i++) {
      const taskId = taskIds[i];
      try {
        // Delete task comments first
        await sql`DELETE FROM comments WHERE entity_type = 'task' AND entity_id = ${taskId}`;
        
        // Delete task dependencies
        await sql`DELETE FROM task_dependencies WHERE dependent_task_id = ${taskId} OR dependency_task_id = ${taskId}`;
        
        // Delete the task
        await sql`DELETE FROM tasks WHERE id = ${taskId}`;
        
        deletedIds.push(taskId);
      } catch (error) {
        console.error(`Error deleting task ${taskId}:`, error);
      }
    }
    
    console.log(`Deleted ${deletedIds.length} tasks`);
    return deletedIds;
  } catch (error) {
    console.error('Error deleting tasks:', error);
    throw error;
  }
}

/**
 * Delete projects with proper constraint handling
 */
async function deleteProjects(sql: SqlQueryFunction, count: number): Promise<string[]> {
  try {
    // Find projects that have no tasks (easier to delete)
    const projectsWithoutTasks = await sql`
      SELECT p.id
      FROM projects p
      WHERE NOT EXISTS (
        SELECT 1 FROM tasks WHERE project_id = p.id
      )
      LIMIT ${count * 2}
    `;
    
    // If we found projects without tasks, prioritize those
    let projectIds = [];
    if (projectsWithoutTasks && projectsWithoutTasks.length > 0) {
      projectIds = projectsWithoutTasks.map((project: { id: string }) => project.id);
    } else {
      // Fall back to any projects, but we'll need to handle their tasks
      const anyProjects = await sql`SELECT id FROM projects LIMIT ${count * 2}`;
      if (!anyProjects || anyProjects.length === 0) {
        console.warn('No projects found to delete');
        return [];
      }
      projectIds = anyProjects.map((project: { id: string }) => project.id);
    }
    
    const deletedIds: string[] = [];
    for (let i = 0; i < Math.min(count, projectIds.length); i++) {
      const projectId = projectIds[i];
      try {
        // 1. Delete project comments
        await sql`DELETE FROM comments WHERE entity_type = 'project' AND entity_id = ${projectId}`;
        
        // 2. Get tasks in this project
        const tasks = await sql`SELECT id FROM tasks WHERE project_id = ${projectId}`;
        
        // 3. Delete each task's comments and dependencies
        for (const task of tasks) {
          const taskId = task.id;
          await sql`DELETE FROM comments WHERE entity_type = 'task' AND entity_id = ${taskId}`;
          await sql`DELETE FROM task_dependencies WHERE dependent_task_id = ${taskId} OR dependency_task_id = ${taskId}`;
        }
        
        // 4. Delete all tasks in the project
        await sql`DELETE FROM tasks WHERE project_id = ${projectId}`;
        
        // 5. Delete project members
        await sql`DELETE FROM project_members WHERE project_id = ${projectId}`;
        
        // 6. Delete the project
        await sql`DELETE FROM projects WHERE id = ${projectId}`;
        
        deletedIds.push(projectId);
      } catch (error) {
        console.error(`Error deleting project ${projectId}:`, error);
      }
    }
    
    console.log(`Deleted ${deletedIds.length} projects`);
    return deletedIds;
  } catch (error) {
    console.error('Error deleting projects:', error);
    throw error;
  }
}

/**
 * Delete users with proper constraint handling
 */
async function deleteUsers(sql: SqlQueryFunction, count: number): Promise<string[]> {
  try {
    // Find users that don't own projects or have comments (easiest to delete)
    const simpleUsers = await sql`
      SELECT u.id
      FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM projects WHERE owner_id = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM comments WHERE author_id = u.id
      )
      LIMIT ${count * 2}
    `;
    
    // If we found users without projects or comments, prioritize those
    let userIds = [];
    if (simpleUsers && simpleUsers.length > 0) {
      userIds = simpleUsers.map((user: { id: string }) => user.id);
    } else {
      // Fall back to any users, but we'll need to handle dependencies
      const anyUsers = await sql`SELECT id FROM users LIMIT ${count * 2}`;
      if (!anyUsers || anyUsers.length === 0) {
        console.warn('No users found to delete');
        return [];
      }
      userIds = anyUsers.map((user: { id: string }) => user.id);
    }
    
    const deletedIds: string[] = [];
    for (let i = 0; i < Math.min(count, userIds.length); i++) {
      const userId = userIds[i];
      try {
        // 1. Set other author's comments with this user as parent to NULL
        await sql`
          UPDATE comments 
          SET parent_id = NULL 
          WHERE parent_id IN (
            SELECT id FROM comments WHERE author_id = ${userId}
          )
          AND author_id != ${userId}
        `;
        
        // 2. Delete all comments authored by this user
        await sql`DELETE FROM comments WHERE author_id = ${userId}`;
        
        // 3. Set tasks with this user as assignee to NULL
        await sql`UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ${userId}`;
        
        // 4. Handle owned projects:
        const ownedProjects = await sql`SELECT id FROM projects WHERE owner_id = ${userId}`;
        
        // For each owned project:
        for (const project of ownedProjects) {
          const projectId = project.id;
          
          // Delete project comments
          await sql`DELETE FROM comments WHERE entity_type = 'project' AND entity_id = ${projectId}`;
          
          // Get project tasks
          const projectTasks = await sql`SELECT id FROM tasks WHERE project_id = ${projectId}`;
          
          // For each task in the project
          for (const task of projectTasks) {
            const taskId = task.id;
            
            // Delete task comments
            await sql`DELETE FROM comments WHERE entity_type = 'task' AND entity_id = ${taskId}`;
            
            // Delete task dependencies
            await sql`DELETE FROM task_dependencies WHERE dependent_task_id = ${taskId} OR dependency_task_id = ${taskId}`;
          }
          
          // Delete all tasks in the project
          await sql`DELETE FROM tasks WHERE project_id = ${projectId}`;
          
          // Delete project members
          await sql`DELETE FROM project_members WHERE project_id = ${projectId}`;
          
          // Delete the project
          await sql`DELETE FROM projects WHERE id = ${projectId}`;
        }
        
        // 5. Delete user from project members
        await sql`DELETE FROM project_members WHERE user_id = ${userId}`;
        
        // 6. Finally delete the user
        await sql`DELETE FROM users WHERE id = ${userId}`;
        
        deletedIds.push(userId);
      } catch (error) {
        console.error(`Error deleting user ${userId}:`, error);
      }
    }
    
    console.log(`Deleted ${deletedIds.length} users`);
    return deletedIds;
  } catch (error) {
    console.error('Error deleting users:', error);
    throw error;
  }
} 