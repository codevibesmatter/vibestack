/**
 * Entity Adapter
 * 
 * A lightweight adapter between dataforge entities and the entity-changes system.
 * Provides direct access to dataforge entities without complex abstractions.
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

// Simple entity type definition
export type EntityType = 'user' | 'project' | 'task' | 'comment';

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

// Cascade dependencies - identifies which deletions should cascade
export const CASCADE_RELATIONS = {
  user: [],
  project: ['tasks'],
  task: ['comments'],
  comment: ['childComments']
};

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
  
  // Fallback for plain objects - check constructor name
  if (entity && typeof entity === 'object') {
    // Check for __entityType marker
    if (entity.__entityType && ['user', 'project', 'task', 'comment'].includes(entity.__entityType)) {
      return entity.__entityType as EntityType;
    }
    
    const constructorName = entity.constructor?.name?.toLowerCase();
    if (constructorName && ['user', 'project', 'task', 'comment'].includes(constructorName)) {
      return constructorName as EntityType;
    }
  }
  
  throw new Error(`Unknown entity type for entity: ${JSON.stringify(entity)}`);
} 