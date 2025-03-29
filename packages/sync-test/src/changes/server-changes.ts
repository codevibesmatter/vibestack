import { DataSource, EntityTarget } from 'typeorm';
import { Client } from '@neondatabase/serverless';
import { 
  Task, TaskStatus, TaskPriority,
  Project, ProjectStatus,
  User,
  Comment,
  SERVER_DOMAIN_TABLES
} from '@repo/dataforge/server-entities';
import { generateFakeData } from '../utils/fake-data.ts';
import crypto from 'crypto';

type Entity = Task | Project | User | Comment;
type EntityClass = typeof Task | typeof Project | typeof User | typeof Comment;
// Update DbClient to include SqlQueryFunction - the return type of neon()
type SqlQueryFunction = any;
type DbClient = DataSource | Client | SqlQueryFunction;

// Map entity classes to table names
const ENTITY_TABLE_MAP = {
  [Task.name]: 'tasks',
  [Project.name]: 'projects',
  [User.name]: 'users',
  [Comment.name]: 'comments'
};

// Helper function to determine if the client is a Neon client
function isNeonClient(client: DbClient): client is Client {
  return 'query' in client && typeof client.query === 'function';
}

// Helper function to determine if the client is a Neon SQL tagged template function
function isSqlFunction(client: DbClient): client is SqlQueryFunction {
  return typeof client === 'function';
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
    // Using Neon Client with query method
    const tableName = ENTITY_TABLE_MAP[entityClass.name];
    
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
  } else if (isSqlFunction(dbClient)) {
    // Using Neon SQL tagged template function
    const tableName = ENTITY_TABLE_MAP[entityClass.name];
    const sql = dbClient;
    
    switch (operation) {
      case 'insert': {
        // Insert operation - use a much simpler approach
        // Create a random UUID if id is missing
        if (!data.id) {
          data.id = crypto.randomUUID();
        }
        
        // Convert created_at/updated_at to the current timestamp if they don't exist
        if (!data.created_at) {
          data.created_at = new Date();
        }
        if (!data.updated_at) {
          data.updated_at = new Date();
        }
        
        // For tasks
        if (tableName === 'tasks') {
          await sql`INSERT INTO tasks (
            id, title, description, status, priority, project_id, tags, created_at, updated_at
          ) VALUES (
            ${data.id}, ${data.title}, ${data.description}, ${data.status}, 
            ${data.priority}, ${data.project_id}, ${data.tags}, ${data.created_at}, ${data.updated_at}
          )`;
        }
        // For projects
        else if (tableName === 'projects') {
          await sql`INSERT INTO projects (
            id, name, description, status, owner_id, created_at, updated_at
          ) VALUES (
            ${data.id}, ${data.name}, ${data.description}, ${data.status}, 
            ${data.owner_id}, ${data.created_at}, ${data.updated_at}
          )`;
        }
        // For users
        else if (tableName === 'users') {
          await sql`INSERT INTO users (
            id, name, email, role, created_at, updated_at
          ) VALUES (
            ${data.id}, ${data.name}, ${data.email}, ${data.role}, 
            ${data.created_at}, ${data.updated_at}
          )`;
        }
        // For comments
        else if (tableName === 'comments') {
          await sql`INSERT INTO comments (
            id, content, entityType, entityId, authorId, createdAt, updatedAt
          ) VALUES (
            ${data.id}, ${data.content}, ${data.entityType}, ${data.entityId}, 
            ${data.authorId}, ${data.createdAt}, ${data.updatedAt}
          )`;
        }
        break;
      }
      
      case 'update': {
        // First check if any records exist
        let count = 0;
        if (tableName === 'tasks') {
          const result = await sql`SELECT COUNT(*) FROM tasks`;
          count = parseInt(result[0].count);
        } else if (tableName === 'projects') {
          const result = await sql`SELECT COUNT(*) FROM projects`;
          count = parseInt(result[0].count);
        } else if (tableName === 'users') {
          const result = await sql`SELECT COUNT(*) FROM users`;
          count = parseInt(result[0].count);
        } else if (tableName === 'comments') {
          const result = await sql`SELECT COUNT(*) FROM comments`;
          count = parseInt(result[0].count);
        }
        
        if (count === 0) {
          // No records exist, so insert instead
          // Reuse the insert logic
          await createServerChange(dbClient, entityClass, 'insert');
        } else {
          // Records exist, so update a random one
          // We need to fetch a record first to get its ID
          let recordId = '';
          if (tableName === 'tasks') {
            const records = await sql`SELECT id FROM tasks LIMIT 1`;
            if (records.length > 0) recordId = records[0].id;
          } else if (tableName === 'projects') {
            const records = await sql`SELECT id FROM projects LIMIT 1`;
            if (records.length > 0) recordId = records[0].id;
          } else if (tableName === 'users') {
            const records = await sql`SELECT id FROM users LIMIT 1`;
            if (records.length > 0) recordId = records[0].id;
          } else if (tableName === 'comments') {
            const records = await sql`SELECT id FROM comments LIMIT 1`;
            if (records.length > 0) recordId = records[0].id;
          }
          
          if (recordId) {
            // Create update data
            const updateData = await generateFakeData(entityClass);
            
            // For tasks
            if (tableName === 'tasks') {
              await sql`UPDATE tasks SET 
                title = ${updateData.title},
                description = ${updateData.description},
                status = ${updateData.status},
                priority = ${updateData.priority},
                updated_at = ${new Date()}
                WHERE id = ${recordId}`;
            }
            // For projects
            else if (tableName === 'projects') {
              await sql`UPDATE projects SET 
                name = ${updateData.name},
                description = ${updateData.description},
                status = ${updateData.status},
                updated_at = ${new Date()}
                WHERE id = ${recordId}`;
            }
            // For users
            else if (tableName === 'users') {
              await sql`UPDATE users SET 
                name = ${updateData.name},
                email = ${updateData.email},
                updated_at = ${new Date()}
                WHERE id = ${recordId}`;
            }
            // For comments
            else if (tableName === 'comments') {
              await sql`UPDATE comments SET 
                content = ${updateData.content},
                updatedAt = ${new Date()}
                WHERE id = ${recordId}`;
            }
          }
        }
        break;
      }
      
      case 'delete': {
        // To delete we need to check if any records exist first
        let recordId = '';
        
        // For tasks
        if (tableName === 'tasks') {
          const records = await sql`SELECT id FROM tasks LIMIT 1`;
          if (records.length > 0) {
            recordId = records[0].id;
            await sql`DELETE FROM tasks WHERE id = ${recordId}`;
          }
        }
        // For projects
        else if (tableName === 'projects') {
          const records = await sql`SELECT id FROM projects LIMIT 1`;
          if (records.length > 0) {
            recordId = records[0].id;
            await sql`DELETE FROM projects WHERE id = ${recordId}`;
          }
        }
        // For users
        else if (tableName === 'users') {
          const records = await sql`SELECT id FROM users LIMIT 1`;
          if (records.length > 0) {
            recordId = records[0].id;
            await sql`DELETE FROM users WHERE id = ${recordId}`;
          }
        }
        // For comments
        else if (tableName === 'comments') {
          const records = await sql`SELECT id FROM comments LIMIT 1`;
          if (records.length > 0) {
            recordId = records[0].id;
            await sql`DELETE FROM comments WHERE id = ${recordId}`;
          }
        }
        break;
      }
    }
  } else {
    // Using TypeORM DataSource
    const repository = (dbClient as DataSource).getRepository(entityClass);

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