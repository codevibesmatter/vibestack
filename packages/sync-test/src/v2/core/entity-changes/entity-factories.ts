/**
 * Entity Factories
 * 
 * Factory functions for creating test entities without complex abstractions.
 * Provides a simple, intuitive API for generating test data.
 */

import { v4 as uuidv4 } from 'uuid';
import { faker } from '@faker-js/faker';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

// Import directly from dataforge
import { 
  User, 
  Project, 
  Task, 
  Comment,
  TaskStatus,
  TaskPriority,
  ProjectStatus,
  UserRole
} from '@repo/dataforge/server-entities';

import { EntityType, DEPENDENCY_ORDER } from './entity-adapter.ts';
import { createLogger } from '../../core/logger.js';

const logger = createLogger('EntityFactories');

// Optional configuration for entity factories
export interface EntityFactoryOptions {
  seed?: number;    // Random seed for deterministic generation
  now?: Date;       // Reference date to use instead of current date
}

// Set up global options
let factoryOptions: EntityFactoryOptions = {};

/**
 * Configure the entity factories
 */
export function configureFactories(options: EntityFactoryOptions): void {
  factoryOptions = { ...options };
  
  // Set faker seed for deterministic generation if provided
  if (options.seed !== undefined) {
    faker.seed(options.seed);
  }
}

/**
 * Ensures a valid Date object for database storage
 * Prevents validation errors by properly formatting dates
 */
export function ensureValidDate(date?: Date | string | number): Date {
  if (!date) {
    return new Date(); // Default to current date if none provided
  }
  
  if (date instanceof Date) {
    // Return the date if it's already a Date object and valid
    return isNaN(date.getTime()) ? new Date() : date;
  }
  
  try {
    // Try to parse the date if it's a string or number
    const parsedDate = new Date(date);
    return isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
  } catch (e) {
    // If parsing fails, return current date
    return new Date();
  }
}

/**
 * Validates an entity using class-validator and returns any errors
 * @param entity The entity to validate
 * @returns A promise that resolves to an array of error messages
 */
async function validateEntity<T extends object>(entity: T): Promise<string[]> {
  try {
    // Use class-validator to validate the entity
    const errors = await validate(entity, {
      skipMissingProperties: true,
      whitelist: true,
    });
    
    if (errors.length > 0) {
      // Format errors for readability
      return errors.map(error => {
        const constraints = Object.values(error.constraints || {}).join(', ');
        return `${error.property}: ${constraints}`;
      });
    }
    
    return [];
  } catch (error) {
    logger.error(`Error validating entity: ${error}`);
    return [`Validation error: ${error}`];
  }
}

/**
 * Validates an entity and throws an error if validation fails
 * @param entity The entity to validate
 * @throws Error if validation fails
 */
async function validateEntityOrThrow<T extends object>(entity: T): Promise<void> {
  const errors = await validateEntity(entity);
  
  if (errors.length > 0) {
    const errorMessage = errors.join('\n');
    logger.error(`Validation failed: ${errorMessage}`);
    throw new Error(`Validation failed:\n${errorMessage}`);
  }
}

/**
 * Create a user entity
 */
