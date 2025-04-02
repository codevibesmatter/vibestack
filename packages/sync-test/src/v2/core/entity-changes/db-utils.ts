/**
 * Database utilities for entity changes
 * Handles database connection and repository management
 */

import { DataSource, Repository } from 'typeorm';
import { serverDataSource } from '@repo/dataforge';
import { TableChange } from '@repo/sync-types';
import { v4 as uuidv4 } from 'uuid';
import { faker } from '@faker-js/faker';

import { createLogger } from '../logger.ts';
import { EntityType, EntityTypeMapping, getEntityClassForType, ORDERED_ENTITY_TYPES, TABLE_TO_ENTITY_MAP, ENTITY_TEMPLATES } from './entity-definitions.ts';
import { User, UserRole, Project, ProjectStatus, Task, TaskStatus, Comment } from '@repo/dataforge/server-entities';

// Initialize logger
const logger = createLogger('EntityChanges:DB');

// Use either the provided dataSource or create our own
let customDataSource: DataSource | null = null;

/**
 * Initialize the database connection
 */
export async function initialize(dataSource?: DataSource): Promise<boolean> {
  if (dataSource) {
    customDataSource = dataSource;
    logger.info('Using custom DataSource for database operations');
    
    // Initialize if needed
    if (!customDataSource.isInitialized) {
      await customDataSource.initialize();
    }
    
    return customDataSource.isInitialized;
  }
  
  logger.info('Using serverDataSource from @repo/dataforge');
  
  // Use serverDataSource from @repo/dataforge
  if (!serverDataSource) {
    logger.error('serverDataSource is undefined - cannot initialize database');
    return false;
  }
  
  // Initialize if needed
  if (!serverDataSource.isInitialized) {
    try {
      await serverDataSource.initialize();
    } catch (error) {
      logger.error(`Error initializing serverDataSource: ${error}`);
      return false;
    }
  }
  
  return serverDataSource.isInitialized;
}

/**
 * Get an active data source for database operations
 */
export async function getDataSource(): Promise<DataSource> {
  // If we have a custom data source, use it
  if (customDataSource) {
    if (!customDataSource.isInitialized) {
      await customDataSource.initialize();
    }
    return customDataSource;
  }
  
  // Otherwise use serverDataSource
  if (!serverDataSource) {
    throw new Error('Database connection not available - serverDataSource is undefined');
  }
  
  // Initialize if needed
  if (!serverDataSource.isInitialized) {
    await serverDataSource.initialize();
  }
  
  return serverDataSource;
}

/**
 * Get a TypeORM repository for an entity type
 */
export async function getRepository<T extends EntityType>(
  entityType: T
): Promise<Repository<EntityTypeMapping[T]>> {
  const dataSource = await getDataSource();
  const EntityClass = getEntityClassForType(entityType);
  return dataSource.getRepository(EntityClass);
}

/**
 * Fetch existing entity IDs from the database
 */
export async function fetchExistingEntityIds(
  entityTypes: EntityType[], 
  maxIdsToFetch: number = 50
): Promise<Record<EntityType, string[]>> {
  const existingIds: Record<EntityType, string[]> = {
    task: [],
    project: [],
    user: [],
    comment: []
  };
  
  try {
    // Get datasource
    const dataSource = await getDataSource();
    
    // Fetch IDs for each entity type
    for (const entityType of entityTypes) {
      const EntityClass = getEntityClassForType(entityType);
      const repository = dataSource.getRepository(EntityClass);
      
      // Fetch IDs
      const existingEntities = await repository.find({
        select: ['id'],
        take: maxIdsToFetch,
        order: { createdAt: 'DESC' }
      });
      
      existingIds[entityType] = existingEntities.map(e => e.id);
      
      if (existingIds[entityType].length > 0) {
        logger.debug(`Found ${existingIds[entityType].length} existing ${entityType} entities for updates/deletes`);
      }
    }
  } catch (error) {
    logger.warn(`Error fetching existing IDs: ${error}. Will generate new IDs.`);
  }
  
  return existingIds;
}

/**
 * Apply a batch of changes to the database
 */
