import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ApiEnv } from '../types/api';
import { fetchDomainTableData, checkDatabaseHealth } from '../lib/db';
import { NeonService } from '../lib/neon-orm/neon-service';
import * as Entities from '@repo/dataforge/server-entities'; // Import entities
import { EntityTarget } from 'typeorm'; // Import EntityTarget type
import { Client } from 'pg';
import { addConnectTimeout } from '../lib/db';

// --- Entity Mapping ---
// Map request table names (lowercase) to actual Entity classes
// Adjust keys (lowercase table names) as needed to match your API routes
const entityMap: { [key: string]: EntityTarget<any> } = {
    user: Entities.User,
    project: Entities.Project,
    task: Entities.Task,
    comment: Entities.Comment,
    // Add mappings for other entities your API might interact with
    // e.g., changehistory: Entities.ChangeHistory, 
    //       useridentity: Entities.UserIdentity, 
    //       clientmigration: Entities.ClientMigration
};

// Helper function to get entity target from request param
function getEntityTarget(tableNameParam: string): EntityTarget<any> | null {
    const lowerCaseTableName = tableNameParam.toLowerCase();
    return entityMap[lowerCaseTableName] || null;
}

// --- Hono App ---
export const db = new Hono<ApiEnv>();

// Health check endpoint
db.get('/health', async (c) => {
  const health = await checkDatabaseHealth(c);
  return c.json({
    success: health.healthy,
    data: health
  }, health.healthy ? 200 : 503);
});

// Fetch domain table data
db.get('/data', async (c) => {
  try {
    const tableData = await fetchDomainTableData(c);
    return c.json({
      success: true,
      data: tableData
    });
  } catch (error) {
    console.error('Error fetching table data:', error);
    return c.json({
      success: false,
      error: {
        message: error instanceof Error ? error.message : 'Failed to fetch table data'
      }
    }, 500);
  }
});

// Test endpoints for neon-orm
// Query builder operations
db.post('/query-builder', async (c) => {
  // TODO: Refactor this endpoint if necessary.
  // It currently assumes a very generic query structure that doesn't map well
  // to TypeORM's entity-focused QueryBuilder.
  // Consider using specific endpoints for common queries or a more structured query API.
  return c.json({ 
      success: false, 
      error: { message: "Generic query-builder endpoint needs refactoring for TypeORM." } 
  }, 400);
  /* // Old implementation for reference:
  try {
    const { tableName, where, select, orderBy, limit, offset } = await c.req.json();
    const entityTarget = getEntityTarget(tableName);
    if (!entityTarget) return c.json({ success: false, error: { message: `Invalid table name: ${tableName}` }}, 400);
    
    const neonService = new NeonService(); // Instantiate directly
    const alias = tableName.toLowerCase(); // Use table name as alias

    // CreateQueryBuilder now returns a promise
    const queryBuilder = await neonService.createQueryBuilder(entityTarget, alias);

    // Select needs careful handling - TypeORM selects columns relative to the alias
    if (select && Array.isArray(select)) {
      queryBuilder.select(select.map(col => `${alias}.${col}`)); 
    } else if (select) {
      // Handle non-array select if applicable
      queryBuilder.select(`${alias}.${select}`);
    }
    // Where needs mapping from generic object to TypeORM WhereExpression
    if (where) {
       // Simple key-value where:
       queryBuilder.where(where);
       // More complex where clauses need specific TypeORM methods (.andWhere, .orWhere, etc.)
    }
    // OrderBy needs mapping
    if (orderBy && orderBy.column) {
      queryBuilder.orderBy(`${alias}.${orderBy.column}`, orderBy.direction || 'ASC');
    }
    if (limit) {
      queryBuilder.limit(limit);
    }
    if (offset) {
      queryBuilder.offset(offset);
    }
    
    const result = await queryBuilder.getMany(); // Use .getMany(), .getOne(), .getRawMany(), etc.
    
    return c.json({ success: true, data: result });
  } catch (err) { // ... error handling ... }
  */
});

