/**
 * Entity Adapter
 * 
 * A comprehensive adapter between dataforge entities and the entity-changes system.
 * Provides direct access to dataforge entities and manages entity relationships.
 */

// Direct imports from dataforge
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
import { In } from 'typeorm';
import { getDataSource } from './change-applier.ts';
import { createLogger } from '../logger.ts';

// Create logger for this module
const logger = createLogger('EntityChanges:EntityAdapter');

// Simple entity type definition
export type EntityType = 'user' | 'project' | 'task' | 'comment';

// Define relationship types
export type RelationshipType = 'one-to-many' | 'many-to-one' | 'many-to-many' | 'one-to-one';

// Define relationship structure
export interface EntityRelationship {
  type: RelationshipType;
  sourceEntity: EntityType;
  targetEntity: EntityType;
  sourceField: string; // Foreign key in source or primary key for one-to-many
  targetField: string; // Foreign key in target or primary key for many-to-one
  inverseName?: string; // Name of the inverse relationship
  cascade?: boolean; // Whether operations cascade through this relationship
}

// Direct mapping to dataforge entity classes
export const EntityClasses = {
  user: User,
  project: Project,
  task: Task,
  comment: Comment
};

// Enums re-exported for convenience
export const Enums = {
  TaskStatus,
  TaskPriority,
  ProjectStatus,
  UserRole
};

// Simple table name mappings
export const ENTITY_TO_TABLE = {
  user: 'users',
  project: 'projects',
  task: 'tasks',
  comment: 'comments'
};

// Create reverse mapping for convenience
export const TABLE_TO_ENTITY: Record<string, EntityType> = {};

// Build the reverse mapping
Object.entries(ENTITY_TO_TABLE).forEach(([entityType, tableName]) => {
  TABLE_TO_ENTITY[tableName] = entityType as EntityType;
  // Also add quoted version for SQL compatibility
  TABLE_TO_ENTITY[`"${tableName}"`] = entityType as EntityType;
});

// Entity ordering for operations that need to respect dependencies
export const DEPENDENCY_ORDER: EntityType[] = ['user', 'project', 'task', 'comment'];

// Required relations for each entity type
export const REQUIRED_RELATIONS = {
  user: [],
  project: ['ownerId'],
  task: ['projectId', 'assigneeId'],
  comment: ['authorId', 'entityId']
};

// Comprehensive relationship model
export const ENTITY_RELATIONSHIPS: EntityRelationship[] = [
  // User relationships
  {
    type: 'one-to-many',
    sourceEntity: 'user',
    targetEntity: 'project',
    sourceField: 'id',
    targetField: 'ownerId',
    inverseName: 'projects',
    cascade: true
  },
  {
    type: 'one-to-many',
    sourceEntity: 'user',
    targetEntity: 'task',
    sourceField: 'id',
    targetField: 'assigneeId',
    inverseName: 'tasks',
    cascade: false
  },
  {
    type: 'one-to-many',
    sourceEntity: 'user',
    targetEntity: 'comment',
    sourceField: 'id',
    targetField: 'authorId',
    inverseName: 'comments',
    cascade: true
  },
  
  // Project relationships
  {
    type: 'many-to-one',
    sourceEntity: 'project',
    targetEntity: 'user',
    sourceField: 'ownerId',
    targetField: 'id',
    inverseName: 'owner',
    cascade: false
  },
  {
    type: 'one-to-many',
    sourceEntity: 'project',
    targetEntity: 'task',
    sourceField: 'id',
    targetField: 'projectId',
    inverseName: 'tasks',
    cascade: true
  },
  
  // Task relationships
  {
    type: 'many-to-one',
    sourceEntity: 'task',
    targetEntity: 'project',
    sourceField: 'projectId',
    targetField: 'id',
    inverseName: 'project',
    cascade: false
  },
  {
    type: 'many-to-one',
    sourceEntity: 'task',
    targetEntity: 'user',
    sourceField: 'assigneeId',
    targetField: 'id',
    inverseName: 'assignee',
    cascade: false
  },
  {
    type: 'one-to-many',
    sourceEntity: 'task',
    targetEntity: 'comment',
    sourceField: 'id',
    targetField: 'entityId',
    inverseName: 'comments',
    cascade: true
  },
  
  // Comment relationships
  {
    type: 'many-to-one',
    sourceEntity: 'comment',
    targetEntity: 'user',
    sourceField: 'authorId',
    targetField: 'id',
    inverseName: 'author',
    cascade: false
  },
  {
    type: 'many-to-one',
    sourceEntity: 'comment',
    targetEntity: 'task',
    sourceField: 'entityId',
    targetField: 'id',
    inverseName: 'task',
    cascade: false
  }
];