export async function createUser(overrides: Partial<User> = {}): Promise<User> {
  const user = new User();
  
  // Set core properties
  user.id = overrides.id || uuidv4();
  
  // Generate a valid name that passes validation (letters, numbers, spaces, hyphens, and apostrophes only)
  const firstName = faker.person.firstName().replace(/[^a-zA-Z0-9\s\-']/g, '');
  const lastName = faker.person.lastName().replace(/[^a-zA-Z0-9\s\-']/g, '');
  user.name = overrides.name || `${firstName} ${lastName}`;
  
  // Generate a unique email with timestamp to avoid duplicate key violations
  const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
  user.email = overrides.email || faker.internet.email({ 
    firstName: firstName, 
    lastName: `${lastName}.${uniqueSuffix}`
  });
  
  user.role = overrides.role || faker.helpers.arrayElement(Object.values(UserRole));
  
  // Set timestamps with proper Date objects
  const now = factoryOptions.now || new Date();
  user.createdAt = ensureValidDate(overrides.createdAt) || ensureValidDate(now);
  user.updatedAt = ensureValidDate(overrides.updatedAt) || ensureValidDate(now);
  
  // Validate the entity before returning
  await validateEntityOrThrow(user);
  
  return user;
}

/**
 * Create a project entity
 */
export async function createProject(options: { owner?: User } = {}, overrides: Partial<Project> = {}): Promise<Project> {
  const project = new Project();
  
  // Set core properties
  project.id = overrides.id || uuidv4();
  
  // Generate a unique project name with timestamp that passes validation
  // (only letters, numbers, spaces, hyphens, underscores, apostrophes, and periods)
  const uniqueSuffix = Date.now().toString(36).substring(3, 7);
  const projectName = faker.company.name().replace(/[^a-zA-Z0-9\s\-_'.]/g, '');
  project.name = overrides.name || `${projectName}-${uniqueSuffix}`;
  
  project.description = overrides.description || faker.company.catchPhrase();
  project.status = overrides.status || faker.helpers.arrayElement(Object.values(ProjectStatus));
  
  // Set owner reference
  project.ownerId = overrides.ownerId || options.owner?.id || uuidv4();
  
  // Set timestamps with proper Date objects
  const now = factoryOptions.now || new Date();
  project.createdAt = ensureValidDate(overrides.createdAt) || ensureValidDate(now);
  project.updatedAt = ensureValidDate(overrides.updatedAt) || ensureValidDate(now);
  
  // Validate the entity before returning
  await validateEntityOrThrow(project);
  
  return project;
}

/**
 * Create a task entity
 */
export async function createTask(
  options: { project?: Project; assignee?: User } = {}, 
  overrides: Partial<Task> = {}
): Promise<Task> {
  const task = new Task();
  
  // Set core properties
  task.id = overrides.id || uuidv4();
  task.title = overrides.title || faker.company.catchPhrase();
  task.description = overrides.description || faker.lorem.paragraph();
  task.status = overrides.status || faker.helpers.arrayElement(Object.values(TaskStatus));
  task.priority = overrides.priority || faker.helpers.arrayElement(Object.values(TaskPriority));
  
  // Set references
  task.projectId = overrides.projectId || options.project?.id || uuidv4();
  task.assigneeId = overrides.assigneeId || options.assignee?.id || uuidv4();
  
  // Set due date (between now and 30 days from now) as proper Date object
  const now = factoryOptions.now || new Date();
  task.dueDate = overrides.dueDate ? ensureValidDate(overrides.dueDate) : faker.date.future({ refDate: now, years: 0.25 });
  
  // Set timestamps with proper Date objects
  task.createdAt = ensureValidDate(overrides.createdAt) || ensureValidDate(now);
  task.updatedAt = ensureValidDate(overrides.updatedAt) || ensureValidDate(now);
  
  // Set tags (optional)
  task.tags = overrides.tags || [faker.word.sample(), faker.word.sample()];
  
  // Validate the entity before returning
  await validateEntityOrThrow(task);
  
  return task;
}

/**
 * Create a comment entity
 */
export async function createComment(
  options: { author?: User; parent?: Comment; entity?: Project | Task } = {},
  overrides: Partial<Comment> = {}
): Promise<Comment> {
  const comment = new Comment();
  
  // Set core properties
  comment.id = overrides.id || uuidv4();
  comment.content = overrides.content || faker.lorem.paragraph();
  
  // Set references
  comment.authorId = overrides.authorId || options.author?.id || uuidv4();
  
  // Set parent reference if provided
  if (options.parent || overrides.parentId) {
    comment.parentId = overrides.parentId || options.parent?.id;
  }
  
  // Set entity reference - determine type and ID
  if (options.entity) {
    if (options.entity instanceof Project) {
      comment.entityType = 'project';
      comment.entityId = options.entity.id;
    } else if (options.entity instanceof Task) {
      comment.entityType = 'task';
      comment.entityId = options.entity.id;
    }
  } else {
    comment.entityType = overrides.entityType || faker.helpers.arrayElement(['project', 'task']);
    comment.entityId = overrides.entityId || uuidv4();
  }
  
  // Set optional client ID
  if (overrides.clientId || Math.random() > 0.8) {
    comment.clientId = overrides.clientId || uuidv4();
  }
  
  // Set timestamps with proper Date objects
  const now = factoryOptions.now || new Date();
  comment.createdAt = ensureValidDate(overrides.createdAt) || ensureValidDate(now);
  comment.updatedAt = ensureValidDate(overrides.updatedAt) || ensureValidDate(now);
  
  // Validate the entity before returning
  await validateEntityOrThrow(comment);
  
  return comment;
}

/**
 * Create multiple entities of a single type
 */
export async function createEntities<T extends EntityType>(
  entityType: T,
  count: number,
  options: Record<string, any> = {},
  overrides: Partial<any> = {}
): Promise<any[]> {
  const factories = {
    user: createUser,
    project: createProject,
    task: createTask,
    comment: createComment
  };
  
  const factory = factories[entityType];
  const entities = [];
  
  for (let i = 0; i < count; i++) {
    entities.push(await factory(options, overrides));
  }
  
  return entities;
}

/**
 * Create a complete entity graph with dependencies
 */
export async function createEntityGraph(entityCounts: Partial<Record<EntityType, number>> = {}): Promise<Record<EntityType, any[]>> {
  const entities: Record<EntityType, any[]> = {
    user: [],
    project: [],
    task: [],
    comment: []
  };
  
  // Create entities in dependency order
  for (const entityType of DEPENDENCY_ORDER) {
    const count = entityCounts[entityType] || 0;
    if (count <= 0) continue;
    
    if (entityType === 'user') {
      entities.user = await createEntities('user', count);
    } 
    else if (entityType === 'project') {
      // Create projects with random user owners
      for (let i = 0; i < count; i++) {
        const randomUser = entities.user.length > 0 
          ? faker.helpers.arrayElement(entities.user) 
          : undefined;
        
        const project = await createProject({ owner: randomUser });
        entities.project.push(project);
      }
    }
    else if (entityType === 'task') {
      // Create tasks with random projects and assignees
      for (let i = 0; i < count; i++) {
        const randomProject = entities.project.length > 0 
          ? faker.helpers.arrayElement(entities.project) 
          : undefined;
          
        const randomUser = entities.user.length > 0 
          ? faker.helpers.arrayElement(entities.user) 
          : undefined;
        
        const task = await createTask({ project: randomProject, assignee: randomUser });
        entities.task.push(task);
      }
    }
    else if (entityType === 'comment') {
      // Create comments with random authors and entities
      for (let i = 0; i < count; i++) {
        const randomUser = entities.user.length > 0 
          ? faker.helpers.arrayElement(entities.user) 
          : undefined;
          
        // Choose between task and project for entity
        const entityChoice = faker.helpers.arrayElement(['task', 'project']) as 'task' | 'project';
        
        // Get a random entity of the chosen type
        let randomEntity: Project | Task | undefined;
        if (entityChoice === 'project' && entities.project.length > 0) {
          randomEntity = faker.helpers.arrayElement(entities.project) as Project;
        } else if (entityChoice === 'task' && entities.task.length > 0) {
          randomEntity = faker.helpers.arrayElement(entities.task) as Task;
        }
          
        // 20% chance of having a parent comment
        const randomParent = entities.comment.length > 0 && Math.random() > 0.8
          ? faker.helpers.arrayElement(entities.comment)
          : undefined;
        
        const comment = await createComment({ 
          author: randomUser, 
          entity: randomEntity, 
          parent: randomParent 
        });
        entities.comment.push(comment);
      }
    }
  }
  
  return entities;
} 