export async function applyBatchChanges(
  tableChanges: TableChange[]
): Promise<TableChange[]> {
  if (!tableChanges.length) {
    logger.warn('No changes to apply');
    return [];
  }
  
  logger.info(`Applying batch of ${tableChanges.length} changes to database`);
  
  // Get a datasource
  const dataSource = await getDataSource();
  
  // Group changes by entity type and operation for more efficient processing
  const groupedChanges: Record<EntityType, Record<string, TableChange[]>> = {
    task: {},
    project: {},
    user: {},
    comment: {}
  };
  
  // Group by entity type and operation
  tableChanges.forEach(change => {
    // Map table name to entity type
    const entityType = TABLE_TO_ENTITY_MAP[change.table] || 
                      TABLE_TO_ENTITY_MAP[`"${change.table}"`];
                      
    if (!entityType) {
      logger.warn(`Unknown table: ${change.table}, skipping change`);
      return;
    }
    
    const operation = change.operation;
    if (!groupedChanges[entityType][operation]) {
      groupedChanges[entityType][operation] = [];
    }
    
    groupedChanges[entityType][operation].push(change);
  });
  
  // Process changes in a transaction
  const appliedChanges: TableChange[] = [];
  
  await dataSource.transaction(async (transactionalEntityManager: any) => {
    // First, create all the user entities (no dependencies)
    await processEntityCreates('user', groupedChanges, transactionalEntityManager, appliedChanges);
    
    // Then process projects (depends on users)
    await processEntityCreates('project', groupedChanges, transactionalEntityManager, appliedChanges);
    
    // Then tasks (depends on projects and users)
    await processEntityCreates('task', groupedChanges, transactionalEntityManager, appliedChanges);
    
    // Finally comments (depends on tasks, projects, and users)
    await processEntityCreates('comment', groupedChanges, transactionalEntityManager, appliedChanges);
    
    // Process all updates
    for (const entityType of ORDERED_ENTITY_TYPES) {
      await processEntityUpdates(entityType, groupedChanges, transactionalEntityManager, appliedChanges);
    }
    
    // Process all deletes in reverse dependency order
    for (const entityType of [...ORDERED_ENTITY_TYPES].reverse()) {
      await processEntityDeletes(entityType, groupedChanges, transactionalEntityManager, appliedChanges);
    }
  });
  
  logger.info(`Successfully applied ${appliedChanges.length} changes to database`);
  return appliedChanges;
}

/**
 * Process entity creates for a specific entity type
 */