// Find one record
db.get('/:tableName/find-one', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  const requestId = c.req.header('cf-request-id') || `local-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const tableName = c.req.param('tableName');
  console.log(`[${requestId}] Route /${tableName}/find-one: START`);
  try {
    const entityTarget = getEntityTarget(tableName);
    if (!entityTarget) {
        console.error(`[${requestId}] Route /${tableName}/find-one: Invalid table name.`);
        return c.json({ success: false, error: { message: `Invalid table name: ${tableName}` }}, 400);
    }

    const where = await c.req.json();
    console.log(`[${requestId}] Route /${tableName}/find-one: Parsed WHERE criteria:`, where);
    const neonService = new NeonService(c);
    
    console.log(`[${requestId}] Route /${tableName}/find-one: Calling neonService.findOne...`);
    const result = await neonService.findOne(entityTarget, where);
    console.log(`[${requestId}] Route /${tableName}/find-one: neonService.findOne returned.`);
    
    console.log(`[${requestId}] Route /${tableName}/find-one: END (Success)`);
    return c.json({ success: true, data: result });

  } catch (error) {
    console.error(`[${requestId}] Route /${tableName}/find-one: CATCH block. Error finding record:`, error);
    return c.json({
      success: false,
      error: { message: error instanceof Error ? error.message : 'Failed to find record' }
    }, 500);
  }
});

// Find many records
db.get('/:tableName/find', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  const requestId = c.req.header('cf-request-id') || `local-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const tableName = c.req.param('tableName');
  console.log(`[${requestId}] Route /${tableName}/find: START`);
  try {
    const entityTarget = getEntityTarget(tableName);
    if (!entityTarget) {
        console.error(`[${requestId}] Route /${tableName}/find: Invalid table name.`);
        return c.json({ success: false, error: { message: `Invalid table name: ${tableName}` }}, 400);
    }
    
    // Try getting where clause from body, default to undefined if no body
    let where: any;
    try {
      where = await c.req.json(); 
      console.log(`[${requestId}] Route /${tableName}/find: Parsed WHERE criteria from body:`, where);
    } catch (e) {
      where = undefined; // No body or invalid JSON, find all
      console.log(`[${requestId}] Route /${tableName}/find: No WHERE criteria in body, finding all.`);
    }
    
    const neonService = new NeonService(c);
    let result;
    console.log(`[${requestId}] Route /${tableName}/find: Preparing service call...`);
    if (tableName === 'user') {
        console.log(`[${requestId}] Route /${tableName}/find: Using QueryBuilder for user table.`);
        const queryBuilder = await neonService.createQueryBuilder(entityTarget, 'user');
        queryBuilder.select(['user.id', 'user.email', 'user.name']); // Select specific columns
        queryBuilder.limit(5); // <--- ADD LIMIT
        console.log(`[${requestId}] Route /${tableName}/find: Calling queryBuilder.getMany()...`);
        result = await queryBuilder.getMany();
        console.log(`[${requestId}] Route /${tableName}/find: queryBuilder.getMany() returned.`);
    } else {
        console.log(`[${requestId}] Route /${tableName}/find: Using neonService.find for table: ${tableName}`);
        result = await neonService.find(entityTarget, where);
        console.log(`[${requestId}] Route /${tableName}/find: neonService.find returned.`);
    }
    
    console.log(`[${requestId}] Route /${tableName}/find: END (Success)`);
    return c.json({ success: true, data: result });

  } catch (error) {
    console.error(`[${requestId}] Route /${tableName}/find: CATCH block. Error finding records:`, error);
    return c.json({
      success: false,
      error: { message: error instanceof Error ? error.message : 'Failed to find records' }
    }, 500);
  }
});

// Insert record
db.post('/:tableName/insert', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const tableName = c.req.param('tableName');
    const entityTarget = getEntityTarget(tableName);
    if (!entityTarget) return c.json({ success: false, error: { message: `Invalid table name: ${tableName}` }}, 400);

    const data = await c.req.json();
    const neonService = new NeonService(c);
    
    const result = await neonService.insert(entityTarget, data);
    // Return the inserted entity (which might include generated IDs)
    return c.json({ success: true, data: result }, 201); // Use 201 Created status

  } catch (error) {
    console.error('Error inserting record:', error);
    return c.json({
      success: false,
      error: { message: error instanceof Error ? error.message : 'Failed to insert record' }
    }, 500);
  }
});

