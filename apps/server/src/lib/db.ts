import { Client, QueryResultRow } from '@neondatabase/serverless';
import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { AppContext, MinimalContext } from '../types/hono';

// Add connect_timeout to URL if not present
function addConnectTimeout(url: string): string {
  const dbUrl = new URL(url);
  if (!dbUrl.searchParams.has('connect_timeout')) {
    dbUrl.searchParams.set('connect_timeout', '10');
  }
  if (!dbUrl.searchParams.has('sslmode')) {
    dbUrl.searchParams.set('sslmode', 'require');
  }
  return dbUrl.toString();
}

// Get database URL from context
function getDatabaseURL(c: Context<{ Bindings: Env }> | MinimalContext): string {
  const url = c.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return url;
}

// Initialize database client
export const getDBClient = (c: Context<{ Bindings: Env }> | MinimalContext) => {
  const urlWithTimeout = addConnectTimeout(getDatabaseURL(c));
  return new Client({
    connectionString: urlWithTimeout,
    ssl: true
  });
};

// Direct query execution with proper connection management
export async function sql<T extends QueryResultRow = QueryResultRow>(
  c: Context<{ Bindings: Env }> | MinimalContext,
  query: string,
  params: any[] = []
): Promise<T[]> {
  const client = getDBClient(c);
  try {
    await client.connect();
    const result = await client.query<T>(query, params);
    return result.rows;
  } finally {
    try {
      await client.end();
    } catch (err) {
      console.error('Error closing connection:', err);
    }
  }
}

// Query execution helpers
export async function executeQuery<T extends QueryResultRow = QueryResultRow>(
  client: Client,
  query: string,
  params: any[] = []
): Promise<T[]> {
  const result = await client.query<T>(query, params);
  return result.rows;
}

export async function executeQuerySingle<T extends QueryResultRow = QueryResultRow>(
  client: Client,
  query: string,
  params: any[] = []
): Promise<T | null> {
  const results = await executeQuery<T>(client, query, params);
  return results[0] || null;
}

// Pagination
export interface QueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
}

export function buildPaginationClause(options?: QueryOptions): string {
  if (!options) return '';
  
  const clauses: string[] = [];
  
  if (options.orderBy) {
    clauses.push(`ORDER BY ${options.orderBy} ${options.orderDir || 'asc'}`);
  }
  
  if (options.limit) {
    clauses.push(`LIMIT ${options.limit}`);
  }
  
  if (options.offset) {
    clauses.push(`OFFSET ${options.offset}`);
  }
  
  return clauses.join(' ');
}

// Case conversion utilities
export function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function transformKeys<T extends Record<string, any>>(
  obj: T,
  transform: (key: string) => string
): Record<string, any> {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [transform(key), value])
  );
}

export interface TableData {
  tableName: string;
  rows: Record<string, any>[];
}

export async function fetchAllTableData(c: Context<{ Bindings: Env }>): Promise<TableData[]> {
  // Get list of tables in public schema (excluding system tables)
  interface TableRow {
    tablename: string;
  }
  
  const tablesResult = await sql<TableRow>(c, `
    SELECT tablename 
    FROM pg_tables 
    WHERE schemaname = 'public'
    AND tablename NOT IN ('client_migration', 'wal_changes')
    ORDER BY tablename;
  `);

  const tables = tablesResult.map(r => r.tablename);
  const tableData: TableData[] = [];

  // Fetch data from each table
  for (const tableName of tables) {
    const rows = await sql(c, `
      SELECT * FROM "${tableName}";
    `);
    
    tableData.push({
      tableName,
      rows
    });
  }

  return tableData;
}

// Domain tables that can be queried
export const DOMAIN_TABLES = [
  'user',
  'project',
  'task',
  'task_comment',
  'time_tracking_entry'
] as const;

// Fetch data from all domain tables
export async function fetchDomainTableData(c: Context<{ Bindings: Env }> | MinimalContext): Promise<TableData[]> {
  const client = getDBClient(c);
  try {
    await client.connect();
    const tableData = [];

    // Fetch data from each domain table
    for (const tableName of DOMAIN_TABLES) {
      const rows = await client.query(`
        SELECT * FROM "${tableName}";
      `);
      
      tableData.push({
        tableName,
        rows: rows.rows
      });
    }

    return tableData;
  } finally {
    await client.end();
  }
}

// Health check
export async function checkDatabaseHealth(c: Context<{ Bindings: Env }> | MinimalContext): Promise<{
  healthy: boolean;
  latency: number;
  tables?: Array<{ name: string; rowCount: number }>;
  tableCount?: number;
  error?: string;
}> {
  const start = Date.now();
  const client = getDBClient(c);
  
  try {
    await client.connect();
    await client.query('SELECT 1');
    
    // Get table information
    const tablesResult = await client.query<{ tablename: string }>(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);
    
    const tables = [];
    
    // Get row count for each table
    for (const { tablename } of tablesResult.rows) {
      const countResult = await client.query<{ count: number }>(`
        SELECT COUNT(*) as count FROM "${tablename}";
      `);
      
      const rowCount = Number(countResult.rows[0]?.count || 0);
      
      tables.push({
        name: tablename,
        rowCount
      });
    }
    
    return {
      healthy: true,
      latency: Date.now() - start,
      tables,
      tableCount: tables.length
    };
  } catch (error) {
    return {
      healthy: false,
      latency: Date.now() - start,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  } finally {
    try {
      await client.end();
    } catch (err) {
      console.error('Error closing connection:', err);
    }
  }
} 