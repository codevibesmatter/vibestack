/**
 * Enhanced entity changes implementation using TypeORM and @dataforge entities
 * Provides a cleaner, more maintainable approach to generating test data
 * 
 * This module is divided into three main sections:
 * 1. Change Generation - Pure functions that generate changes in memory
 * 2. Database Operations - Functions that interact with the database
 */

// ----- IMPORTS -----
// External dependencies
import { faker } from '@faker-js/faker';
import { v4 as uuidv4 } from 'uuid';
import { DataSource, Repository, In, EntityTarget } from 'typeorm';

// DataForge entities and types
import { 
  TaskStatus, 
  TaskPriority,
  ProjectStatus,
  UserRole,
  User, 
  Project, 
  Task, 
  Comment,
  serverEntities,
  SERVER_DOMAIN_TABLES,
  SERVER_SYSTEM_TABLES
} from '@repo/dataforge/server-entities';
import { serverDataSource } from '@repo/dataforge';

// Import TableChange from sync-types package
import { TableChange } from '@repo/sync-types';

// Internal dependencies
import { createLogger } from './logger.ts';

// ----- CONFIGURATION -----
// Initialize logger
const logger = createLogger('EntityChanges');

// Create constants derived from SERVER_DOMAIN_TABLES for consistent mapping
// Dynamically build maps from the SERVER_DOMAIN_TABLES constant
const ENTITY_TO_TABLE_MAP: Record<EntityType, string> = {} as Record<EntityType, string>;
const TABLE_TO_ENTITY_MAP: Record<string, EntityType> = {};

