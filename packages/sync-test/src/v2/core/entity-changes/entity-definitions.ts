/**
 * Entity definitions for the entity changes system
 * Contains type definitions, entity templates, and relationship models
 */

// External dependencies
import { faker } from '@faker-js/faker';
import { v4 as uuidv4 } from 'uuid';

// DataForge entities and types
import { 
  TaskStatus, 
  TaskPriority,
  ProjectStatus,
  UserRole,
  User, 
  Project, 
  Task, 
  Comment
} from '@repo/dataforge/server-entities';

// ----- TYPE DEFINITIONS -----
// Define entity types for better type safety
export type EntityType = 'task' | 'project' | 'user' | 'comment';

// Strongly typed mapping between EntityType and actual entity classes
export type EntityTypeMapping = {
  'task': Task;
  'project': Project;
  'user': User;
  'comment': Comment;
};

// Entity relationship model for tracking dependencies between entities
export interface EntityRelationship {
  type: EntityType;
  field: string;
  required: boolean;
  cascade: boolean;
}

// Entity template for generating test data
export interface EntityTemplate<T extends EntityType> {
  type: T;
  tableName: string;
  generator: (existingIds?: Record<EntityType, string[]>) => Partial<EntityTypeMapping[T]>;
  dependencies: EntityRelationship[];
}

// Map from entity types to table names
export const ENTITY_TO_TABLE_MAP: Record<EntityType, string> = {
  'task': 'tasks',
  'project': 'projects',
  'user': 'users',
  'comment': 'comments'
};

// Create a mapping from table names to entity types
export const TABLE_TO_ENTITY_MAP: Record<string, EntityType> = {};

// Build the table to entity map from the entity to table map
Object.entries(ENTITY_TO_TABLE_MAP).forEach(([entityType, tableName]) => {
  TABLE_TO_ENTITY_MAP[tableName] = entityType as EntityType;
  // Also add quoted version
  TABLE_TO_ENTITY_MAP[`"${tableName}"`] = entityType as EntityType;
});

// Define entity relationships for cascade operations
export const ENTITY_TEMPLATES: Record<EntityType, EntityTemplate<any>> = {
  'user': {
    type: 'user',
    tableName: ENTITY_TO_TABLE_MAP['user'],
    generator: () => ({
      name: faker.person.fullName(),
      email: faker.internet.email(),
      role: faker.helpers.arrayElement(Object.values(UserRole)),
      createdAt: new Date(),
      updatedAt: new Date()
    }),
    dependencies: []
  },
  'project': {
    type: 'project',
    tableName: ENTITY_TO_TABLE_MAP['project'],
    generator: (existingIds) => ({
      name: faker.company.name(),
      description: faker.company.catchPhrase(),
      status: faker.helpers.arrayElement(Object.values(ProjectStatus)),
      ownerId: existingIds?.user?.length ? 
        faker.helpers.arrayElement(existingIds.user) : 
        uuidv4(),
      createdAt: new Date(),
      updatedAt: new Date()
    }),
    dependencies: [
      { type: 'user', field: 'ownerId', required: true, cascade: false }
    ]
  },
  'task': {
    type: 'task',
    tableName: ENTITY_TO_TABLE_MAP['task'],
    generator: (existingIds) => ({
      title: faker.company.catchPhrase(),
      description: faker.lorem.paragraph(),
      status: faker.helpers.arrayElement(Object.values(TaskStatus)),
      priority: faker.helpers.arrayElement(Object.values(TaskPriority)),
      dueDate: faker.date.future(),
      projectId: existingIds?.project?.length ? 
        faker.helpers.arrayElement(existingIds.project) : 
        uuidv4(),
      assigneeId: existingIds?.user?.length ? 
        faker.helpers.arrayElement(existingIds.user) : 
        uuidv4(),
      createdAt: new Date(),
      updatedAt: new Date(),
      tags: [faker.word.sample(), faker.word.sample()]
    }),
    dependencies: [
      { type: 'project', field: 'projectId', required: true, cascade: true },
      { type: 'user', field: 'assigneeId', required: false, cascade: false }
    ]
  },
  'comment': {
    type: 'comment',
    tableName: ENTITY_TO_TABLE_MAP['comment'],
    generator: (existingIds) => {
      // Choose between task and project for entity type
      const entityType = faker.helpers.arrayElement(['task', 'project']);
      const entityIdArray = existingIds?.[entityType as EntityType] || [];
      
      return {
        content: faker.lorem.paragraph(),
        entityType,
        entityId: entityIdArray.length ? 
          faker.helpers.arrayElement(entityIdArray) : 
          uuidv4(),
        authorId: existingIds?.user?.length ? 
          faker.helpers.arrayElement(existingIds.user) : 
          uuidv4(),
        parentId: Math.random() > 0.7 && existingIds?.comment?.length ? 
          faker.helpers.arrayElement(existingIds.comment) : 
          undefined,
        clientId: Math.random() > 0.8 ? uuidv4() : undefined,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    },
    dependencies: [
      { type: 'user', field: 'authorId', required: true, cascade: false },
      // Dynamic dependency based on entityType, handled specially
      { type: 'comment', field: 'parentId', required: false, cascade: true }
    ]
  }
};

// A list of entity types in dependency order
export const ORDERED_ENTITY_TYPES: EntityType[] = ['user', 'project', 'task', 'comment'];

/**
 * Get entity class from entity type
 */
export function getEntityClassForType(entityType: EntityType): any {
  switch (entityType) {
    case 'task': return Task;
    case 'project': return Project;
    case 'user': return User;
    case 'comment': return Comment;
    default: throw new Error(`Unknown entity type: ${entityType}`);
  }
}

/**
 * Get a random enum value
 */
export function getRandomEnum<T extends Record<string, any>>(enumObj: T): any {
  const values = Object.values(enumObj);
  const randomIndex = Math.floor(Math.random() * values.length);
  return values[randomIndex];
} 