// Generate the CASCADE_RELATIONS object from ENTITY_RELATIONSHIPS for backward compatibility
export const CASCADE_RELATIONS = ENTITY_RELATIONSHIPS.reduce((acc, relationship) => {
  if (relationship.cascade && relationship.type === 'one-to-many') {
    if (!acc[relationship.sourceEntity]) {
      acc[relationship.sourceEntity] = [];
    }
    if (relationship.inverseName && !acc[relationship.sourceEntity].includes(relationship.inverseName)) {
      acc[relationship.sourceEntity].push(relationship.inverseName);
    }
  }
  return acc;
}, {
  user: [],
  project: [],
  task: [],
  comment: []
} as Record<EntityType, string[]>);

/**
 * Get entity class from entity type
 */
export function getEntityClass(entityType: EntityType): typeof User | typeof Project | typeof Task | typeof Comment {
  return EntityClasses[entityType];
}

/**
 * Get table name for entity type
 */
export function getTableName(entityType: EntityType): string {
  return ENTITY_TO_TABLE[entityType];
}

/**
 * Get entity type from entity instance
 */
export function getEntityType(entity: User | Project | Task | Comment | Record<string, any>): EntityType {
  if (entity instanceof User) return 'user';
  if (entity instanceof Project) return 'project';
  if (entity instanceof Task) return 'task';
  if (entity instanceof Comment) return 'comment';
  
  // Fallback for plain objects or instanceof failures
  if (entity && typeof entity === 'object') {
    // Check for __entityType marker
    if (entity.__entityType && ['user', 'project', 'task', 'comment'].includes(entity.__entityType)) {
      return entity.__entityType as EntityType;
    }
    
    // Check constructor name
    const constructorName = entity.constructor?.name?.toLowerCase();
    if (constructorName && ['user', 'project', 'task', 'comment'].includes(constructorName)) {
      return constructorName as EntityType;
    }
    
    // Add property-based checks as a more robust fallback
    if ('email' in entity && 'role' in entity) return 'user';
    if ('status' in entity && 'ownerId' in entity) return 'project'; // Project has status and ownerId
    if ('status' in entity && 'priority' in entity && 'projectId' in entity) return 'task'; // Task has status, priority, projectId
    if ('content' in entity && 'authorId' in entity && 'entityId' in entity) return 'comment'; // Comment has content, authorId, entityId
  }
  
  // Only throw if all checks fail
  throw new Error(`Unknown entity type for entity: ${JSON.stringify(entity)}`);
}

/**
 * Get all relationships where the given entity type is the source
 */
export function getOutgoingRelationships(entityType: EntityType): EntityRelationship[] {
  return ENTITY_RELATIONSHIPS.filter(rel => rel.sourceEntity === entityType);
}

/**
 * Get all relationships where the given entity type is the target
 */
export function getIncomingRelationships(entityType: EntityType): EntityRelationship[] {
  return ENTITY_RELATIONSHIPS.filter(rel => rel.targetEntity === entityType);
}

/**
 * Find a specific relationship between two entity types
 */
export function findRelationship(
  sourceType: EntityType,
  targetType: EntityType,
  inverseName?: string
): EntityRelationship | undefined {
  return ENTITY_RELATIONSHIPS.find(rel => 
    rel.sourceEntity === sourceType && 
    rel.targetEntity === targetType &&
    (inverseName ? rel.inverseName === inverseName : true)
  );
}

/**
 * Find a relationship by its inverse name
 */
export function findRelationshipByInverseName(
  entityType: EntityType,
  inverseName: string
): EntityRelationship | undefined {
  return ENTITY_RELATIONSHIPS.find(rel => 
    (rel.sourceEntity === entityType || rel.targetEntity === entityType) && 
    rel.inverseName === inverseName
  );
}

/**
 * Get foreign key field for a relationship
 */
export function getForeignKeyField(sourceType: EntityType, targetType: EntityType): string | undefined {
  const relationship = ENTITY_RELATIONSHIPS.find(rel => 
    rel.sourceEntity === sourceType && 
    rel.targetEntity === targetType && 
    rel.type === 'many-to-one'
  );
  return relationship?.sourceField;
}

/**
 * Check if an entity has a specific relationship
 */