async function processEntityCreates(
  entityType: EntityType,
  groupedChanges: Record<EntityType, Record<string, TableChange[]>>,
  transactionalEntityManager: any,
  appliedChanges: TableChange[]
): Promise<void> {
  const operations = groupedChanges[entityType];
  if (!operations.insert?.length) return;
  
  const repository = transactionalEntityManager.getRepository(getEntityClassForType(entityType));
  
  // For users, we can just create them directly
  if (entityType === 'user') {
    // Create users
    const userEntities = operations.insert.map(change => {
      const entity = new (getEntityClassForType(entityType))();
      Object.assign(entity, change.data);
      return entity;
    });
    
    // Save users
    try {
      const savedEntities = await repository.save(userEntities);
      
      // Mark as applied
      operations.insert.forEach((change, index) => {
        appliedChanges.push({
          ...change,
          data: { ...change.data, id: savedEntities[index].id },
          updated_at: new Date().toISOString()
        });
      });
    } catch (error) {
      logger.error(`Error creating users: ${error}`);
      throw error;
    }
    
    return;
  }
  
  // For other entity types, we need to check dependencies
  // Process in smaller batches to avoid excessive queries
  const batchSize = 5;
  
  for (let i = 0; i < operations.insert.length; i += batchSize) {
    const batch = operations.insert.slice(i, i + batchSize);
    const entities = [];
    
    // Process each entity in the batch
    for (const change of batch) {
      const entity = new (getEntityClassForType(entityType))();
      
      // Special handling based on entity type
      if (entityType === 'project') {
        // Verify owner exists, or create a random user
        const ownerId = change.data.ownerId as string;
        if (ownerId) {
          const ownerExists = await transactionalEntityManager
            .getRepository(User)
            .findOneBy({ id: ownerId });
            
          if (!ownerExists) {
            // Create a random user and set as owner
            const user = new User();
            user.id = ownerId;
            user.name = faker.person.fullName();
            user.email = faker.internet.email();
            user.role = faker.helpers.arrayElement(Object.values(UserRole));
            user.createdAt = new Date();
            user.updatedAt = new Date();
            
            const savedUser = await transactionalEntityManager.getRepository(User).save(user);
            logger.debug(`Created user ${savedUser.id} for project ${change.data.id as string}`);
          }
        }
      } else if (entityType === 'task') {
        // Verify project and assignee exist
        const projectId = change.data.projectId as string;
        const assigneeId = change.data.assigneeId as string;
        
        if (projectId) {
          const projectExists = await transactionalEntityManager
            .getRepository(Project)
            .findOneBy({ id: projectId });
            
          if (!projectExists) {
            // Create a random project
            const project = new Project();
            project.id = projectId;
            project.name = faker.company.name();
            project.description = faker.company.catchPhrase();
            project.status = faker.helpers.arrayElement(Object.values(ProjectStatus));
            
            // Create a random user for the project owner
            const ownerId = uuidv4();
            const user = new User();
            user.id = ownerId;
            user.name = faker.person.fullName();
            user.email = faker.internet.email();
            user.role = faker.helpers.arrayElement(Object.values(UserRole));
            user.createdAt = new Date();
            user.updatedAt = new Date();
            
            await transactionalEntityManager.getRepository(User).save(user);
            project.ownerId = ownerId;
            project.createdAt = new Date();
            project.updatedAt = new Date();
            
            const savedProject = await transactionalEntityManager.getRepository(Project).save(project);
            logger.debug(`Created project ${savedProject.id} for task ${change.data.id as string}`);
          }
        }
        
        if (assigneeId) {
          const assigneeExists = await transactionalEntityManager
            .getRepository(User)
            .findOneBy({ id: assigneeId });
            
          if (!assigneeExists) {
            // Create a random user for the assignee
            const user = new User();
            user.id = assigneeId;
            user.name = faker.person.fullName();
            user.email = faker.internet.email();
            user.role = faker.helpers.arrayElement(Object.values(UserRole));
            user.createdAt = new Date();
            user.updatedAt = new Date();
            
            const savedUser = await transactionalEntityManager.getRepository(User).save(user);
            logger.debug(`Created user ${savedUser.id} for task assignee ${change.data.id as string}`);
          }
        }
      } else if (entityType === 'comment') {
        // Verify task, user, and project exist
        const taskId = change.data.taskId as string;
        const userId = change.data.userId as string;
        const projectId = change.data.projectId as string;
        
        if (userId) {
          const userExists = await transactionalEntityManager
            .getRepository(User)
            .findOneBy({ id: userId });
            
          if (!userExists) {
            // Create a random user
            const user = new User();
            user.id = userId;
            user.name = faker.person.fullName();
            user.email = faker.internet.email();
            user.role = faker.helpers.arrayElement(Object.values(UserRole));
            user.createdAt = new Date();
            user.updatedAt = new Date();
            
            const savedUser = await transactionalEntityManager.getRepository(User).save(user);
            logger.debug(`Created user ${savedUser.id} for comment ${change.data.id as string}`);
          }
        }
        
        if (taskId) {
          const taskExists = await transactionalEntityManager
            .getRepository(Task)
            .findOneBy({ id: taskId });
            
          if (!taskExists) {
            // Create a random task
            const task = new Task();
            task.id = taskId;
            task.title = faker.lorem.sentence();
            task.description = faker.lorem.paragraph();
            task.status = faker.helpers.arrayElement(Object.values(TaskStatus));
            
            // Create a random project if no project ID provided
            const actualProjectId = projectId || uuidv4();
            
            const projectExists = await transactionalEntityManager
              .getRepository(Project)
              .findOneBy({ id: actualProjectId });
              
            if (!projectExists) {
              // Create a random project
              const project = new Project();
              project.id = actualProjectId;
              project.name = faker.company.name();
              project.description = faker.company.catchPhrase();
              project.status = faker.helpers.arrayElement(Object.values(ProjectStatus));
              
              // Create a random user for the project owner
              const ownerId = uuidv4();
              const user = new User();
              user.id = ownerId;
              user.name = faker.person.fullName();
              user.email = faker.internet.email();
              user.role = faker.helpers.arrayElement(Object.values(UserRole));
              user.createdAt = new Date();
              user.updatedAt = new Date();
              
              await transactionalEntityManager.getRepository(User).save(user);
              project.ownerId = ownerId;
              project.createdAt = new Date();
              project.updatedAt = new Date();
              
              const savedProject = await transactionalEntityManager.getRepository(Project).save(project);
              logger.debug(`Created project ${savedProject.id} for task ${taskId}`);
            }
            
            task.projectId = actualProjectId;
            
            // Create a random assignee
            const assigneeId = userId || uuidv4();
            const assigneeExists = await transactionalEntityManager
              .getRepository(User)
              .findOneBy({ id: assigneeId });
              
            if (!assigneeExists) {
              // Create a random user
              const user = new User();
              user.id = assigneeId;
              user.name = faker.person.fullName();
              user.email = faker.internet.email();
              user.role = faker.helpers.arrayElement(Object.values(UserRole));
              user.createdAt = new Date();
              user.updatedAt = new Date();
              
              await transactionalEntityManager.getRepository(User).save(user);
            }
            
            task.assigneeId = assigneeId;
            task.createdAt = new Date();
            task.updatedAt = new Date();
            
            const savedTask = await transactionalEntityManager.getRepository(Task).save(task);
            logger.debug(`Created task ${savedTask.id} for comment ${change.data.id as string}`);
          }
        }
      }
      
      // Now set all the data
      Object.assign(entity, change.data);
      entities.push(entity);
    }
    
    try {
      // Save all entities in the batch
      const savedEntities = await repository.save(entities);
      
      // Mark as applied
      batch.forEach((change, index) => {
        appliedChanges.push({
          ...change,
          data: { ...change.data, id: savedEntities[index].id },
          updated_at: new Date().toISOString()
        });
      });
    } catch (error) {
      logger.error(`Error creating ${entityType} entities: ${error}`);
      throw error;
    }
  }
}

