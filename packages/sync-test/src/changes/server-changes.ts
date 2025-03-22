import { DataSource, EntityTarget } from 'typeorm';
import { Client } from '@neondatabase/serverless';
import { 
  Task, TaskStatus, TaskPriority,
  Project, ProjectStatus,
  User,
  Comment
} from '@repo/dataforge/server-entities';
import { generateFakeData } from '../utils/fake-data.js';

type Entity = Task | Project | User | Comment;
type EntityClass = typeof Task | typeof Project | typeof User | typeof Comment;
type DbClient = DataSource | Client;

// Helper function to determine if the client is a Neon client
function isNeonClient(client: DbClient): client is Client {
  return !('getRepository' in client);
}

/**
 * Create a single change on the server
 */
export async function createServerChange(
  dbClient: DbClient,
  entityClass: EntityClass,
  operation: 'insert' | 'update' | 'delete'
): Promise<void> {
  const data = await generateFakeData(entityClass);
  
  if (isNeonClient(dbClient)) {
    // Using Neon client
    const tableName = entityClass.name.toLowerCase();
    
    switch (operation) {
      case 'insert':
        const columns = Object.keys(data).join(', ');
        const placeholders = Object.keys(data).map((_, i) => `$${i + 1}`).join(', ');
        const values = Object.values(data);
        
        await dbClient.query(
          `INSERT INTO "${tableName}" (${columns}) VALUES (${placeholders})`,
          values
        );
        break;
        
      case 'update':
        // First check if there are any records
        const countResult = await dbClient.query(`SELECT COUNT(*) FROM "${tableName}"`);
        const count = parseInt(countResult.rows[0].count);
        
        if (count === 0) {
          // Insert if no records exist
          const columns = Object.keys(data).join(', ');
          const placeholders = Object.keys(data).map((_, i) => `$${i + 1}`).join(', ');
          const values = Object.values(data);
          
          await dbClient.query(
            `INSERT INTO "${tableName}" (${columns}) VALUES (${placeholders})`,
            values
          );
        } else {
          // Update random existing record
          const records = await dbClient.query(`SELECT * FROM "${tableName}" LIMIT 1`);
          if (records.rows.length > 0) {
            const updateData = await generateFakeData(entityClass);
            const setClause = Object.keys(updateData)
              .map((key, i) => `"${key}" = $${i + 1}`)
              .join(', ');
            const values = [...Object.values(updateData), records.rows[0].id];
            
            await dbClient.query(
              `UPDATE "${tableName}" SET ${setClause} WHERE id = $${Object.keys(updateData).length + 1}`,
              values
            );
          }
        }
        break;
        
      case 'delete':
        // Check if there are any records
        const deleteCountResult = await dbClient.query(`SELECT COUNT(*) FROM "${tableName}"`);
        const deleteCount = parseInt(deleteCountResult.rows[0].count);
        
        if (deleteCount > 0) {
          // Delete random existing record
          const records = await dbClient.query(`SELECT * FROM "${tableName}" LIMIT 1`);
          if (records.rows.length > 0) {
            await dbClient.query(
              `DELETE FROM "${tableName}" WHERE id = $1`,
              [records.rows[0].id]
            );
          }
        }
        break;
    }
  } else {
    // Using TypeORM DataSource
    const repository = dbClient.getRepository(entityClass);

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
}

/**
 * Create multiple changes on the server
 */
export async function createServerBulkChanges(
  dbClient: DbClient,
  entityClass: EntityClass,
  count: number
): Promise<void> {
  const operations = ['insert', 'update', 'delete'] as const;

  for (let i = 0; i < count; i++) {
    const operation = operations[Math.floor(Math.random() * operations.length)];
    await createServerChange(dbClient, entityClass, operation);
  }
}