export function hasRelationship(
  entityType: EntityType,
  relationshipName: string
): boolean {
  return ENTITY_RELATIONSHIPS.some(rel => 
    (rel.sourceEntity === entityType || rel.targetEntity === entityType) && 
    rel.inverseName === relationshipName
  );
}

/**
 * Get all cascade relationships for an entity type
 */
export function getCascadeRelationships(entityType: EntityType): EntityRelationship[] {
  return ENTITY_RELATIONSHIPS.filter(rel => 
    rel.sourceEntity === entityType && 
    rel.cascade === true
  );
}

// ------ Database Query Methods for Related Entities ------

/**
 * Get tasks for a project
 */
export async function getTasksForProject(projectId: string): Promise<Task[]> {
  try {
    const dataSource = await getDataSource();
    const taskRepo = dataSource.getRepository(Task);
    
    return taskRepo.find({
      where: { projectId }
    });
  } catch (error) {
    logger.error(`Error getting tasks for project ${projectId}: ${error}`);
    return [];
  }
}

/**
 * Get projects for a user (as owner)
 */
export async function getProjectsForUser(userId: string): Promise<Project[]> {
  try {
    const dataSource = await getDataSource();
    const projectRepo = dataSource.getRepository(Project);
    
    return projectRepo.find({
      where: { ownerId: userId }
    });
  } catch (error) {
    logger.error(`Error getting projects for user ${userId}: ${error}`);
    return [];
  }
}

/**
 * Get tasks assigned to a user
 */
export async function getTasksForUser(userId: string): Promise<Task[]> {
  try {
    const dataSource = await getDataSource();
    const taskRepo = dataSource.getRepository(Task);
    
    return taskRepo.find({
      where: { assigneeId: userId }
    });
  } catch (error) {
    logger.error(`Error getting tasks for user ${userId}: ${error}`);
    return [];
  }
}

/**
 * Get comments for a task
 */
export async function getCommentsForTask(taskId: string): Promise<Comment[]> {
  try {
    const dataSource = await getDataSource();
    const commentRepo = dataSource.getRepository(Comment);
    
    return commentRepo.find({
      where: { entityId: taskId }
    });
  } catch (error) {
    logger.error(`Error getting comments for task ${taskId}: ${error}`);
    return [];
  }
}

/**
 * Get comments by a user
 */
export async function getCommentsForUser(userId: string): Promise<Comment[]> {
  try {
    const dataSource = await getDataSource();
    const commentRepo = dataSource.getRepository(Comment);
    
    return commentRepo.find({
      where: { authorId: userId }
    });
  } catch (error) {
    logger.error(`Error getting comments for user ${userId}: ${error}`);
    return [];
  }
}

/**
 * Get related entities for a given entity and relationship name
 */
export async function getRelatedEntities(
  entity: any,
  relationshipName: string
): Promise<any[]> {
  try {
    if (!entity || !entity.id) {
      throw new Error('Invalid entity provided');
    }
    
    const entityType = getEntityType(entity);
    const dataSource = await getDataSource();
    
    // Find the relationship by its inverse name
    const relationship = findRelationshipByInverseName(entityType, relationshipName);
    
    if (!relationship) {
      throw new Error(`Relationship '${relationshipName}' not found for entity type '${entityType}'`);
    }
    
    // Determine if we're looking at the source or target side of the relationship
    const isSource = relationship.sourceEntity === entityType;
    const relatedEntityType = isSource ? relationship.targetEntity : relationship.sourceEntity;
    
    // Get the related entity repository
    const relatedEntityClass = getEntityClass(relatedEntityType);
    const repository = dataSource.getRepository(relatedEntityClass);
    
    // Create query conditions based on relationship type and direction
    let whereConditions: any = {};
    
    if (isSource && relationship.type === 'one-to-many') {
      // For one-to-many where we are the source, query by target's foreign key
      whereConditions[relationship.targetField] = entity.id;
    } else if (!isSource && relationship.type === 'one-to-many') {
      // For one-to-many where we are the target, query by source's ID
      whereConditions.id = entity[relationship.sourceField];
    } else if (isSource && relationship.type === 'many-to-one') {
      // For many-to-one where we are the source, query by target's ID
      whereConditions.id = entity[relationship.sourceField];
    } else if (!isSource && relationship.type === 'many-to-one') {
      // For many-to-one where we are the target, query by source's foreign key
      whereConditions[relationship.sourceField] = entity.id;
    } else if (relationship.type === 'many-to-many') {
      // Many-to-many would need a join table query (not implemented in this version)
      throw new Error('Many-to-many relationships not yet implemented');
    }
    
    return repository.find({ where: whereConditions });
  } catch (error) {
    logger.error(`Error getting related entities: ${error}`);
    return [];
  }
}