/**
 * Process entity updates for a specific entity type
 */
async function processEntityUpdates(
  entityType: EntityType,
  groupedChanges: Record<EntityType, Record<string, TableChange[]>>,
  transactionalEntityManager: any,
  appliedChanges: TableChange[]
): Promise<void> {
  const operations = groupedChanges[entityType];
  if (!operations.update?.length) return;
  
  const repository = transactionalEntityManager.getRepository(getEntityClassForType(entityType));
  
  // Process updates one by one to handle errors better
  for (const change of operations.update) {
    try {
      const entityId = change.data.id as string;
      
      // Find the entity
      const entity = await repository.findOneBy({ id: entityId });
      if (!entity) {
        logger.warn(`Entity ${entityType} with ID ${entityId} not found for update. Will continue and create it.`);
        
        // Create a new entity with the provided ID
        const newEntity = new (getEntityClassForType(entityType))();
        Object.assign(newEntity, change.data);
        
        // Handle special case for each entity type (similar to creates)
        if (entityType === 'project') {
          // Verify owner exists, create if not
          const ownerId = change.data.ownerId as string;
          if (ownerId) {
            const ownerExists = await transactionalEntityManager
              .getRepository(User)
              .findOneBy({ id: ownerId });
              
            if (!ownerExists) {
              // Create a user with the specified ID
              const user = new User();
              user.id = ownerId;
              user.name = faker.person.fullName();
              user.email = faker.internet.email();
              user.role = faker.helpers.arrayElement(Object.values(UserRole));
              user.createdAt = new Date();
              user.updatedAt = new Date();
              
              await transactionalEntityManager.getRepository(User).save(user);
              logger.debug(`Created missing user ${ownerId} for project update ${entityId}`);
            }
          }
        } else if (entityType === 'task') {
          // Verify project and assignee exist
          const projectId = change.data.projectId as string;
          const assigneeId = change.data.assigneeId as string;
          
          if (projectId) {
            const projectExists = await transactionalEntityManager
              .getRepository(Project)
              .findOneBy({ id: projectId });
              
            if (!projectExists) {
              // Create a project with the specified ID
              const project = new Project();
              project.id = projectId;
              project.name = faker.company.name();
              project.description = faker.company.catchPhrase();
              project.status = faker.helpers.arrayElement(Object.values(ProjectStatus));
              
              // Create a random user for owner
              const ownerId = uuidv4();
              const user = new User();
              user.id = ownerId;
              user.name = faker.person.fullName();
              user.email = faker.internet.email();
              user.role = faker.helpers.arrayElement(Object.values(UserRole));
              user.createdAt = new Date();
              user.updatedAt = new Date();
              
              await transactionalEntityManager.getRepository(User).save(user);
              project.ownerId = ownerId;
              project.createdAt = new Date();
              project.updatedAt = new Date();
              
              await transactionalEntityManager.getRepository(Project).save(project);
              logger.debug(`Created missing project ${projectId} for task update ${entityId}`);
            }
          }
          
          if (assigneeId) {
            const assigneeExists = await transactionalEntityManager
              .getRepository(User)
              .findOneBy({ id: assigneeId });
              
            if (!assigneeExists) {
              // Create a user with the specified ID
              const user = new User();
              user.id = assigneeId;
              user.name = faker.person.fullName();
              user.email = faker.internet.email();
              user.role = faker.helpers.arrayElement(Object.values(UserRole));
              user.createdAt = new Date();
              user.updatedAt = new Date();
              
              await transactionalEntityManager.getRepository(User).save(user);
              logger.debug(`Created missing user ${assigneeId} for task update ${entityId}`);
            }
          }
        } else if (entityType === 'comment') {
          // Handle comment dependencies
          const taskId = change.data.taskId as string;
          const userId = change.data.userId as string;
          
          if (userId) {
            const userExists = await transactionalEntityManager
              .getRepository(User)
              .findOneBy({ id: userId });
              
            if (!userExists) {
              // Create a user with the specified ID
              const user = new User();
              user.id = userId;
              user.name = faker.person.fullName();
              user.email = faker.internet.email();
              user.role = faker.helpers.arrayElement(Object.values(UserRole));
              user.createdAt = new Date();
              user.updatedAt = new Date();
              
              await transactionalEntityManager.getRepository(User).save(user);
              logger.debug(`Created missing user ${userId} for comment update ${entityId}`);
            }
          }
          
          if (taskId) {
            const taskExists = await transactionalEntityManager
              .getRepository(Task)
              .findOneBy({ id: taskId });
              
            if (!taskExists) {
              // Create a task with the specified ID and a project
              const projectId = uuidv4();
              
              // Create project first
              const project = new Project();
              project.id = projectId;
              project.name = faker.company.name();
              project.description = faker.company.catchPhrase();
              project.status = faker.helpers.arrayElement(Object.values(ProjectStatus));
              
              // Create a random owner
              const ownerId = uuidv4();
              const owner = new User();
              owner.id = ownerId;
              owner.name = faker.person.fullName();
              owner.email = faker.internet.email();
              owner.role = faker.helpers.arrayElement(Object.values(UserRole));
              owner.createdAt = new Date();
              owner.updatedAt = new Date();
              
              await transactionalEntityManager.getRepository(User).save(owner);
              project.ownerId = ownerId;
              project.createdAt = new Date();
              project.updatedAt = new Date();
              
              await transactionalEntityManager.getRepository(Project).save(project);
              
              // Now create the task
              const task = new Task();
              task.id = taskId;
              task.title = faker.lorem.sentence();
              task.description = faker.lorem.paragraph();
              task.status = faker.helpers.arrayElement(Object.values(TaskStatus));
              task.projectId = projectId;
              task.assigneeId = userId || ownerId; // Use user ID if available, otherwise owner
              task.createdAt = new Date();
              task.updatedAt = new Date();
              
              await transactionalEntityManager.getRepository(Task).save(task);
              logger.debug(`Created missing task ${taskId} for comment update ${entityId}`);
            }
          }
        }
        
        // Save the new entity
        const savedEntity = await repository.save(newEntity);
        
        // Mark as applied
        appliedChanges.push({
          ...change,
          operation: 'insert', // Change operation to insert since we created it
          updated_at: new Date().toISOString()
        });
        
        logger.debug(`Created new ${entityType} entity ${entityId} during update operation`);
        continue;
      }
      
      // Update the entity
      Object.assign(entity, change.data);
      
      // Make sure createdAt is not modified
      if (entity.createdAt && change.data.createdAt) {
        entity.createdAt = new Date(entity.createdAt);
      }
      
      // Make sure updatedAt is set
      entity.updatedAt = new Date();
      
      // Save the updated entity
      await repository.save(entity);
      
      // Mark as applied
      appliedChanges.push({
        ...change,
        updated_at: new Date().toISOString()
      });
    } catch (error) {
      logger.error(`Error updating ${entityType} entity: ${error}`);
      // Don't throw, try to continue with other updates
    }
  }
}

