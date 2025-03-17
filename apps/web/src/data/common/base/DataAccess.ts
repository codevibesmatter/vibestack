import { db } from '../../../db';
import { ensureDB } from '../../../db/types';
import { PGliteWorker } from '@electric-sql/pglite/worker';
import { ChangeOperation } from '../../../changes/types';
import { changesLogger } from '../../../utils/logger';

// Maximum time a database operation should take before timing out (in milliseconds)
const DB_OPERATION_TIMEOUT = 30000; // 30 seconds

/**
 * Performance metrics for database operations
 */
export interface PerformanceMetrics {
  queryTime: number;
  totalTime: number;
}

/**
 * Options for find operations
 */
export interface FindOptions {
  select?: string[];
  where?: Record<string, any>;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

/**
 * Result of a database operation with performance metrics
 */
export interface DataResult<T> {
  data: T;
  metrics: PerformanceMetrics;
}

/**
 * Base DataAccess class for database operations
 */
export class DataAccess<T extends Record<string, any>> {
  private tableName: string;
  
  /**
   * Create a new DataAccess instance
   * @param tableName The database table name
   */
  constructor(tableName: string) {
    this.tableName = tableName;
  }
  
  /**
   * Get the database connection
   * @returns The database connection
   */
  private getDB(): PGliteWorker | null {
    return db;
  }
  
  /**
   * Execute a SQL query with performance tracking
   * @param sql The SQL query
   * @param params The query parameters
   * @returns The query result with performance metrics
   */
  protected async executeQuery<R>(sql: string, params: any[] = []): Promise<DataResult<R>> {
    const startTime = performance.now();
    
    try {
      const database = this.getDB();
      if (!database) {
        throw new Error('Database connection is null');
      }
      
      // Log the query and parameters for debugging
      console.log(`Executing query on table ${this.tableName}:`, sql);
      console.log('Query parameters:', params);
      
      const result = await ensureDB(database).query(sql, params);
      
      const queryTime = performance.now() - startTime;
      
      // Log successful query results
      console.log(`Query completed in ${queryTime.toFixed(2)}ms with ${result.rows.length} rows`);
      
      return {
        data: result.rows as R,
        metrics: {
          queryTime,
          totalTime: queryTime
        }
      };
    } catch (error) {
      const queryTime = performance.now() - startTime;
      console.error(`Error executing query on table ${this.tableName}:`, sql);
      console.error('Query parameters:', params);
      console.error('Error details:', error);
      console.error(`Query failed after ${queryTime.toFixed(2)}ms`);
      throw error;
    }
  }
  
