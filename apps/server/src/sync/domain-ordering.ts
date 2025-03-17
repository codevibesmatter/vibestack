import { getMetadataArgsStorage, EntitySchema } from 'typeorm';
import type { TableChange } from '@repo/sync-types';
import { syncLogger } from '../middleware/logger';

/**
 * Cache for table hierarchy to avoid recomputing
 */
let tableHierarchyCache: Map<string, number> | null = null;

/**
 * Extract table name from TypeORM metadata target
 */
function getTableName(target: Function | string | EntitySchema<any> | { type: any; name: string }): string | null {
  if (typeof target === 'function') {
    return target.name;
  }
  if (typeof target === 'string') {
    return target;
  }
  if (target instanceof EntitySchema) {
    return target.options.name;
  }
  if (typeof target === 'object' && 'name' in target) {
    return target.name;
  }
  return null;
}

/**
 * Get table hierarchy level from TypeORM metadata
 * Level 0 = root tables (no parents)
 * Level 1+ = tables with foreign key dependencies
 */
function getTableHierarchy(): Map<string, number> {
  if (tableHierarchyCache) {
    return tableHierarchyCache;
  }

  const metadata = getMetadataArgsStorage();
  const hierarchy = new Map<string, number>();
  
  // First pass: collect all tables and their direct parents
  const parentRelations = new Map<string, Set<string>>();
  
  for (const relation of metadata.relations) {
    const targetTable = getTableName(relation.target);
    const parentTable = getTableName(relation.type);
      
    if (!targetTable || !parentTable) {
      syncLogger.warn('Could not determine table name from relation', {
        target: String(relation.target),
        type: String(relation.type)
      });
      continue;
    }
    
    if (!parentRelations.has(targetTable)) {
      parentRelations.set(targetTable, new Set<string>());
    }
    parentRelations.get(targetTable)!.add(parentTable);
  }

  // Second pass: calculate levels
  function calculateLevel(table: string, visited = new Set<string>()): number {
    if (visited.has(table)) {
      syncLogger.warn('Circular dependency detected in table hierarchy', { table });
      return 0;
    }
    
    if (hierarchy.has(table)) {
      return hierarchy.get(table)!;
    }

    const parents = parentRelations.get(table) || new Set();
    if (parents.size === 0) {
      hierarchy.set(table, 0);
      return 0;
    }

    visited.add(table);
    const parentLevels = Array.from(parents).map(p => calculateLevel(p, visited));
    const level = Math.max(...parentLevels) + 1;
    hierarchy.set(table, level);
    return level;
  }

  // Calculate levels for all tables
  for (const table of parentRelations.keys()) {
    calculateLevel(table);
  }

  tableHierarchyCache = hierarchy;
  
  syncLogger.info('Built table hierarchy', {
    tables: Object.fromEntries(hierarchy.entries())
  });
  
  return hierarchy;
}

/**
 * Order changes based on table hierarchy and operation type
 * - Creates/Updates: Process parents before children
 * - Deletes: Process children before parents
 */
export function orderChangesByDomain(changes: TableChange[]): TableChange[] {
  const hierarchy = getTableHierarchy();

  return changes.sort((a, b) => {
    const aLevel = hierarchy.get(a.table) ?? 0;
    const bLevel = hierarchy.get(b.table) ?? 0;

    // For deletes, reverse the hierarchy
    if (a.operation === 'delete' && b.operation === 'delete') {
      return bLevel - aLevel;
    }

    // For mixed operations, deletes come last
    if (a.operation === 'delete') return 1;
    if (b.operation === 'delete') return -1;

    // For creates/updates, follow hierarchy
    return aLevel - bLevel;
  });
} 