// Update record
db.put('/:tableName/update', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const tableName = c.req.param('tableName');
    const entityTarget = getEntityTarget(tableName);
    if (!entityTarget) return c.json({ success: false, error: { message: `Invalid table name: ${tableName}` }}, 400);

    const { where, data } = await c.req.json();
    if (!where || !data) return c.json({ success: false, error: { message: "Request body must include 'where' criteria and 'data' to update." }}, 400);
    
    const neonService = new NeonService(c);
    const result = await neonService.update(entityTarget, where, data);
    
    // Check if any rows were affected
    if (result.affected === 0) {
        return c.json({ success: false, message: 'No matching records found to update.', data: result }, 404);
    }
    return c.json({ success: true, data: result });

  } catch (error) {
    console.error('Error updating record:', error);
    return c.json({
      success: false,
      error: { message: error instanceof Error ? error.message : 'Failed to update record' }
    }, 500);
  }
});

// Delete record
db.delete('/:tableName/delete', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const tableName = c.req.param('tableName');
    const entityTarget = getEntityTarget(tableName);
    if (!entityTarget) return c.json({ success: false, error: { message: `Invalid table name: ${tableName}` }}, 400);

    const where = await c.req.json();
    if (!where || Object.keys(where).length === 0) return c.json({ success: false, error: { message: "Request body must include 'where' criteria for deletion." }}, 400);

    const neonService = new NeonService(c);
    const result = await neonService.delete(entityTarget, where);

    // Check if any rows were deleted
    if (result.affected === 0) {
        return c.json({ success: false, message: 'No matching records found to delete.', data: result }, 404);
    }
    // Return DeleteResult (includes affected count)
    return c.json({ success: true, data: result }); 

  } catch (error) {
    console.error('Error deleting record:', error);
    return c.json({
      success: false,
      error: { message: error instanceof Error ? error.message : 'Failed to delete record' }
    }, 500);
  }
});

// --- Temporary Debug Route for Raw Query ---
db.get('/debug/raw-user/:id', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  const userId = c.req.param('id');
  const dbUrl = c.env.DATABASE_URL;
  if (!userId) return c.json({ success: false, error: 'User ID required in path' }, 400);
  if (!dbUrl) return c.json({ success: false, error: 'DATABASE_URL not configured' }, 500);

  const requestId = c.req.header('cf-request-id') || `local-debug-${Date.now()}`;
  console.log(`[${requestId}] Route /debug/raw-user: START, ID: ${userId}`);

  const client = new Client(addConnectTimeout(dbUrl));
  let result;
  try {
    console.log(`[${requestId}] Route /debug/raw-user: Connecting client...`);
    await client.connect();
    console.log(`[${requestId}] Route /debug/raw-user: Client connected. Executing raw query...`);
    
    // Use lowercase table name and lowercase id column as is typical
    const sql = 'SELECT * FROM users WHERE id = $1 LIMIT 1';
    result = await client.query(sql, [userId]);
    
    console.log(`[${requestId}] Route /debug/raw-user: Query executed. Row count: ${result?.rowCount}`);
    
    await client.end();
    console.log(`[${requestId}] Route /debug/raw-user: Client disconnected.`);
    
    return c.json({ 
        success: true, 
        rowCount: result?.rowCount ?? 0,
        data: result?.rows ?? [] 
    });

  } catch (error) {
    console.error(`[${requestId}] Route /debug/raw-user: CATCH block. Error:`, error);
    // Ensure client connection is terminated on error
    try { await client.end(); } catch (endErr) { console.error('Error ending client connection after query error:', endErr); }
    
    return c.json({
      success: false,
      error: { message: error instanceof Error ? error.message : 'Failed raw query' }
    }, 500);
  } finally {
      console.log(`[${requestId}] Route /debug/raw-user: FINALLY block.`);
      // Ensure client ends even if return happens before finally (shouldn't with async/await)
      // Added explicit end in try/catch blocks, but belt-and-suspenders
      // await client.end(); // Potential double-end, rely on try/catch for now.
  }
});
// --- End Temporary Debug Route --- 