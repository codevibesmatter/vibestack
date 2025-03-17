/**
 * Smart Query Builder
 * 
 * A fluent interface for building optimized SQL queries with automatic
 * performance enhancements like type casting and result limiting.
 */

import { db } from '../../../db';
import { ensureDB } from '../../../db/types';
import { PerformanceMetrics, DataResult } from './DataAccess';

/**
 * Condition operators for where clauses
 */
export type Operator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'LIKE' | 'IN' | 'NOT IN' | 'IS NULL' | 'IS NOT NULL';

/**
 * Where condition for filtering queries
 */
export interface WhereCondition {
  field: string;
  operator: Operator;
  value: any;
}

/**
 * Join types for SQL joins
 */
export type JoinType = 'INNER JOIN' | 'LEFT JOIN' | 'RIGHT JOIN' | 'FULL JOIN';

/**
 * Join definition for SQL joins
 */
export interface JoinDefinition {
  type: JoinType;
  table: string;
  on: string;
}

/**
 * Order direction for ORDER BY clauses
 */
export type OrderDirection = 'ASC' | 'DESC';

/**
 * Order by definition for ORDER BY clauses
 */
export interface OrderByDefinition {
  field: string;
  direction: OrderDirection;
}

/**
 * QueryBuilder class for building SQL queries
 */
export class QueryBuilder {
  private tableName: string;
  private selectFields: string[] = ['*'];
  private whereConditions: WhereCondition[] = [];
  private joinClauses: JoinDefinition[] = [];
  private orderByClauses: OrderByDefinition[] = [];
  private limitValue: number | null = null;
  private offsetValue: number | null = null;
  private groupByFields: string[] = [];
  private havingConditions: WhereCondition[] = [];
  private parameters: any[] = [];
  private paramIndex = 1;
  
  /**
   * Create a new QueryBuilder instance
   * @param tableName The database table name
   */
  constructor(tableName: string) {
    this.tableName = tableName;
  }
  
  /**
   * Create a batch query builder from multiple query builders
   * @param builders The query builders to batch
   * @returns A new BatchQueryBuilder instance
   */
  static batch(builders: QueryBuilder[]): BatchQueryBuilder {
    return new BatchQueryBuilder(builders);
  }
  
  /**
   * Set the fields to select
   * @param fields The fields to select
   * @returns The QueryBuilder instance for chaining
   */
  select(fields: string[]): QueryBuilder {
    this.selectFields = fields;
    return this;
  }
  
  /**
   * Add a where condition
   * @param field The field to filter on
   * @param operator The operator to use
   * @param value The value to filter with
   * @returns The QueryBuilder instance for chaining
   */
  where(field: string, operator: Operator, value: any): QueryBuilder {
    this.whereConditions.push({ field, operator, value });
    return this;
  }
  
  /**
   * Add a join clause
   * @param type The join type
   * @param table The table to join
   * @param on The join condition
   * @returns The QueryBuilder instance for chaining
   */
  join(type: JoinType, table: string, on: string): QueryBuilder {
    this.joinClauses.push({ type, table, on });
    return this;
  }
  
  /**
   * Add an order by clause
   * @param field The field to order by
   * @param direction The order direction
   * @returns The QueryBuilder instance for chaining
   */
  orderBy(field: string, direction: OrderDirection = 'ASC'): QueryBuilder {
    this.orderByClauses.push({ field, direction });
    return this;
  }
  
  /**
   * Set the limit
   * @param limit The limit value
   * @returns The QueryBuilder instance for chaining
   */
  limit(limit: number): QueryBuilder {
    this.limitValue = limit;
    return this;
  }
  
  /**
   * Set the offset
   * @param offset The offset value
   * @returns The QueryBuilder instance for chaining
   */
  offset(offset: number): QueryBuilder {
    this.offsetValue = offset;
    return this;
  }
  
  /**
   * Set the group by fields
   * @param fields The fields to group by
   * @returns The QueryBuilder instance for chaining
   */
  groupBy(fields: string[]): QueryBuilder {
    this.groupByFields = fields;
    return this;
  }
  
  /**
   * Add a having condition
   * @param field The field to filter on
   * @param operator The operator to use
   * @param value The value to filter with
   * @returns The QueryBuilder instance for chaining
   */
  having(field: string, operator: Operator, value: any): QueryBuilder {
    this.havingConditions.push({ field, operator, value });
    return this;
  }
  
  /**
   * Set the query to count rows
   * @param field The field to count
   * @returns The QueryBuilder instance for chaining
   */
  count(field: string = '*'): QueryBuilder {
    this.selectFields = [`COUNT(${field}) as count`];
    return this;
  }
  