  /**
   * Find all entities matching the given options
   * @param options The find options
   * @returns The found entities with performance metrics
   */
  async findAll(options: FindOptions = {}): Promise<DataResult<T[]>> {
    const { select = ['*'], where = {}, orderBy, limit, offset } = options;
    
    // Build the SELECT clause
    const selectClause = select.join(', ');
    
    // Build the WHERE clause
    const whereConditions = Object.entries(where);
    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.map((entry, index) => `"${entry[0]}" = $${index + 1}`).join(' AND ')}`
      : '';
    
    // Build the ORDER BY clause
    const orderByClause = orderBy ? `ORDER BY ${orderBy}` : '';
    
    // Build the LIMIT clause
    const limitClause = limit ? `LIMIT ${limit}` : '';
    
    // Build the OFFSET clause
    const offsetClause = offset ? `OFFSET ${offset}` : '';
    
    // Build the complete query
    const sql = `
      SELECT ${selectClause}
      FROM "${this.tableName}"
      ${whereClause}
      ${orderByClause}
      ${limitClause}
      ${offsetClause}
    `;
    
    // Extract the values from the where conditions
    const params = whereConditions.map(entry => entry[1]);
    
    // Execute the query
    return this.executeQuery<T[]>(sql, params);
  }
  
  /**
   * Find an entity by ID
   * @param id The entity ID
   * @param options Additional find options
   * @returns The found entity with performance metrics
   */
  async findById(id: string, options: Omit<FindOptions, 'where'> = {}): Promise<DataResult<T | null>> {
    const result = await this.findAll({
      ...options,
      where: { id },
      limit: 1
    });
    
    return {
      data: result.data.length > 0 ? result.data[0] : null,
      metrics: result.metrics
    };
  }
  
  /**
   * Create an entity
   * @param data The entity data
   * @returns The created entity with performance metrics
   */
  async create(data: Omit<T, 'id'> & { id?: string }): Promise<DataResult<T>> {
    // Generate an ID if not provided
    const id = data.id || crypto.randomUUID();
    
    // Add the ID to the data
    const entityData = {
      ...data,
      id
    };
    
    try {
      // Get the column names and values
      const columns = Object.keys(entityData);
      const values = Object.values(entityData);
      
      // Build the INSERT query
      const sql = `
        INSERT INTO "${this.tableName}" (${columns.map(c => `"${c}"`).join(', ')})
        VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
        RETURNING *
      `;
      
      // Execute the query
      const result = await this.executeQuery<T[]>(sql, values);
      
      return {
        data: result.data[0],
        metrics: result.metrics
      };
    } catch (error) {
      // If the error is about a non-existent column, try again with filtered columns
      if (error instanceof Error && error.message.includes('column') && error.message.includes('does not exist')) {
        console.warn(`Column error detected, attempting to create ${this.tableName} with filtered columns`);
        
        // Get table columns first
        const columnsResult = await this.executeQuery<{column_name: string}[]>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
          [this.tableName]
        );
        
        const validColumns = columnsResult.data.map(col => col.column_name);
        
        // Filter the data to only include valid columns
        const filteredData: Record<string, any> = { id };
        
        for (const key of Object.keys(data)) {
          if (validColumns.includes(key)) {
            filteredData[key] = (data as any)[key];
          } else {
            console.warn(`Ignoring non-existent column "${key}" for table "${this.tableName}"`);
          }
        }
        
        // Get the filtered column names and values
        const filteredColumns = Object.keys(filteredData);
        const filteredValues = Object.values(filteredData);
        
        // Build the INSERT query with filtered columns
        const filteredSql = `
          INSERT INTO "${this.tableName}" (${filteredColumns.map(c => `"${c}"`).join(', ')})
          VALUES (${filteredColumns.map((_, i) => `$${i + 1}`).join(', ')})
          RETURNING *
        `;
        
        // Execute the query with filtered data
        const filteredResult = await this.executeQuery<T[]>(filteredSql, filteredValues);
        
        return {
          data: filteredResult.data[0],
          metrics: filteredResult.metrics
        };
      }
      
      // If it's not a column error or the filtered attempt also failed, rethrow
      throw error;
    }
  }
  
  /**
   * Update an entity
   * @param id The entity ID
   * @param data The entity data to update
   * @returns The updated entity with performance metrics
   */
  async update(id: string, data: Partial<T>): Promise<DataResult<T>> {
    try {
      // Get the column names and values
      const columns = Object.keys(data);
      const values = Object.values(data);
      
      // Build the UPDATE query
      const sql = `
        UPDATE "${this.tableName}"
        SET ${columns.map((c, i) => `"${c}" = $${i + 1}`).join(', ')}
        WHERE id = $${columns.length + 1}
        RETURNING *
      `;
      
      // Execute the query
      const result = await this.executeQuery<T[]>(sql, [...values, id]);
      
      return {
        data: result.data[0],
        metrics: result.metrics
      };
    } catch (error) {
      // If the error is about a non-existent column, try again with filtered columns
      if (error instanceof Error && error.message.includes('column') && error.message.includes('does not exist')) {
        console.warn(`Column error detected, attempting to update ${this.tableName} with filtered columns`);
        
        // Get table columns first
        const columnsResult = await this.executeQuery<{column_name: string}[]>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
          [this.tableName]
        );
        
        const validColumns = columnsResult.data.map(col => col.column_name);
        
        // Filter the data to only include valid columns
        const filteredData: Record<string, any> = {};
        
        for (const key of Object.keys(data)) {
          if (validColumns.includes(key)) {
            filteredData[key] = (data as any)[key];
          } else {
            console.warn(`Ignoring non-existent column "${key}" for table "${this.tableName}"`);
          }
        }
        
        // If no valid columns to update, just return the existing entity
        if (Object.keys(filteredData).length === 0) {
          const existingResult = await this.findById(id);
          if (!existingResult.data) {
            throw new Error(`Entity with ID ${id} not found`);
          }
          return existingResult as DataResult<T>;
        }
        
        // Get the filtered column names and values
        const filteredColumns = Object.keys(filteredData);
        const filteredValues = Object.values(filteredData);
        
        // Build the UPDATE query with filtered columns
        const filteredSql = `
          UPDATE "${this.tableName}"
          SET ${filteredColumns.map((c, i) => `"${c}" = $${i + 1}`).join(', ')}
          WHERE id = $${filteredColumns.length + 1}
          RETURNING *
        `;
        
        // Execute the query with filtered data
        const filteredResult = await this.executeQuery<T[]>(filteredSql, [...filteredValues, id]);
        
        return {
          data: filteredResult.data[0],
          metrics: filteredResult.metrics
        };
      }
      
      // If it's not a column error or the filtered attempt also failed, rethrow
      throw error;
    }
  }
  
  /**
   * Delete an entity
   * @param id The entity ID
   * @returns The deleted entity with performance metrics
   */
  async delete(id: string): Promise<DataResult<T>> {
    // Build the DELETE query
    const sql = `
      DELETE FROM "${this.tableName}"
      WHERE id = $1
      RETURNING *
    `;
    
    // Execute the query
    const result = await this.executeQuery<T[]>(sql, [id]);
    
    return {
      data: result.data[0],
      metrics: result.metrics
    };
  }
  
  /**
   * Execute a batch of queries
   * @param queries The queries to execute
   * @returns The query results with performance metrics
   */
  async batchQuery(queries: string[]): Promise<DataResult<any[]>> {
    const startTime = performance.now();
    
    try {
      const database = this.getDB();
      const results = [];
      
      for (const query of queries) {
        const result = await ensureDB(database).query(query);
        results.push(result.rows);
      }
      
      const queryTime = performance.now() - startTime;
      
      return {
        data: results,
        metrics: {
          queryTime,
          totalTime: queryTime
        }
      };
    } catch (error) {
      console.error('Error executing batch query', error);
      throw error;
    }
  }
  
  /**
   * Count entities matching the given conditions
   * @param where The where conditions
   * @returns The count with performance metrics
   */
  async count(where: Record<string, any> = {}): Promise<DataResult<number>> {
    // Build the WHERE clause
    const whereConditions = Object.entries(where);
    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.map((entry, index) => `"${entry[0]}" = $${index + 1}`).join(' AND ')}`
      : '';
    
