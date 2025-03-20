/**
 * Table category decorator and utilities
 * 
 * This module provides decorators and utilities for categorizing database tables
 * to help with replication, migrations, and other database operations.
 */

/**
 * Table categories
 * - domain: Business data tables that should be replicated
 * - system: System tables for internal state management
 * - utility: Utility tables for logs, analytics, etc.
 */
export type TableCategory = 'domain' | 'system' | 'utility';

/**
 * Metadata key for storing table category
 */
export const TABLE_CATEGORY_KEY = 'typeorm:table:category';

/**
 * Decorator to mark an entity with a specific table category
 * 
 * @example
 * ```
 * @Entity('users')
 * @TableCategory('domain')
 * export class User { ... }
 * ```
 */
export function TableCategory(category: TableCategory) {
  return function (target: Function) {
    Reflect.defineMetadata(TABLE_CATEGORY_KEY, category, target);
  };
}

/**
 * Get the table category for an entity class
 * Returns undefined if no category is set
 */
export function getTableCategory(entityClass: Function): TableCategory | undefined {
  return Reflect.getMetadata(TABLE_CATEGORY_KEY, entityClass);
}

/**
 * Check if an entity belongs to a specific category
 */
export function isTableCategory(entityClass: Function, category: TableCategory): boolean {
  return getTableCategory(entityClass) === category;
}
