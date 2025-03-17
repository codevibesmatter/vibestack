/**
 * Table Registry
 * 
 * This module provides utilities for working with database tables
 * based on their categories and metadata.
 */

import { getMetadataArgsStorage } from 'typeorm';
import { TableCategory, TABLE_CATEGORY_KEY } from './table-category.js';
import 'reflect-metadata';

/**
 * Get all entity classes with their table names and categories
 */
export function getAllEntityMetadata() {
  const entities = getMetadataArgsStorage().tables.map(table => ({
    entityClass: table.target as Function,
    tableName: table.name,
    category: Reflect.getMetadata(TABLE_CATEGORY_KEY, table.target) as TableCategory | undefined
  }));
  
  return entities;
}

/**
 * Get all table names for a specific category
 * 
 * @param category The table category to filter by
 * @returns Array of table names
 */
export function getTableNamesByCategory(category: TableCategory): string[] {
  return getAllEntityMetadata()
    .filter(entity => entity.category === category)
    .map(entity => entity.tableName)
    .filter((tableName): tableName is string => tableName !== undefined);
}

/**
 * Get all domain tables (formatted for SQL with quotes)
 * These are tables that should be included in replication
 */
export function getDomainTables(): string[] {
  return getTableNamesByCategory('domain')
    .map(tableName => `"${tableName}"`);
}

/**
 * Get all system tables (formatted for SQL with quotes)
 * These are tables used for internal state management
 */
export function getSystemTables(): string[] {
  return getTableNamesByCategory('system')
    .map(tableName => `"${tableName}"`);
}

/**
 * Get all utility tables (formatted for SQL with quotes)
 */
export function getUtilityTables(): string[] {
  return getTableNamesByCategory('utility')
    .map(tableName => `"${tableName}"`);
}