// Build both maps from SERVER_DOMAIN_TABLES
SERVER_DOMAIN_TABLES.forEach(quotedTable => {
  // Strip quotes for easier comparison
  const tableName = quotedTable.replace(/"/g, '');
  
  // Convert plural table name to singular entity type
  const possibleEntityType = tableName.endsWith('s') 
    ? tableName.substring(0, tableName.length - 1) 
    : tableName;
    
  if (['task', 'project', 'user', 'comment'].includes(possibleEntityType)) {
    const entityType = possibleEntityType as EntityType;
    // Set both mappings
    TABLE_TO_ENTITY_MAP[quotedTable] = entityType;
    ENTITY_TO_TABLE_MAP[entityType] = tableName;
  }
});

// ----- TYPE DEFINITIONS -----
// Define entity types for better type safety
export type EntityType = 'task' | 'project' | 'user' | 'comment';

// Strongly typed mapping between EntityType and actual entity classes
type EntityTypeMapping = {
  'task': Task;
  'project': Project;
  'user': User;
  'comment': Comment;
};

// Entity type for working with TypeORM
type CustomRecord = Record<string, any>;

// Create our own DataSource instead of relying on the imported one
let dataSource: DataSource | null = null;

// ----- UTILITY FUNCTIONS -----

// Define TypeORM naming strategy transformation manually for each entity
type CommentEntityData = {
  id: string;
  content: string;
  // The entity uses snake_case in DB but TypeORM expects camelCase in TS
  entityType: string;  // Maps to entity_type in database
  entityId: string;    // Maps to entity_id in database
  authorId: string;    // Maps to author_id in database
  parentId?: string | null; // Maps to parent_id in database
  clientId?: string | null; // Maps to client_id in database
  createdAt: Date;     // Maps to created_at in database
  updatedAt: Date;     // Maps to updated_at in database
};

/**
 * Map EntityType strings to actual entity classes
 */
function getEntityClassForType(entityType: EntityType): any {
  switch (entityType) {
    case 'task':
      return Task;
    case 'project':
      return Project;
    case 'user':
      return User;
    case 'comment':
      return Comment;
    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }
}

/**
 * Get a list of all supported entity types
 */
function getEntityTypeList(): EntityType[] {
  return Object.keys(ENTITY_TO_TABLE_MAP) as EntityType[];
}

/**
 * Get the table name for an entity type
 */
function getTableNameForEntityType(entityType: EntityType): string {
  // Use the ENTITY_TO_TABLE_MAP constant
  const tableName = ENTITY_TO_TABLE_MAP[entityType];
  
  // Look for this table in SERVER_DOMAIN_TABLES
  const quotedTableName = SERVER_DOMAIN_TABLES.find(t => 
    t.includes(`"${tableName}"`) || t === `"${tableName}"`
  );
  
  // If found in domain tables, return it (with quotes stripped)
  if (quotedTableName) {
    return quotedTableName.replace(/"/g, '');
  }
  
  // Fallback to the mapped name
  return tableName;
}

/**
 * Map a table name back to an entity type
 */
function getEntityTypeForTableName(tableName: string): EntityType | undefined {
  // Check if the table is in SERVER_DOMAIN_TABLES
  // First, add quotes if they're not already there
  const quotedName = tableName.startsWith('"') ? tableName : `"${tableName}"`;
  
  // Use the TABLE_TO_ENTITY_MAP constant
  if (TABLE_TO_ENTITY_MAP[quotedName]) {
    return TABLE_TO_ENTITY_MAP[quotedName];
  }
  
  // Look for an exact match in SERVER_DOMAIN_TABLES
  for (const domainTable of SERVER_DOMAIN_TABLES) {
    if (domainTable === quotedName || domainTable.includes(quotedName)) {
      return TABLE_TO_ENTITY_MAP[domainTable];
    }
  }

  // Fallback to simple matching by removing 's'
  const possibleEntityType = tableName.endsWith('s') 
    ? tableName.substring(0, tableName.length - 1) 
    : tableName;
    
  if (getEntityTypeList().includes(possibleEntityType as EntityType)) {
    return possibleEntityType as EntityType;
  }

  return undefined;
}

/**
 * Get a random enum value
 */
function getRandomEnum<T extends Record<string, any>>(enumObj: T): any {
  const values = Object.values(enumObj);
  const randomIndex = Math.floor(Math.random() * values.length);
  return values[randomIndex];
}

// ----- CHANGE GENERATION -----
/**
 * Generate a properly-typed entity instance with default values
 */
function generateEntity<K extends EntityType>(
  entityType: K, 
  overrides: Partial<EntityTypeMapping[K]> = {}
): EntityTypeMapping[K] {
  const EntityClass = getEntityClassForType(entityType);
  const entity = new EntityClass() as EntityTypeMapping[K];
  
  // Common defaults for all entity types
  const now = new Date();
  
  // Use type-specific properties based on entity type
  switch (entityType) {
    case 'task': {
      const task = entity as Task;
      task.title = faker.company.catchPhrase();
      task.description = faker.lorem.paragraph();
      task.status = faker.helpers.arrayElement(Object.values(TaskStatus));
      task.priority = faker.helpers.arrayElement(Object.values(TaskPriority));
      task.due_date = faker.date.future();
      task.project_id = uuidv4();
      task.assignee_id = uuidv4();
      task.created_at = now;
      task.updated_at = now;
      task.tags = [faker.word.sample(), faker.word.sample()];
      break;
    }
    
    case 'project': {
      const project = entity as Project;
      project.name = faker.company.name();
      project.description = faker.company.catchPhrase();
      project.status = faker.helpers.arrayElement(Object.values(ProjectStatus));
      project.owner_id = uuidv4();
      project.created_at = now;
      project.updated_at = now;
      break;
    }
    
    case 'user': {
      const user = entity as User;
      user.name = faker.person.fullName();
      user.email = faker.internet.email();
      user.role = faker.helpers.arrayElement(Object.values(UserRole));
      user.created_at = now;
      user.updated_at = now;
      break;
    }
    
    case 'comment': {
      const comment = entity as Comment;
      comment.content = faker.lorem.paragraph();
      comment.entity_type = 'task';
      comment.entity_id = uuidv4();
      comment.author_id = uuidv4();
      comment.parent_id = null;
      comment.client_id = null;
      comment.created_at = now;
      comment.updated_at = now;
      break;
    }
  }
  
  // Apply any overrides
  Object.assign(entity, overrides);
  
  return entity;
}

/**
 * Create a single entity in memory (no database interaction)
 * This is a pure function that generates entity data with fake values
 */
export function generateEntity<T extends Record<string, any>>(
  entityType: EntityType,
  data: Partial<T> = {}
): T {
  // Get default values for this entity type
  const defaults = generateEntity(entityType, data);
  
  // Merge defaults with provided data
  const entity = {
    ...defaults,
    ...data
  } as T;
  
  return entity;
}

/**
 * Generate multiple entities in memory (no database interaction)
 * @param entityType Type of entity to generate
 * @param count Number of entities to generate
 * @param customData Optional custom data to apply to each entity
 * @returns Array of generated entities
 */
export function generateEntities<T extends Record<string, any>>(
  entityType: EntityType,
  count: number,
  customData: Partial<T> = {}
): T[] {
  const entities: T[] = [];
  
  for (let i = 0; i < count; i++) {
    // Generate a unique entity with optional custom data
    entities.push(generateEntity<T>(entityType, customData));
  }
  
  return entities;
}

/**
 * Generate a mix of changes across multiple entity types
 * This is a pure function that doesn't interact with the database
 * 
 * @param count Total number of changes to generate
 * @param distribution Optional distribution of changes across entity types (e.g. {task: 0.7, project: 0.3})
 * @returns Object with changes organized by entity type and operation
 */
export function generateChanges(
  count: number,
  distribution: Record<string, number> = {}
): { 
  changes: Record<string, Record<string, string[]>>
} {
  logger.info(`Generating ${count} changes in memory across entity types`);
  
  // Get all supported entity types
  const entityTypes = getEntityTypeList();
  const actualDistribution: Record<string, number> = {};
  
  // If distribution is provided, use it
  if (Object.keys(distribution).length > 0) {
    let totalWeight = 0;
    
    // Calculate total weight
    entityTypes.forEach(type => {
      totalWeight += distribution[type] || 0;
    });
    
    // Normalize weights to sum to 1
    entityTypes.forEach(type => {
      actualDistribution[type] = (distribution[type] || 0) / totalWeight;
    });
  } else {
    // Equal distribution
    entityTypes.forEach(type => {
      actualDistribution[type] = 1 / entityTypes.length;
    });
  }
  
  // Distribute count across entity types
  const entityCounts: Record<string, number> = {};
  let remainingCount = count;
  
  entityTypes.forEach((type, index) => {
    if (index === entityTypes.length - 1) {
      // Last type gets all remaining counts
      entityCounts[type] = remainingCount;
    } else {
      // Calculate count based on distribution
      const typeCount = Math.floor(count * actualDistribution[type]);
      entityCounts[type] = typeCount;
      remainingCount -= typeCount;
    }
  });
  
  // Generate changes for each entity type
  const result: Record<string, Record<string, string[]>> = {};
  
  for (const entityType of entityTypes) {
    const typeCount = entityCounts[entityType];
    
    if (typeCount <= 0) {
      continue;
    }
    
    // Default operation distribution
    const opDistribution = { create: 0.6, update: 0.3, delete: 0.1 };
    
    // Calculate operation counts
    const createCount = Math.floor(typeCount * opDistribution.create);
    const updateCount = Math.floor(typeCount * opDistribution.update);
    const deleteCount = typeCount - createCount - updateCount;
    
    // Initialize result structure
    if (!result[entityType]) {
      result[entityType] = {
        create: [],
        update: [],
        delete: []
      };
    }
    
    // Generate change IDs for each operation
    for (let i = 0; i < createCount; i++) {
      result[entityType].create.push(uuidv4());
    }
    
    for (let i = 0; i < updateCount; i++) {
      result[entityType].update.push(uuidv4());
    }
    
    for (let i = 0; i < deleteCount; i++) {
      result[entityType].delete.push(uuidv4());
    }
  }
  
  logger.info('Finished generating changes in memory');
  return { changes: result };
}

// ----- DATABASE OPERATIONS -----
/**
 * Initialize the database connection and ensure tables exist
 */
export async function initialize(params?: any): Promise<boolean> {
  logger.info('Initializing database connection with TypeORM');
  
  try {
    // Check if we have a valid serverDataSource from @repo/dataforge
    if (!serverDataSource) {
      logger.error('serverDataSource is undefined - cannot initialize database');
      return false;
    }
    
    // Get and initialize the data source if needed
    const dataSource = await getDataSource();
    
    if (!dataSource.isInitialized) {
      logger.error('Failed to initialize data source');
      return false;
    }
    
    // Verify tables exist by querying each one
    for (const entityType of getEntityTypeList()) {
      try {
        const repository = await getRepository(entityType);
        const count = await repository.count();
        const tableName = getTableNameForEntityType(entityType);
        logger.info(`Table ${tableName} exists with ${count} records`);
      } catch (error) {
        const tableName = getTableNameForEntityType(entityType);
        logger.error(`Error verifying table ${tableName}: ${error}`);
        return false;
      }
    }
    
    logger.info('Database initialization complete');
    return true;
  } catch (error) {
    logger.error(`Database initialization failed: ${error}`);
    return false;
  }
}

/**
 * Get TypeORM connection for the database
 */
async function getDataSource(): Promise<DataSource> {
  // Check if serverDataSource exists
  if (!serverDataSource) {
    logger.error('serverDataSource is undefined - cannot get data source');
    throw new Error('Database connection not available');
  }
  
  // Initialize if needed
  if (!serverDataSource.isInitialized) {
    await serverDataSource.initialize();
  }
  return serverDataSource;
}

/**
 * Get a TypeORM repository for an entity type with proper typing
 */
async function getRepository<K extends EntityType>(entityType: K): Promise<Repository<EntityTypeMapping[K]>> {
  const dataSource = await getDataSource();
  const EntityClass = getEntityClassForType(entityType);
  return dataSource.getRepository(EntityClass) as Repository<EntityTypeMapping[K]>;
}

/**
 * Get a random entity ID of the specified type from the database
 */
export async function getRandomEntityId(entityType: EntityType): Promise<string> {
  const repository = await getRepository(entityType);
  
  try {
    // Try to get a real entity from the database
    const entities = await repository.find({
      select: ['id'],
      order: { created_at: 'DESC' },
      take: 1
    });
    
    if (entities && entities.length > 0) {
      return entities[0].id;
    }
    
    // If no entity exists, create one
    logger.info(`No existing ${entityType} found, creating one`);
    
    // Create a new entity
    const newEntity = await createEntity(entityType);
    const savedEntity = await repository.save(newEntity);
    return savedEntity.id;
  } catch (error) {
    logger.error(`Error getting random ${entityType}: ${error}`);
    throw error;
  }
}

/**
 * Create an entity in the database using TypeORM
 */
async function createEntity<T extends Record<string, any>>(
  entityType: EntityType,
  data: Partial<T> = {}
): Promise<T> {
  // Generate the entity data in memory
  const entityData = generateEntity(entityType, data);
  
  // For Comment entities, ensure we only use snake_case property names
  if (entityType === 'comment') {
    // Remove any camelCase properties that might have been added earlier 
    // Our database inspection confirmed only snake_case properties exist
    const cleanData = { ...entityData };
    delete cleanData.entityType;
    delete cleanData.entityId;
    delete cleanData.authorId;
    delete cleanData.parentId;
    
    // Create a TypeORM entity instance with clean data
    const EntityClass = getEntityClassForType(entityType);
    const entity = new (EntityClass as any)();
    Object.assign(entity, cleanData);
    return entity as T;
  }
  
  // Create a TypeORM entity instance
  const EntityClass = getEntityClassForType(entityType);
  const entity = new (EntityClass as any)();
  
  // Copy data to the TypeORM entity
  Object.assign(entity, entityData);
  
  return entity as T;
}

/**
 * Create entities in the database
 * 
 * @param entityType Type of entity to create
 * @param count Number of entities to create
 * @param customData Optional custom data to apply to each entity
 * @returns Array of created entity IDs
 */
export async function createEntities(
  entityType: EntityType,
  count: number,
  customData: Record<string, any> = {}
): Promise<string[]> {
  logger.info(`Creating ${count} ${entityType} entities in database...`);
  
  try {
    const repository = await getRepository(entityType);
    const ids: string[] = [];
    
    // Create entities in batches to avoid memory issues
    const batchSize = 20;
    
    for (let i = 0; i < count; i += batchSize) {
      const batchCount = Math.min(batchSize, count - i);
      const batch: Record<string, any>[] = [];
      
      // Create TypeORM entities
      for (let j = 0; j < batchCount; j++) {
        const entity = await createEntity(entityType, customData);
        batch.push(entity);
      }
      
      // Save to database
      const savedEntities = await repository.save(batch);
      const batchIds = savedEntities.map(entity => entity.id);
      ids.push(...batchIds);
      
      logger.info(`Saved batch of ${batch.length} ${entityType} entities`);
      
      // Small delay to avoid overwhelming the database
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    logger.info(`Successfully created ${ids.length} ${entityType} entities`);
    return ids;
  } catch (error) {
    logger.error(`Error creating ${entityType} entities: ${error}`);
    throw error;
  }
}

/**
 * Update entities in the database
 * 
 * @param entityType Type of entity to update
 * @param count Number of entities to update
 * @returns Array of updated entity IDs
 */
export async function updateEntities(
  entityType: EntityType,
  count: number
): Promise<string[]> {
  logger.info(`Updating ${count} ${entityType} entities...`);
  
  try {
    const repository = await getRepository(entityType);
    
    // Find entities to update
    const entities = await repository.find({
      take: count,
      order: { created_at: 'DESC' }
    });
    
    if (entities.length === 0) {
      logger.warn(`No ${entityType} entities found to update`);
      return [];
    }
      
      // Apply updates based on entity type
    entities.forEach((entity: Record<string, any>) => {
        // Update common fields
        entity.updated_at = new Date();
        
        // Entity-specific updates
        switch (entityType) {
          case 'task':
            entity.title = `Updated ${entity.title}`;
            if (Math.random() > 0.5) {
              entity.status = getRandomEnum(TaskStatus);
            }
            break;
            
          case 'project':
            entity.name = `Updated ${entity.name}`;
            if (Math.random() > 0.5) {
              entity.status = getRandomEnum(ProjectStatus);
            }
            break;
            
    case 'user':
            entity.name = `Updated ${entity.name}`;
            break;
            
    case 'comment':
            entity.content = `Updated ${entity.content}`;
            entity.updated_at = new Date();
            break;
        }
      });
      
      // Save updates
    const updatedEntities = await repository.save(entities);
    const ids = updatedEntities.map((entity: Record<string, any>) => entity.id);
    
    logger.info(`Successfully updated ${ids.length} ${entityType} entities`);
    return ids;
  } catch (error) {
    logger.error(`Error updating ${entityType} entities: ${error}`);
    throw error;
  }
}

/**
 * Delete entities from the database
 * 
 * @param entityType Type of entity to delete
 * @param count Number of entities to delete (max 5 for safety)
 * @returns Array of deleted entity IDs
 */
export async function deleteEntities(
  entityType: EntityType,
  count: number
): Promise<string[]> {
  // Limit delete count for safety
  const effectiveCount = Math.min(count, 5);
  logger.info(`Deleting ${effectiveCount} ${entityType} entities...`);
  
  try {
    const repository = await getRepository(entityType);
    
    // For tasks, find ones that don't have dependencies
    let entities;
    
    if (entityType === 'task') {
      entities = await repository.find({
        take: effectiveCount,
        order: { created_at: 'ASC' }
      });
    } else if (entityType === 'project') {
      // For projects, find ones with no tasks
      const projectsWithoutTasks = await repository
        .createQueryBuilder('project')
        .leftJoin('tasks', 'task', 'task.project_id = project.id')
        .where('task.id IS NULL')
        .take(effectiveCount)
        .getMany();
      
      entities = projectsWithoutTasks;
    } else {
      // For other entities, just get the oldest ones
      entities = await repository.find({
        take: effectiveCount,
        order: { created_at: 'ASC' }
      });
    }
    
    if (entities.length === 0) {
      logger.warn(`No ${entityType} entities found to delete`);
      return [];
    }
    
    // Extract IDs before deletion
    const ids = entities.map((entity: Record<string, any>) => entity.id);
    
    // Delete the entities
    await repository.remove(entities);
    
    logger.info(`Successfully deleted ${ids.length} ${entityType} entities`);
    return ids;
  } catch (error) {
    logger.error(`Error deleting ${entityType} entities: ${error}`);
    throw error;
  }
}

/**
 * Apply a batch of table changes to the database
 */
export async function applyChangeBatch(
  tableChanges: TableChange[]
): Promise<TableChange[]> {
  if (tableChanges.length === 0) {
    logger.warn('No changes to apply');
    return [];
  }
  
  logger.info(`Applying batch of ${tableChanges.length} changes to database`);
  
  // Group changes by entity type and operation for more efficient processing
  const groupedChanges: Record<string, Record<string, TableChange[]>> = {};
  
  // Group changes by entity type and operation
  tableChanges.forEach(change => {
    // Map table names back to entity types
    const entityType = getEntityTypeForTableName(change.table);
    if (!entityType) {
      logger.warn(`Unknown table: ${change.table}`);
      return;
    }
    
    if (!groupedChanges[entityType]) {
      groupedChanges[entityType] = {};
    }
    
    const operation = change.operation;
    if (!groupedChanges[entityType][operation]) {
      groupedChanges[entityType][operation] = [];
    }
    
    groupedChanges[entityType][operation].push(change);
  });
  
  // Apply changes by entity type and operation
  const appliedChanges: TableChange[] = [];
  
  for (const [entityType, operations] of Object.entries(groupedChanges)) {
    for (const [operation, opChanges] of Object.entries(operations)) {
      logger.info(`Processing ${opChanges.length} ${operation} operations for ${entityType}`);
      
      try {
        const repository = await getRepository(entityType as EntityType);
        const batchSize = 10;
        
        for (let i = 0; i < opChanges.length; i += batchSize) {
          const batch = opChanges.slice(i, i + batchSize);
          
          switch (operation) {
            case 'insert': {
              // Create new entities
              const entities = await Promise.all(
                batch.map(async change => await createEntity(entityType as EntityType, change.data))
              );
              
              // Save to database
              const savedEntities = await repository.save(entities);
              
              // Map to applied changes
              const appliedBatch = batch.map((change, index) => ({
                ...change,
                id: savedEntities[index].id,
                updated_at: new Date().toISOString()
              }));
              
              appliedChanges.push(...appliedBatch);
              break;
            }
            
            case 'update': {
              // Find entities to update - ID is in data.id, not directly on change
              const ids = batch.map(change => change.data.id);
              const entitiesToUpdate = await repository.findBy({ id: In(ids) });
              
              // Apply updates
              for (const change of batch) {
                const entity = entitiesToUpdate.find(e => e.id === change.data.id);
                if (entity) {
                  Object.assign(entity, change.data, { updated_at: new Date() });
                }
              }
              
              // Save updates
              const updatedEntities = await repository.save(entitiesToUpdate);
              
              // Map to applied changes
              const appliedBatch = batch.map(change => ({
                ...change,
                updated_at: new Date().toISOString()
              }));
              
              appliedChanges.push(...appliedBatch);
              break;
            }
            
            case 'delete': {
              // Find entities to delete - ID is in data.id, not directly on change
              const ids = batch.map(change => change.data.id);
              const entitiesToDelete = await repository.findBy({ id: In(ids) });
              
              if (entitiesToDelete.length > 0) {
                // Delete entities
                await repository.remove(entitiesToDelete);
              }
              
              // Map to applied changes
              const appliedBatch = batch.map(change => ({
                ...change,
                updated_at: new Date().toISOString()
              }));
              
              appliedChanges.push(...appliedBatch);
              break;
            }
          }
        }
      } catch (error) {
        logger.error(`Error applying ${entityType} ${operation} changes: ${error}`);
        
        // Add changes to the result even if they failed
        const errorChanges = opChanges.map(change => ({
          ...change,
          updated_at: new Date().toISOString()
        }));
        
        appliedChanges.push(...errorChanges);
      }
    }
  }
  
  logger.info(`Successfully applied ${appliedChanges.length} changes to database`);
  return appliedChanges;
}

/**
 * Apply changes to the database
 * 
 * @param changes Changes generated by generateChanges
 * @returns Array of applied changes
 */
export async function applyChanges(
  changes: { changes: Record<string, Record<string, string[]>> }
): Promise<TableChange[]> {
  logger.info('Applying generated changes to database');
  
  // Convert the changes to TableChange format
  const tableChanges: TableChange[] = [];
  
  Object.entries(changes.changes).forEach(([entityType, operations]) => {
    // Get table name from entity type
    const tableName = getTableNameForEntityType(entityType as EntityType);
    
    if (!tableName) {
      logger.warn(`Unknown entity type: ${entityType}`);
      return;
    }
    
    // Process each operation
    Object.entries(operations).forEach(([operation, ids]) => {
      if (!Array.isArray(ids)) return;
      
      // Map operation names
      const dbOperation = operation === 'create' ? 'insert' : operation;
      
      // Create TableChange objects - id should be in the data property, not directly
      ids.forEach(id => {
        // Create a valid TableChange without id property directly on it
        const change: TableChange = {
          table: tableName,
          operation: dbOperation as 'insert' | 'update' | 'delete',
          data: typeof id === 'string' 
            ? { id } // If id is a string, include it in data object
            : (id as any), // Otherwise use the provided data object
          updated_at: new Date().toISOString()
        };
        
        tableChanges.push(change);
      });
    });
  });
  
  if (tableChanges.length === 0) {
    logger.warn('No changes to apply');
    return [];
  }
  
  // Apply the changes
  return await applyChangeBatch(tableChanges);
}

// ----- COMBINED OPERATIONS -----
/**
 * Generate and apply changes in a single operation
 * 
 * @param count Number of changes to generate
 * @param distribution Optional distribution of changes across entity types
 * @returns Result of the operation
 */
export async function generateAndApplyChanges(
  count: number,
  distribution: Record<string, number> = {}
): Promise<{
  success: boolean;
  changes: TableChange[];
  error?: string;
}> {
  try {
    logger.info(`Generating and applying ${count} changes in a single operation`);
    
    // Step 1: Generate the changes in memory
    const generatedChanges = generateChanges(count, distribution);
    
    if (!generatedChanges || !generatedChanges.changes) {
      logger.error('Failed to generate changes in memory');
      return { 
        success: false, 
        changes: [],
        error: 'Failed to generate changes'
      };
    }
    
    // Step 2: Apply the changes to the database
    const appliedChanges = await applyChanges(generatedChanges);
    
    if (!appliedChanges || appliedChanges.length === 0) {
      logger.error('Failed to apply generated changes to database');
      return {
        success: false,
        changes: [],
        error: 'Failed to apply changes'
      };
    }
    
    logger.info(`Successfully generated and applied ${appliedChanges.length} changes`);
    
    return {
      success: true,
      changes: appliedChanges
    };
  } catch (error) {
    logger.error(`Error in generateAndApplyChanges: ${error}`);
    return {
      success: false,
      changes: [],
      error: String(error)
    };
  }
}