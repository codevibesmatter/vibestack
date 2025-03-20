import { v4 as uuidv4 } from 'uuid';
import type { TableChange } from '@repo/sync-types';
import { 
  Task, TaskStatus, TaskPriority,
  Project, ProjectStatus,
  User,
  Comment
} from '@repo/dataforge/server-entities';
import { generateFakeData } from '../utils/fake-data.js';

type Entity = Task | Project | User | Comment;
type EntityClass = typeof Task | typeof Project | typeof User | typeof Comment;

/**
 * Generate a single change for testing
 */
export async function generateSingleChange(entityClass: EntityClass): Promise<TableChange> {
  const tableName = entityClass.name.toLowerCase() + 's';
  const data = await generateFakeData(entityClass);

  return {
    table: tableName,
    operation: 'insert',
    data,
    updated_at: new Date().toISOString()
  };
}

/**
 * Generate multiple changes for testing
 */
export async function generateBulkChanges(entityClass: EntityClass, count: number): Promise<TableChange[]> {
  const changes: TableChange[] = [];
  const tableName = entityClass.name.toLowerCase() + 's';

  for (let i = 0; i < count; i++) {
    const data = await generateFakeData(entityClass);
    changes.push({
      table: tableName,
      operation: 'insert',
      data,
      updated_at: new Date().toISOString()
    });
  }

  return changes;
} 