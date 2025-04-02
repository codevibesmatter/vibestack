/**
 * Entity generators for entity changes
 * Functions to generate entities for testing
 */

import { v4 as uuidv4 } from 'uuid';
import { faker } from '@faker-js/faker';
import { TaskStatus, TaskPriority } from '@repo/dataforge/server-entities';

import { 
  EntityType, 
  EntityTypeMapping,
  getEntityClassForType 
} from './entity-definitions.ts';

/**
 * Generate an entity instance with data from the template
 */
export function generateEntity<T extends EntityType>(
  entityType: T,
  existingIds?: Record<EntityType, string[]>,
  overrides: Partial<EntityTypeMapping[T]> = {}
): EntityTypeMapping[T] {
  // Get the entity class for this type
  const EntityClass = getEntityClassForType(entityType);
  
  // Create entity instance
  const entity = new EntityClass();
  
  // Set ID if not provided
  if (!entity.id) {
    entity.id = uuidv4();
  }
  
  // Set common properties
  entity.createdAt = new Date();
  entity.updatedAt = new Date();
  
  // Apply type-specific properties
  switch (entityType) {
    case 'user':
      entity.name = faker.person.fullName();
      entity.email = faker.internet.email();
      break;
      
    case 'project':
      entity.name = faker.company.name();
      entity.description = faker.company.catchPhrase();
      entity.ownerId = existingIds?.user?.length 
        ? faker.helpers.arrayElement(existingIds.user) 
        : uuidv4();
      break;
      
    case 'task':
      entity.title = faker.company.catchPhrase();
      entity.description = faker.lorem.paragraph();
      entity.status = faker.helpers.arrayElement(Object.values(TaskStatus));
      entity.priority = faker.helpers.arrayElement(Object.values(TaskPriority));
      entity.projectId = existingIds?.project?.length 
        ? faker.helpers.arrayElement(existingIds.project) 
        : uuidv4();
      entity.assigneeId = existingIds?.user?.length 
        ? faker.helpers.arrayElement(existingIds.user) 
        : uuidv4();
      break;
      
    case 'comment':
      entity.content = faker.lorem.paragraph();
      
      // Choose between task and project for entity type
      const commentEntityType = faker.helpers.arrayElement(['task', 'project']);
      entity.entityType = commentEntityType;
      
      const entityIdArray = existingIds?.[commentEntityType as EntityType] || [];
      entity.entityId = entityIdArray.length 
        ? faker.helpers.arrayElement(entityIdArray) 
        : uuidv4();
      
      entity.authorId = existingIds?.user?.length 
        ? faker.helpers.arrayElement(existingIds.user) 
        : uuidv4();
      
      // Add optional parent reference
      if (Math.random() > 0.7 && existingIds?.comment?.length) {
        entity.parentId = faker.helpers.arrayElement(existingIds.comment);
      }
      
      // Add optional client ID
      if (Math.random() > 0.8) {
        entity.clientId = uuidv4();
      }
      break;
  }
  
  // Apply any overrides
  Object.assign(entity, overrides);
  
  return entity as EntityTypeMapping[T];
}

/**
 * Generate multiple entities of the same type
 */
export function generateEntities<T extends EntityType>(
  entityType: T,
  count: number,
  existingIds?: Record<EntityType, string[]>,
  customData: Partial<EntityTypeMapping[T]> = {}
): EntityTypeMapping[T][] {
  const entities: EntityTypeMapping[T][] = [];
  
  for (let i = 0; i < count; i++) {
    entities.push(generateEntity(entityType, existingIds, customData));
  }
  
  return entities;
} 