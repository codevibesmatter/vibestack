import { validateEntityOrThrow } from '@repo/typeorm';
import { DataAccess, DataResult } from './DataAccess';

/**
 * ValidatingDataAccess extends DataAccess to add automatic validation
 * using class-validator decorators on entity classes.
 */
export class ValidatingDataAccess<T extends object> extends DataAccess<T> {
  private entityClass: new () => T;

  /**
   * Create a new ValidatingDataAccess instance
   * @param tableName The table name
   * @param entityClass The entity class constructor
   */
  constructor(tableName: string, entityClass: new () => T) {
    super(tableName);
    this.entityClass = entityClass;
  }

  /**
   * Create a new entity with validation
   * @param entity The entity to create
   * @returns A promise that resolves to a DataResult containing the created entity
   */
  async create(entity: T): Promise<DataResult<T>> {
    // Validate the entity before creating
    await validateEntityOrThrow(entity, this.entityClass);
    
    // Call the parent create method
    return super.create(entity);
  }

  /**
   * Update an entity with validation
   * @param id The entity ID
   * @param entity The entity data to update
   * @returns A promise that resolves to a DataResult containing the updated entity
   */
  async update(id: string, entity: Partial<T>): Promise<DataResult<T>> {
    // Validate the entity before updating
    await validateEntityOrThrow(entity, this.entityClass);
    
    // Call the parent update method
    return super.update(id, entity);
  }
} 