import { DataSource, EntityTarget } from 'typeorm';
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
 * Create a single change on the server
 */
export async function createServerChange(
  dataSource: DataSource,
  entityClass: EntityClass,
  operation: 'insert' | 'update' | 'delete'
): Promise<void> {
  const data = await generateFakeData(entityClass);
  const repository = dataSource.getRepository(entityClass);

  switch (operation) {
    case 'insert':
      await repository.save(data);
      break;

    case 'update':
      if (await repository.count() === 0) {
        // Insert if no records exist
        await repository.save(data);
      } else {
        // Update random existing record
        const records = await repository.find({ take: 1 });
        if (records.length > 0) {
          const updateData = await generateFakeData(entityClass);
          await repository.update(records[0].id, updateData);
        }
      }
      break;

    case 'delete':
      if (await repository.count() > 0) {
        const records = await repository.find({ take: 1 });
        if (records.length > 0) {
          await repository.delete(records[0].id);
        }
      }
      break;
  }
}

/**
 * Create multiple changes on the server
 */
export async function createServerBulkChanges(
  dataSource: DataSource,
  entityClass: EntityClass,
  count: number
): Promise<void> {
  const repository = dataSource.getRepository(entityClass);
  const operations = ['insert', 'update', 'delete'] as const;

  for (let i = 0; i < count; i++) {
    const operation = operations[Math.floor(Math.random() * operations.length)];
    await createServerChange(dataSource, entityClass, operation);
  }
} 