    // Build the complete query
    const sql = `
      SELECT COUNT(*) as count
      FROM "${this.tableName}"
      ${whereClause}
    `;
    
    // Extract the values from the where conditions
    const params = whereConditions.map(entry => entry[1]);
    
    // Execute the query
    const result = await this.executeQuery<{ count: string }[]>(sql, params);
    
    return {
      data: parseInt(result.data[0].count, 10),
      metrics: result.metrics
    };
  }
}

/**
 * Execute a database operation with a timeout
 * @param operation The operation function to execute
 * @param operationName The name of the operation for logging
 * @param entityType The type of entity being operated on
 * @param entityId The ID of the entity (if applicable)
 * @returns The result of the operation
 * @throws Error if the operation times out
 */
export async function executeWithTimeout<T>(
  operation: () => Promise<T>,
  operationName: string,
  entityType: string,
  entityId?: string
): Promise<T> {
  // Create a promise that will reject after the timeout
  const timeoutPromise = new Promise<T>((_, reject) => {
    setTimeout(() => {
      const idInfo = entityId ? ` (ID: ${entityId})` : '';
      const errorMessage = `Database operation '${operationName}' on ${entityType}${idInfo} timed out after ${DB_OPERATION_TIMEOUT}ms`;
      changesLogger.logServiceError(errorMessage, new Error(errorMessage));
      reject(new Error(errorMessage));
    }, DB_OPERATION_TIMEOUT);
  });

  // Race the operation against the timeout
  return Promise.race([operation(), timeoutPromise]);
} 