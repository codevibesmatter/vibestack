import 'reflect-metadata';

/**
 * Keys used for metadata storage
 */
export const METADATA_KEYS = {
  SERVER_ONLY: 'context:server-only',
  CLIENT_ONLY: 'context:client-only',
  SERVER_ENTITY: 'context:server-entity',
  CLIENT_ENTITY: 'context:client-entity',
  TABLE_CATEGORY: 'context:table-category',
};

/**
 * Table categories for classification
 */
export type TableCategory = 'domain' | 'system' | 'utility';

/**
 * Marks a property or entire entity as server-only.
 * Server-only properties/entities will only be included in server entity definitions.
 */
export function ServerOnly(): PropertyDecorator & ClassDecorator {
  return function(target: Object | Function, propertyKey?: string | symbol): void {
    if (propertyKey) {
      // Used as property decorator
      Reflect.defineMetadata(METADATA_KEYS.SERVER_ONLY, true, target, propertyKey);
    } else {
      // Used as class decorator
      Reflect.defineMetadata(METADATA_KEYS.SERVER_ENTITY, true, target);
    }
  };
}

/**
 * Marks a property or entire entity as client-only.
 * Client-only properties/entities will only be included in client entity definitions.
 */
export function ClientOnly(): PropertyDecorator & ClassDecorator {
  return function(target: Object | Function, propertyKey?: string | symbol): void {
    if (propertyKey) {
      // Used as property decorator
      Reflect.defineMetadata(METADATA_KEYS.CLIENT_ONLY, true, target, propertyKey);
    } else {
      // Used as class decorator
      Reflect.defineMetadata(METADATA_KEYS.CLIENT_ENTITY, true, target);
    }
  };
}

/**
 * Checks if a property is marked as server-only
 */
export function isServerOnly(target: Object, propertyKey: string | symbol): boolean {
  return Reflect.getMetadata(METADATA_KEYS.SERVER_ONLY, target, propertyKey) === true;
}

/**
 * Checks if a property is marked as client-only
 */
export function isClientOnly(target: Object, propertyKey: string | symbol): boolean {
  return Reflect.getMetadata(METADATA_KEYS.CLIENT_ONLY, target, propertyKey) === true;
}

/**
 * Checks if a class is marked as server-only entity
 */
export function isServerEntity(target: Function): boolean {
  try {
    return typeof target === 'function' && Reflect.getMetadata(METADATA_KEYS.SERVER_ENTITY, target) === true;
  } catch {
    return false;
  }
}

/**
 * Checks if a class is marked as client-only entity
 */
export function isClientEntity(target: Function): boolean {
  try {
    return typeof target === 'function' && Reflect.getMetadata(METADATA_KEYS.CLIENT_ENTITY, target) === true;
  } catch {
    return false;
  }
}

/**
 * Marks an entity with a specific table category for classification
 * Categories include:
 * - domain: Business data tables that should be replicated
 * - system: System tables for internal state management
 * - utility: Utility tables for logs, analytics, etc.
 */
export function TableCategory(category: TableCategory): ClassDecorator {
  return function(target: Function): void {
    Reflect.defineMetadata(METADATA_KEYS.TABLE_CATEGORY, category, target);
  };
}

/**
 * Gets the table category for an entity class
 * Returns undefined if no category is set
 */
export function getTableCategory(target: Function): TableCategory | undefined {
  return Reflect.getMetadata(METADATA_KEYS.TABLE_CATEGORY, target) as TableCategory | undefined;
}

/**
 * Checks if an entity belongs to a specific category
 */
export function isTableCategory(target: Function, category: TableCategory): boolean {
  return getTableCategory(target) === category;
}

/**
 * Helper function to get all property keys of a class (including inherited ones)
 */
export function getAllPropertyKeys(target: any): string[] {
  const props: string[] = [];
  
  // Get all properties, including inherited ones
  let currentTarget = target.prototype;
  
  while (currentTarget && currentTarget !== Object.prototype) {
    // Get own property names (enumerable and non-enumerable)
    const ownProps = Object.getOwnPropertyNames(currentTarget);
    
    // Filter out methods and special properties
    const propertyKeys = ownProps.filter(key => 
      key !== 'constructor' && 
      typeof currentTarget[key] !== 'function'
    );
    
    props.push(...propertyKeys);
    
    // Move up the prototype chain
    currentTarget = Object.getPrototypeOf(currentTarget);
  }
  
  return [...new Set(props)]; // Remove duplicates
}

/**
 * Helper function to determine if an entity should be included in the server context
 */
export function shouldIncludeInServer(entityClass: Function): boolean {
  // Include if not specifically marked as client-only entity
  return !isClientEntity(entityClass);
}

/**
 * Helper function to determine if an entity should be included in the client context
 */
export function shouldIncludeInClient(entityClass: Function): boolean {
  // Include if not specifically marked as server-only entity
  return !isServerEntity(entityClass);
} 