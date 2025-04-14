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
import { DataSource, Repository } from 'typeorm';

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

import { EntityType, DEPENDENCY_ORDER, getEntityClass } from './entity-adapter.ts';
import { createLogger } from '../../core/logger.js';

const logger = createLogger('EntityFactories');

// Optional configuration for entity factories
export interface EntityFactoryOptions {
  seed?: number;    // Random seed for deterministic generation
  now?: Date;       // Reference date to use instead of current date
}

// Options for batch entity creation
export interface BatchEntityOptions {
  counts: Record<EntityType, number>;   // Number of entities to create by type
  batchId?: string;                      // Optional batch ID for tracking
  dataSource?: DataSource;               // Database connection for finding existing entities
  preferExistingReferences?: boolean;    // Whether to use existing entities from DB for references
  distribution?: {                       // Distribution of relationships (0.0-1.0)
    projectsWithOwners?: number;         // Percentage of projects that should have owners
    tasksWithProjects?: number;          // Percentage of tasks that should have projects
    tasksWithAssignees?: number;         // Percentage of tasks that should have assignees
    commentsOnTasks?: number;            // Percentage of comments that should be on tasks vs projects
  };
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
 * Create a batch of user entities
 */
export async function createUsers(count: number, overrides: Partial<User> = {}): Promise<User[]> {
  const users: User[] = [];
  
  for (let i = 0; i < count; i++) {
    const user = await createUser(overrides);
    users.push(user);
  }
  
  return users;
}

/**
 * Creates a new Project entity instance with optional overrides.
 */
export async function createProject(options: { owner?: User } = {}, overrides: Partial<Project> = {}): Promise<Project> {
  const project = new Project();

  // Set base properties first
  project.id = overrides.id || uuidv4();
  const now = factoryOptions.now || new Date();
  project.createdAt = ensureValidDate(overrides.createdAt) || ensureValidDate(now);
  project.updatedAt = ensureValidDate(overrides.updatedAt) || ensureValidDate(now);

  // Basic Info
  const baseName = overrides.name || `Test Project`;
  project.name = `${baseName}_${Date.now().toString().replace(/[^0-9]/g, '')}`.slice(0, 100);
  project.description = overrides.description || faker.company.catchPhrase();
  project.status = overrides.status || faker.helpers.arrayElement([
      ProjectStatus.ACTIVE,
      ProjectStatus.IN_PROGRESS, 
      ProjectStatus.COMPLETED, 
      ProjectStatus.ON_HOLD 
  ]);
  
  // Relations - require owner
  if (!options.owner) {
      throw new Error('Project creation requires an owner passed in options.');
  }
  project.ownerId = options.owner.id;
  
  // Other fields
  project.clientId = overrides.clientId;

  // Validate the generated entity
  const errors = await validate(project); 
  if (errors.length > 0) {
    const errorMessages = errors.map(e => `${e.property}: ${Object.values(e.constraints || {}).join(', ')}`).join('; ');
    logger.error(`Validation failed: ${errorMessages}`);
    throw new Error(`Validation failed:\n${errorMessages}`);
  }
  
  return project;
}

/**
 * Create projects with proper owner relationships
 */
export async function createProjectsWithOwners(
  count: number, 
  owners: User[] | string[],
  overrides: Partial<Project> = {}
): Promise<Project[]> {
  const projects: Project[] = [];
  
  if (!owners.length) {
    throw new Error('Cannot create projects without owners');
  }
  
  for (let i = 0; i < count; i++) {
    // Distribute owners evenly across projects
    const ownerIndex = i % owners.length;
    const owner = owners[ownerIndex];
    
    // Get the owner ID, either from User object or directly if it's a string
    const ownerId = typeof owner === 'string' ? owner : owner.id;
    
    const project = await createProject({}, { ...overrides, ownerId });
    projects.push(project);
  }
  
  return projects;
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
  
  // Set projectId (required) and assigneeId (optional)
  task.projectId = overrides.projectId || options.project?.id || uuidv4();
  task.assigneeId = overrides.assigneeId || options.assignee?.id || undefined;
  
  // Set timestamps with proper Date objects
  const now = factoryOptions.now || new Date();
  task.createdAt = ensureValidDate(overrides.createdAt) || ensureValidDate(now);
  task.updatedAt = ensureValidDate(overrides.updatedAt) || ensureValidDate(now);
  task.dueDate = overrides.dueDate ? ensureValidDate(overrides.dueDate) : undefined;
  
  // Set tags array (required)
  task.tags = overrides.tags || [faker.word.sample(), faker.word.sample()];
  
  // Validate the entity before returning
  await validateEntityOrThrow(task);
  
  return task;
}

/**
 * Create tasks with proper project and assignee relationships
 */
export async function createTasksWithRelationships(
  count: number,
  options: {
    projects?: (Project | string)[];
    assignees?: (User | string)[];
    assigneeRate?: number; // 0.0-1.0: probability of assigning an assignee
    projectRate?: number;  // 0.0-1.0: probability of assigning a project
  },
  overrides: Partial<Task> = {}
): Promise<Task[]> {
  const tasks: Task[] = [];
  const { projects = [], assignees = [], assigneeRate = 1.0, projectRate = 1.0 } = options;
  
  for (let i = 0; i < count; i++) {
    // Decide whether to use a project from the list or generate a new ID
    const useProject = projects.length > 0 && (Math.random() < projectRate);
    
    // Decide whether to use an assignee
    const useAssignee = assignees.length > 0 && (Math.random() < assigneeRate);
    
    // Get project ID - must have a valid projectId
    let projectId: string;
    if (useProject) {
      const projectIndex = i % projects.length;
      const project = projects[projectIndex];
      projectId = typeof project === 'string' ? project : project.id;
    } else {
      projectId = uuidv4(); // Generate UUID if no project is assigned
    }
    
    // Get assignee ID if using
    let assigneeId = undefined;
    if (useAssignee) {
      const assigneeIndex = i % assignees.length;
      const assignee = assignees[assigneeIndex];
      assigneeId = typeof assignee === 'string' ? assignee : assignee.id;
    }
    
    const task = await createTask({}, { ...overrides, projectId, assigneeId });
    tasks.push(task);
  }
  
  return tasks;
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
  
  // authorId is required
  comment.authorId = overrides.authorId || options.author?.id || uuidv4();
  
  // parentId is optional
  comment.parentId = overrides.parentId || options.parent?.id || undefined;
  
  // Set entity references (both entityId and entityType are required)
  if (overrides.entityId && overrides.entityType) {
    comment.entityId = overrides.entityId;
    comment.entityType = overrides.entityType;
  } else if (options.entity) {
    // Check if the entity is a Project or Task and set references accordingly
    if (options.entity instanceof Project) {
      comment.entityId = options.entity.id;
      comment.entityType = 'project';
    } else if (options.entity instanceof Task) {
      comment.entityId = options.entity.id;
      comment.entityType = 'task';
    } else {
      throw new Error('Invalid entity type for comment');
    }
  } else {
    // If no entity reference is provided, create a dummy one
    comment.entityId = uuidv4();
    comment.entityType = faker.helpers.arrayElement(['project', 'task']);
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
 * Create comments with proper author and entity relationships
 */
export async function createCommentsWithRelationships(
  count: number,
  options: {
    authors?: (User | string)[];
    entities?: { id: string, type: 'task' | 'project' }[];
    parentComments?: (Comment | string)[];
    parentRate?: number; // 0.0-1.0: probability of using a parent comment
    taskRate?: number;   // 0.0-1.0: probability of commenting on a task vs project
  },
  overrides: Partial<Comment> = {}
): Promise<Comment[]> {
  const comments: Comment[] = [];
  const { 
    authors = [], 
    entities = [], 
    parentComments = [], 
    parentRate = 0.1, 
    taskRate = 0.5 
  } = options;
  
  if (!authors.length || !entities.length) {
    throw new Error('Cannot create comments without authors and entities');
  }
  
  // Split entities into tasks and projects
  const tasks = entities.filter(e => e.type === 'task');
  const projects = entities.filter(e => e.type === 'project');
  
  for (let i = 0; i < count; i++) {
    // Get author
    const authorIndex = i % authors.length;
    const author = authors[authorIndex];
    const authorId = typeof author === 'string' ? author : author.id;
    
    // Decide whether to use a parent comment
    const useParent = parentComments.length > 0 && (Math.random() < parentRate);
    
    // Get parent ID if using
    let parentId = undefined;
    if (useParent) {
      const parentIndex = i % parentComments.length;
      const parent = parentComments[parentIndex];
      parentId = typeof parent === 'string' ? parent : parent.id;
    }
    
    // Decide whether to comment on a task or project
    let entityId, entityType;
    const useTask = (tasks.length > 0) && 
                   (projects.length === 0 || Math.random() < taskRate);
    
    if (useTask && tasks.length > 0) {
      const taskIndex = i % tasks.length;
      entityId = tasks[taskIndex].id;
      entityType = 'task';
    } else if (projects.length > 0) {
      const projectIndex = i % projects.length;
      entityId = projects[projectIndex].id;
      entityType = 'project';
    } else {
      // Skip if no valid entity
      continue;
    }
    
    const comment = await createComment({}, { 
      ...overrides, 
      authorId, 
      parentId,
      entityId,
      entityType
    });
    
    comments.push(comment);
  }
  
  return comments;
}

/**
 * Create a batch of entities of the specified type
 */
export async function createEntities<T extends EntityType>(
  entityType: T,
  count: number,
  options: Record<string, any> = {},
  overrides: Partial<any> = {}
): Promise<any[]> {
  if (count <= 0) {
    return [];
  }
  
  // Use the appropriate factory function based on entity type
  switch (entityType) {
    case 'user':
      return createUsers(count, overrides);
    case 'project':
      return options.owners 
        ? createProjectsWithOwners(count, options.owners, overrides)
        : Promise.all(Array(count).fill(0).map(() => createProject(options, overrides)));
    case 'task':
      return options.projects || options.assignees
        ? createTasksWithRelationships(count, options, overrides)
        : Promise.all(Array(count).fill(0).map(() => createTask(options, overrides)));
    case 'comment':
      return options.authors && (options.entities || (options.tasks && options.projects))
        ? createCommentsWithRelationships(count, options, overrides)
        : Promise.all(Array(count).fill(0).map(() => createComment(options, overrides)));
    default:
      throw new Error(`Unsupported entity type: ${entityType}`);
  }
}

/**
 * Fetch existing entities from database to use as references
 */
export async function fetchEntityReferences(
  dataSource: DataSource,
  options: {
    userCount?: number;
    projectCount?: number;
    taskCount?: number;
    commentCount?: number;
  } = {}
): Promise<Record<EntityType, any[]>> {
  const {
    userCount = 100,
    projectCount = 100,
    taskCount = 100,
    commentCount = 50
  } = options;
  
  const result: Record<EntityType, any[]> = {
    user: [],
    project: [],
    task: [],
    comment: []
  };
  
  try {
    // Fetch users
    const userRepo = dataSource.getRepository(getEntityClass('user'));
    result.user = await userRepo.find({ 
      select: ['id'],
      take: userCount,
      order: { createdAt: 'DESC' }
    });
    
    // Fetch projects
    const projectRepo = dataSource.getRepository(getEntityClass('project'));
    result.project = await projectRepo.find({ 
      select: ['id'],
      take: projectCount,
      order: { createdAt: 'DESC' }
    });
    
    // Fetch tasks
    const taskRepo = dataSource.getRepository(getEntityClass('task'));
    result.task = await taskRepo.find({ 
      select: ['id'],
      take: taskCount,
      order: { createdAt: 'DESC' }
    });
    
    // Fetch comments
    const commentRepo = dataSource.getRepository(getEntityClass('comment'));
    result.comment = await commentRepo.find({ 
      select: ['id'],
      take: commentCount,
      order: { createdAt: 'DESC' }
    });
    
    return result;
  } catch (error) {
    logger.error(`Error fetching entity references: ${error}`);
    return result;
  }
}

/**
 * Create entities with proper relationships in a single batch operation
 * This is the main entry point for batch entity creation
 */
export async function createEntitiesWithRelationships(
  options: BatchEntityOptions
): Promise<Record<EntityType, any[]>> {
  const result: Record<EntityType, any[]> = {
    user: [],
    project: [],
    task: [],
    comment: []
  };
  
  const { 
    counts, 
    dataSource, 
    preferExistingReferences = false,
    distribution = {
      projectsWithOwners: 1.0,
      tasksWithProjects: 0.8,
      tasksWithAssignees: 0.7,
      commentsOnTasks: 0.6
    }
  } = options;
  
  // Step 1: Fetch existing entities if requested and dataSource provided
  let existingEntities: Record<EntityType, any[]> = {
    user: [],
    project: [],
    task: [],
    comment: []
  };
  
  if (preferExistingReferences && dataSource) {
    existingEntities = await fetchEntityReferences(dataSource);
    logger.info(`Found ${existingEntities.user.length} users, ${existingEntities.project.length} projects, ${existingEntities.task.length} tasks, and ${existingEntities.comment.length} comments for entity references`);
  }
  
  // Step 2: Create entities in dependency order to establish proper relationships
  
  // Create users first (no dependencies)
  if (counts.user > 0) {
    logger.info(`Creating ${counts.user} users`);
    result.user = await createUsers(counts.user);
  }
  
  // Create projects with owners
  if (counts.project > 0) {
    const allUsers = [...result.user, ...existingEntities.user];
    if (allUsers.length > 0) {
      logger.info(`Creating ${counts.project} projects with owners`);
      result.project = await createProjectsWithOwners(counts.project, allUsers);
    } else {
      logger.warn(`Skipping ${counts.project} project creations - no users available`);
    }
  }
  
  // Create tasks with projects and assignees
  if (counts.task > 0) {
    const allProjects = [...result.project, ...existingEntities.project];
    const allUsers = [...result.user, ...existingEntities.user];
    
    if (allProjects.length > 0 || allUsers.length > 0) {
      logger.info(`Creating ${counts.task} tasks with relationships`);
      result.task = await createTasksWithRelationships(counts.task, {
        projects: allProjects,
        assignees: allUsers,
        projectRate: distribution.tasksWithProjects || 0.8,
        assigneeRate: distribution.tasksWithAssignees || 0.7
      });
    } else {
      logger.warn(`Skipping ${counts.task} task creations - no projects or users available`);
    }
  }
  
  // Create comments with authors and entities
  if (counts.comment > 0) {
    const allUsers = [...result.user, ...existingEntities.user];
    
    // Prepare entities for comments
    const commentEntities = [
      ...result.task.map(t => ({ id: t.id, type: 'task' as const })),
      ...result.project.map(p => ({ id: p.id, type: 'project' as const })),
      ...existingEntities.task.map(t => ({ id: t.id, type: 'task' as const })),
      ...existingEntities.project.map(p => ({ id: p.id, type: 'project' as const }))
    ];
    
    if (allUsers.length > 0 && commentEntities.length > 0) {
      logger.info(`Creating ${counts.comment} comments with relationships`);
      result.comment = await createCommentsWithRelationships(counts.comment, {
        authors: allUsers,
        entities: commentEntities,
        taskRate: distribution.commentsOnTasks || 0.6
      });
    } else {
      logger.warn(`Skipping ${counts.comment} comment creations - no authors or entities available`);
    }
  }
  
  // Return all created entities
  return result;
} 