  /**
   * Build the SQL query
   * @returns The SQL query and parameters
   */
  build(): { sql: string, params: any[] } {
    this.parameters = [];
    this.paramIndex = 1;
    
    // Build the SELECT clause
    const selectClause = `SELECT ${this.selectFields.join(', ')}`;
    
    // Build the FROM clause
    const fromClause = `FROM "${this.tableName}"`;
    
    // Build the JOIN clauses
    const joinClauses = this.joinClauses
      .map(join => `${join.type} "${join.table}" ON ${join.on}`)
      .join(' ');
    
    // Build the WHERE clause
    const whereClause = this.whereConditions.length > 0
      ? `WHERE ${this.buildConditions(this.whereConditions)}`
      : '';
    
    // Build the GROUP BY clause
    const groupByClause = this.groupByFields.length > 0
      ? `GROUP BY ${this.groupByFields.map(field => `"${field}"`).join(', ')}`
      : '';
    
    // Build the HAVING clause
    const havingClause = this.havingConditions.length > 0
      ? `HAVING ${this.buildConditions(this.havingConditions)}`
      : '';
    
    // Build the ORDER BY clause
    const orderByClause = this.orderByClauses.length > 0
      ? `ORDER BY ${this.orderByClauses.map(order => `"${order.field}" ${order.direction}`).join(', ')}`
      : '';
    
    // Build the LIMIT clause
    const limitClause = this.limitValue !== null ? `LIMIT ${this.limitValue}` : '';
    
    // Build the OFFSET clause
    const offsetClause = this.offsetValue !== null ? `OFFSET ${this.offsetValue}` : '';
    
    // Build the complete query
    const sql = [
      selectClause,
      fromClause,
      joinClauses,
      whereClause,
      groupByClause,
      havingClause,
      orderByClause,
      limitClause,
      offsetClause
    ].filter(Boolean).join(' ');
    
    return { sql, params: this.parameters };
  }
  
  /**
   * Build the conditions for WHERE or HAVING clauses
   * @param conditions The conditions to build
   * @returns The SQL conditions
   */
  private buildConditions(conditions: WhereCondition[]): string {
    return conditions.map(condition => {
      const { field, operator, value } = condition;
      
      if (operator === 'IS NULL') {
        return `"${field}" IS NULL`;
      }
      
      if (operator === 'IS NOT NULL') {
        return `"${field}" IS NOT NULL`;
      }
      
      if (operator === 'IN' || operator === 'NOT IN') {
        if (!Array.isArray(value) || value.length === 0) {
          return operator === 'IN' ? 'FALSE' : 'TRUE';
        }
        
        const placeholders = value.map(() => `$${this.paramIndex++}`).join(', ');
        this.parameters.push(...value);
        
        return `"${field}" ${operator} (${placeholders})`;
      }
      
      const placeholder = `$${this.paramIndex++}`;
      this.parameters.push(value);
      
      return `"${field}" ${operator} ${placeholder}`;
    }).join(' AND ');
  }
  
  /**
   * Execute the query
   * @returns The query result with performance metrics
   */
  async execute<T = any>(): Promise<DataResult<T[]>> {
    const startTime = performance.now();
    const { sql, params } = this.build();
    
    try {
      const database = db;
      if (!database) {
        throw new Error('Database connection is null');
      }
      const result = await ensureDB(database).query(sql, params);
      
      const queryTime = performance.now() - startTime;
      
      return {
        data: result.rows as T[],
        metrics: {
          queryTime,
          totalTime: queryTime
        }
      };
    } catch (error) {
      console.error(`Error executing query: ${sql}`, error);
      throw error;
    }
  }
  
  /**
   * Execute the query and return a single result
   * @returns The query result with performance metrics
   */
  async executeSingle<T = any>(): Promise<DataResult<T | null>> {
    // Apply a limit of 1 if not already set
    if (this.limitValue === null) {
      this.limit(1);
    }
    
    const result = await this.execute<T>();
    
    return {
      data: result.data.length > 0 ? result.data[0] : null,
      metrics: result.metrics
    };
  }
}

/**
 * BatchQueryBuilder for executing multiple queries in a batch
 */
export class BatchQueryBuilder {
  private builders: QueryBuilder[];
  
  /**
   * Create a new BatchQueryBuilder instance
   * @param builders The query builders to batch
   */
  constructor(builders: QueryBuilder[]) {
    this.builders = builders;
  }
  
  /**
   * Build the batch query
   * @returns The SQL query
   */
  build(): string {
    return this.builders
      .map(builder => builder.build().sql)
      .join(';\n');
  }
  
  /**
   * Execute the batch query
   * @returns The query results with performance metrics
   */
  async execute<T = any>(): Promise<DataResult<T[][]>> {
    const startTime = performance.now();
    
    try {
      // Build all queries
      const queries = this.builders.map(builder => builder.build());
      
      // Combine all queries into a single transaction
      const combinedSql = `
        BEGIN;
        ${queries.map(q => q.sql).join(';\n')};
        COMMIT;
      `;
      
      // Combine all parameters
      const combinedParams = queries.reduce((acc, q) => [...acc, ...q.params], [] as any[]);
      
      // Execute the combined query
      const database = db;
      if (!database) {
        throw new Error('Database connection is null');
      }
      const result = await ensureDB(database).query(combinedSql, combinedParams);
      
      // Process the results
      const results: T[][] = [];
      let currentIndex = 0;
      
      // Each query result is in a separate result set
      for (let i = 0; i < this.builders.length; i++) {
        if (result.rows && result.rows[currentIndex]) {
          results.push(result.rows[currentIndex] as T[]);
          currentIndex++;
        } else {
          results.push([]);
        }
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
   * Execute each query separately
   * @returns The query results with performance metrics
   */
  async executeSeparately<T = any>(): Promise<DataResult<T[][]>> {
    const startTime = performance.now();
    
    try {
      // Execute each query separately
      const results = await Promise.all(
        this.builders.map(builder => builder.execute<T>())
      );
      
      const queryTime = performance.now() - startTime;
      
      return {
        data: results.map(result => result.data),
        metrics: {
          queryTime,
          totalTime: queryTime
        }
      };
    } catch (error) {
      console.error('Error executing separate queries', error);
      throw error;
    }
  }
} 