/**
 * Process entity deletes for a specific entity type, respecting cascade relationships
 */
async function processEntityDeletes(
  entityType: EntityType,
  groupedChanges: Record<EntityType, Record<string, TableChange[]>>,
  transactionalEntityManager: any,
  appliedChanges: TableChange[]
): Promise<void> {
  const operations = groupedChanges[entityType];
  if (!operations.delete?.length) return;
  
  const repository = transactionalEntityManager.getRepository(getEntityClassForType(entityType));
  
  // Get the entity template with its dependencies
  const entityTemplate = ENTITY_TEMPLATES[entityType];
  
  // Process deletes one at a time to handle cascade dependencies properly
  for (const change of operations.delete) {
    const entityId = change.data.id as string;
    
    try {
      // Check if the entity exists
      const entity = await repository.findOneBy({ id: entityId });
      
      if (!entity) {
        logger.warn(`Entity ${entityType} with ID ${entityId} not found for deletion, skipping`);
        continue;
      }
      
      // Handle dependent entities (cascade delete)
      await handleCascadeDeletes(entityType, entityId, transactionalEntityManager);
      
      // Now delete the entity
      await repository.delete(entityId);
      
      // Mark as applied
      appliedChanges.push({
        ...change,
        updated_at: new Date().toISOString()
      });
      
    } catch (error) {
      logger.error(`Error deleting ${entityType} entity ${entityId}: ${error}`);
      // Don't throw, try to continue with other deletes
    }
  }
}