/**
 * Set relationship between two entities
 * @param sourceEntity The source entity
 * @param targetEntity The target entity
 * @param relationshipName The name of the relationship to set
 */
export function setRelationship(
  sourceEntity: any,
  targetEntity: any,
  relationshipName: string
): boolean {
  try {
    if (!sourceEntity || !targetEntity) {
      return false;
    }
    
    const sourceType = getEntityType(sourceEntity);
    const targetType = getEntityType(targetEntity);
    
    // Find the relationship
    const relationship = findRelationshipByInverseName(sourceType, relationshipName);
    
    if (!relationship) {
      logger.error(`Relationship '${relationshipName}' not found for entity types '${sourceType}' and '${targetType}'`);
      return false;
    }
    
    // Check if the relationship directions match
    const isCorrectDirection = relationship.sourceEntity === sourceType && relationship.targetEntity === targetType;
    
    if (!isCorrectDirection) {
      logger.error(`Invalid relationship direction: '${relationshipName}' cannot connect ${sourceType} to ${targetType}`);
      return false;
    }
    
    // Set the appropriate foreign key based on relationship type
    if (relationship.type === 'many-to-one') {
      sourceEntity[relationship.sourceField] = targetEntity.id;
      return true;
    } else if (relationship.type === 'one-to-many') {
      // This would normally be handled by setting the foreign key on the target entity
      // But we also provide a helper for convenience
      targetEntity[relationship.targetField] = sourceEntity.id;
      return true;
    } else {
      logger.error(`Relationship type '${relationship.type}' not supported for setRelationship`);
      return false;
    }
  } catch (error) {
    logger.error(`Error setting relationship: ${error}`);
    return false;
  }
}

/**
 * Verify that an entity has all required relationships set
 */
export function verifyRequiredRelationships(entity: any): { valid: boolean, missing: string[] } {
  try {
    const entityType = getEntityType(entity);
    const requiredRelations = REQUIRED_RELATIONS[entityType] || [];
    const missing: string[] = [];
    
    for (const relation of requiredRelations) {
      if (!entity[relation]) {
        missing.push(relation);
      }
    }
    
    return {
      valid: missing.length === 0,
      missing
    };
  } catch (error) {
    logger.error(`Error verifying required relationships: ${error}`);
    return { valid: false, missing: ['Error verifying relationships'] };
  }
}

/**
 * Get all entities that would be affected by a cascade delete
 */
export async function getEntityCascadeGraph(
  entityType: EntityType,
  entityId: string
): Promise<Record<EntityType, string[]>> {
  const affectedEntities: Record<EntityType, string[]> = {
    user: [],
    project: [],
    task: [],
    comment: []
  };
  
  try {
    // Don't proceed if the entity type doesn't have cascade relationships
    const cascadeRelationships = getCascadeRelationships(entityType);
    if (cascadeRelationships.length === 0) {
      return affectedEntities;
    }
    
    // Add the initial entity
    affectedEntities[entityType].push(entityId);
    
    // Get the data source
    const dataSource = await getDataSource();
    
    // Process each cascade relationship
    for (const relationship of cascadeRelationships) {
      const targetEntityType = relationship.targetEntity;
      const targetEntityClass = getEntityClass(targetEntityType);
      const repository = dataSource.getRepository(targetEntityClass);
      
      // Query for related entities
      const relatedEntities = await repository.find({
        where: { [relationship.targetField]: entityId }
      });
      
      // Add the related entity IDs to the affected entities list
      for (const entity of relatedEntities) {
        if (!affectedEntities[targetEntityType].includes(entity.id)) {
          affectedEntities[targetEntityType].push(entity.id);
          
          // Recursively process child cascades
          const childCascades = await getEntityCascadeGraph(targetEntityType, entity.id);
          
          // Merge the child cascades with the current results
          for (const [childType, childIds] of Object.entries(childCascades)) {
            for (const childId of childIds) {
              if (!affectedEntities[childType as EntityType].includes(childId)) {
                affectedEntities[childType as EntityType].push(childId);
              }
            }
          }
        }
      }
    }
    
    return affectedEntities;
  } catch (error) {
    logger.error(`Error building entity cascade graph: ${error}`);
    return affectedEntities;
  }
} 