/**
 * Handle cascade deletes for dependent entities
 */
async function handleCascadeDeletes(
  entityType: EntityType,
  entityId: string,
  transactionalEntityManager: any
): Promise<void> {
  // Check which entity types might have dependencies on this entity
  switch (entityType) {
    case 'user':
      // When deleting a user, check for owned projects
      await deleteEntitiesWithDependency(
        'project',
        'ownerId',
        entityId,
        transactionalEntityManager
      );
      
      // Check for assigned tasks
      await deleteEntitiesWithDependency(
        'task', 
        'assigneeId', 
        entityId, 
        transactionalEntityManager
      );
      
      // Check for authored comments  
      await deleteEntitiesWithDependency(
        'comment', 
        'authorId', 
        entityId, 
        transactionalEntityManager
      );
      break;
      
    case 'project':
      // When deleting a project, delete all tasks in that project
      await deleteEntitiesWithDependency(
        'task', 
        'projectId', 
        entityId, 
        transactionalEntityManager
      );
      break;
      
    case 'task':
      // When deleting a task, delete all comments on that task
      await deleteEntitiesWithDependency(
        'comment', 
        'entityId', 
        entityId, 
        transactionalEntityManager,
        entity => entity.entityType === 'task' // Additional filter
      );
      break;
      
    case 'comment':
      // When deleting a comment, delete all child comments
      await deleteEntitiesWithDependency(
        'comment', 
        'parentId', 
        entityId, 
        transactionalEntityManager
      );
      break;
  }
}

/**
 * Delete entities that have a dependency on another entity
 */
async function deleteEntitiesWithDependency(
  entityType: EntityType,
  dependencyField: string,
  dependencyValue: string,
  transactionalEntityManager: any,
  additionalFilter?: (entity: any) => boolean
): Promise<void> {
  const repository = transactionalEntityManager.getRepository(getEntityClassForType(entityType));
  
  // Find all dependent entities
  const dependentEntities = await repository.findBy({ [dependencyField]: dependencyValue });
  
  // Apply additional filter if provided
  const filteredEntities = additionalFilter 
    ? dependentEntities.filter(additionalFilter) 
    : dependentEntities;
    
  if (filteredEntities.length === 0) {
    return;
  }
  
  logger.debug(`Found ${filteredEntities.length} ${entityType} entities dependent on ${dependencyField}=${dependencyValue}`);
  
  // For each dependent entity, handle its cascade deletes first
  for (const entity of filteredEntities) {
    // Recursively handle cascade deletes for this entity
    await handleCascadeDeletes(entityType, entity.id, transactionalEntityManager);
    
    // Delete the entity itself
    await repository.delete(entity.id);
    logger.debug(`Cascade deleted ${entityType} ${entity.id}`);
  }
} 