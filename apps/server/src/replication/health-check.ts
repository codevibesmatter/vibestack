import type { Client } from '@neondatabase/serverless';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { TableChange } from '@repo/sync-types';
import { SERVER_DOMAIN_TABLES } from '@repo/typeorm/server-entities';
import { replicationLogger } from '../middleware/logger';
import type { 
  HealthCheckMetrics, 
  HealthCheckResult, 
  InitialCleanupResult,
  InitialCleanupMetrics,
  VerificationResult,
  VerificationMetrics
} from './types';
import { serverEntities } from '@repo/typeorm';
import { deduplicateChanges } from '../sync/server-changes';
import { getDBClient } from '../lib/db';
import type { MinimalContext } from '../types/hono';
import type { ChangeHistoryRow } from '../types/database';

/**
 * Ensure the health check state table exists
 */
export async function ensureHealthCheckTable(c: Context<{ Bindings: Env }> | MinimalContext): Promise<void> {
  const client = getDBClient(c);
  try {
    await client.connect();
    // Check if table exists
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'health_check_state'
      );
    `);
    
    if (!tableExists.rows[0].exists) {
      replicationLogger.error('Health check table does not exist. Please run the table creation SQL script.');
      throw new Error('Health check table does not exist');
    }
  } catch (error) {
    replicationLogger.error('Failed to check health check table:', error);
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Create a synthetic change record
 */
function createSyntheticChange(
  currentLSN: string,
  tableName: string,
  data: Record<string, unknown>,
  updated_at: string,
  reason: 'missing_change_detected' | 'early_record'
): Omit<ChangeHistoryRow, 'id'> {
  return {
    lsn: currentLSN,
    table_name: tableName,
    operation: 'update',
    data,
    updated_at: new Date(updated_at),
    client_id: null
  };
}

/**
 * Insert a synthetic change record into the change_history table
 */
async function insertSyntheticChange(
  client: Client,
  change: Omit<ChangeHistoryRow, 'id'>
): Promise<void> {
  await client.query(`
    INSERT INTO change_history (
      lsn,
      table_name,
      operation,
      data,
      updated_at,
      client_id
    ) VALUES (
      $1, $2, $3, $4, $5, $6
    )
  `, [
    change.lsn,
    change.table_name,
    change.operation,
    change.data,
    change.updated_at,
    change.client_id
  ]);
}

/**
 * Perform a health check to detect and reconcile missed changes
 * 
 * This function:
 * 1. Gets the timestamp of the last health check
 * 2. Scans domain tables for records updated since that timestamp
 * 3. Checks if these records have corresponding entries in change_history
 * 4. Creates synthetic change records for any missing changes
 * 
 * @param c Hono context or minimal context with environment bindings
 * @returns Health check result
 */
export async function performHealthCheck(c: Context<{ Bindings: Env }> | MinimalContext): Promise<HealthCheckResult> {
  replicationLogger.info('Starting replication health check');
  
  const startTime = Date.now();
  const client = getDBClient(c);
  
  try {
    await client.connect();
    
    // Ensure health check table exists
    await ensureHealthCheckTable(c);
    
    // Get current LSN to use for synthetic changes
    const lsnResult = await client.query(`SELECT pg_current_wal_lsn()::text as current_lsn`);
    const currentLSN = lsnResult.rows[0].current_lsn;
    
    // Get last health check timestamp
    const lastCheckResult = await client.query<Pick<ChangeHistoryRow, 'updated_at'>>(`
      SELECT updated_at 
      FROM change_history 
      WHERE metadata->>'source' = 'health_check'
      ORDER BY updated_at DESC 
      LIMIT 1
    `);
    
    // Default to 24 hours ago if no previous check
    const lastCheckTimestamp = lastCheckResult.rows.length > 0
      ? lastCheckResult.rows[0].updated_at
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    replicationLogger.info('Last health check timestamp:', { lastCheckTimestamp });
    
    // Track metrics for reporting
    const metrics: HealthCheckMetrics = {
      tables_checked: 0,
      records_scanned: 0,
      missing_changes_found: 0,
      synthetic_changes_created: 0,
      errors: 0,
      duration_ms: 0,
      tables_with_issues: []
    };
    
    try {
      // Process each domain table
      for (const tableName of SERVER_DOMAIN_TABLES) {
        try {
          // Start a transaction for this table
          await client.query('BEGIN');
          
          // Clean table name (remove quotes)
          const cleanTableName = tableName.replace(/"/g, '');
          
          replicationLogger.info(`Checking table: ${cleanTableName}`);
          metrics.tables_checked++;
          
          // Find records that need synthetic changes
          const updatedRecordsResult = await client.query(`
            WITH existing_changes AS (
              SELECT DISTINCT ON (data->>'id') 
                data->>'id' as record_id,
                updated_at
              FROM change_history 
              WHERE table_name = $1
              ORDER BY data->>'id', updated_at ASC
            )
            SELECT t.* 
            FROM ${tableName} t
            LEFT JOIN existing_changes ec ON t.id = ec.record_id
            WHERE ec.record_id IS NULL
               OR t.updated_at > $2::timestamp
            ORDER BY t.updated_at ASC
          `, [lastCheckTimestamp]);
          
          const updatedRecords = updatedRecordsResult.rows;
          metrics.records_scanned += updatedRecords.length;
          
          replicationLogger.info(`Found ${updatedRecords.length} updated records in ${cleanTableName}`);
          
          let tableHasIssues = false;
          
          // For each updated record, check if it has a corresponding change_history entry
          for (const record of updatedRecords) {
            // Check if this record has a change in change_history
            const changeHistoryResult = await client.query(`
              SELECT COUNT(*) as count
              FROM change_history
              WHERE table_name = $1
              AND data->>'id' = $2
              AND updated_at > $3::timestamp
            `, [cleanTableName, record.id, lastCheckTimestamp]);
            
            // Convert count to number for comparison (PostgreSQL returns it as a string)
            const count = parseInt(changeHistoryResult.rows[0].count, 10);
            
            // If no change history entry exists, create a synthetic one
            if (count === 0) {
              replicationLogger.info(`Missing change detected for ${cleanTableName}/${record.id}`);
              metrics.missing_changes_found++;
              tableHasIssues = true;
              
              // Create a synthetic change record
              await client.query(`
                INSERT INTO change_history (
                  id, lsn, table_name, operation, data,
                  updated_at, client_id
                ) VALUES (
                  uuid_generate_v4(),
                  $1,
                  $2,
                  'insert',
                  $3,
                  $4::timestamp,
                  NULL
                )
              `, [currentLSN, cleanTableName, JSON.stringify(record), record.updated_at]);
              
              metrics.synthetic_changes_created++;
            }
          }
          
          if (tableHasIssues) {
            metrics.tables_with_issues.push(cleanTableName);
          }
        } catch (error) {
          replicationLogger.error(`Error checking table ${tableName}:`, error);
          metrics.errors++;
          metrics.tables_with_issues.push(tableName.replace(/"/g, ''));
        }
      }
      
      // Update health check state
      await client.query(`
        INSERT INTO health_check_state (
          last_run_timestamp, status, metrics
        ) VALUES (
          CURRENT_TIMESTAMP,
          $1,
          $2
        )
      `, [
        metrics.errors > 0 ? 'completed_with_errors' : 'completed',
        JSON.stringify(metrics)
      ]);
      
      metrics.duration_ms = Date.now() - startTime;
      
      replicationLogger.info('Health check completed', { 
        duration_ms: metrics.duration_ms,
        tables_checked: metrics.tables_checked,
        records_scanned: metrics.records_scanned,
        missing_changes_found: metrics.missing_changes_found,
        synthetic_changes_created: metrics.synthetic_changes_created,
        errors: metrics.errors,
        tables_with_issues: metrics.tables_with_issues
      });
      
      return {
        success: true,
        timestamp: new Date().toISOString(),
        metrics
      };
    } catch (error) {
      metrics.duration_ms = Date.now() - startTime;
      
      replicationLogger.error('Health check failed:', error);
      
      return {
        success: false,
        timestamp: new Date().toISOString(),
        metrics,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  } catch (error) {
    replicationLogger.error('Health check failed:', error);
    return {
      success: false,
      timestamp: new Date().toISOString(),
      metrics: {
        tables_checked: 0,
        records_scanned: 0,
        missing_changes_found: 0,
        synthetic_changes_created: 0,
        errors: 1,
        duration_ms: Date.now() - startTime,
        tables_with_issues: []
      },
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client.end();
  }
}

/**
 * Perform an initial cleanup to detect and reconcile records created before replication was set up
 * 
 * This function:
 * 1. Finds the earliest timestamp in the change_history table
 * 2. For each domain table, finds records that either:
 *    a) Were created before that timestamp, or
 *    b) Have no corresponding change history entries
 * 3. Creates synthetic change records for those entries
 * 
 * @param c Hono context or minimal context with environment bindings
 * @returns Initial cleanup result
 */
export async function performInitialCleanup(c: Context<{ Bindings: Env }> | MinimalContext): Promise<InitialCleanupResult> {
  replicationLogger.info('Starting initial replication cleanup');
  
  const startTime = Date.now();
  const client = getDBClient(c);
  
  try {
    await client.connect();
    
    // Ensure health check table exists
    await ensureHealthCheckTable(c);
    
    // Find the earliest timestamp in change_history
    const earliestChangeResult = await client.query(`
      SELECT MIN(updated_at) as earliest_timestamp
      FROM change_history
    `);
    
    // If no changes exist yet, use current time as reference
    const earliestChangeTimestamp = earliestChangeResult.rows[0].earliest_timestamp
      ? earliestChangeResult.rows[0].earliest_timestamp
      : new Date().toISOString();
    
    replicationLogger.info('Earliest change timestamp:', { earliestChangeTimestamp });
    
    // Track metrics for reporting
    const metrics: InitialCleanupMetrics = {
      tables_checked: 0,
      records_scanned: 0,
      early_records_found: 0,
      synthetic_changes_created: 0,
      errors: 0,
      duration_ms: 0,
      tables_with_issues: []
    };
    
    try {
      // Get current LSN to use for synthetic changes
      const lsnResult = await client.query(`SELECT pg_current_wal_lsn()::text as current_lsn`);
      const currentLSN = lsnResult.rows[0].current_lsn;
      
      // Process each domain table
      for (const tableName of SERVER_DOMAIN_TABLES) {
        try {
          // Start a transaction for this table
          await client.query('BEGIN');
          
          // Clean table name (remove quotes)
          const cleanTableName = tableName.replace(/"/g, '');
          
          replicationLogger.info(`Checking table: ${cleanTableName}`);
          metrics.tables_checked++;
          
          // Find records that either:
          // 1. Were created before change history tracking started, or
          // 2. Have no corresponding change history entries
          const updatedRecordsResult = await client.query(`
            WITH existing_changes AS (
              SELECT DISTINCT ON (data->>'id') 
                data->>'id' as record_id,
                updated_at
              FROM change_history 
              WHERE table_name = $1
              ORDER BY data->>'id', updated_at ASC
            )
            SELECT t.* 
            FROM ${tableName} t
            LEFT JOIN existing_changes ec ON t.id = ec.record_id
            WHERE ec.record_id IS NULL
               OR t.created_at < $2::timestamp
            ORDER BY t.created_at ASC
          `, [cleanTableName, earliestChangeTimestamp]);
          
          const recordsToProcess = updatedRecordsResult.rows;
          metrics.records_scanned += recordsToProcess.length;
          
          replicationLogger.info(`Found ${recordsToProcess.length} records to process in ${cleanTableName}`);
          
          let tableHasIssues = false;
          
          // Create synthetic changes for each record
          for (const record of recordsToProcess) {
            metrics.early_records_found++;
            tableHasIssues = true;
            
            // Create a synthetic change record
            await client.query(`
              INSERT INTO change_history (
                id, lsn, table_name, operation, data,
                updated_at, client_id
              ) VALUES (
                uuid_generate_v4(),
                $1,
                $2,
                'insert',
                $3,
                $4::timestamp,
                NULL
              )
            `, [currentLSN, cleanTableName, JSON.stringify(record), record.created_at]);
            
            metrics.synthetic_changes_created++;
          }
          
          // Commit the transaction
          await client.query('COMMIT');
          
          if (tableHasIssues) {
            metrics.tables_with_issues.push(cleanTableName);
          }
        } catch (error) {
          // Rollback on error
          await client.query('ROLLBACK');
          replicationLogger.error(`Error checking table ${tableName}:`, error);
          metrics.errors++;
          metrics.tables_with_issues.push(tableName.replace(/"/g, ''));
        }
      }
      
      // Update health check state
      await client.query(`
        INSERT INTO health_check_state (
          last_run_timestamp, status, metrics
        ) VALUES (
          CURRENT_TIMESTAMP,
          $1,
          $2
        )
      `, [
        metrics.errors > 0 ? 'completed_with_errors' : 'completed',
        JSON.stringify(metrics)
      ]);
      
      metrics.duration_ms = Date.now() - startTime;
      
      replicationLogger.info('Initial cleanup completed', { 
        duration_ms: metrics.duration_ms,
        tables_checked: metrics.tables_checked,
        records_scanned: metrics.records_scanned,
        early_records_found: metrics.early_records_found,
        synthetic_changes_created: metrics.synthetic_changes_created,
        errors: metrics.errors,
        tables_with_issues: metrics.tables_with_issues
      });
      
      return {
        success: true,
        timestamp: new Date().toISOString(),
        metrics
      };
    } catch (error) {
      metrics.duration_ms = Date.now() - startTime;
      
      replicationLogger.error('Initial cleanup failed:', error);
      
      return {
        success: false,
        timestamp: new Date().toISOString(),
        metrics,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  } finally {
    await client.end();
  }
}

/**
 * Verify changes by comparing current table counts with deduplicated change history
 * 
 * This function:
 * 1. Gets current counts and IDs for each domain table
 * 2. Gets all changes from change_history for each table
 * 3. Deduplicates changes to get the final state
 * 4. Compares the current records with the expected state based on deduplicated changes
 * 5. Tracks specific record IDs that are missing or extra
 * 
 * @param client Database client
 * @returns Verification result
 */
export async function verifyChanges(c: Context<{ Bindings: Env }> | MinimalContext): Promise<VerificationResult> {
  replicationLogger.info('Starting changes verification');
  
  try {
    const results: VerificationMetrics[] = [];
    
    // Get current counts for each domain table
    for (const table of SERVER_DOMAIN_TABLES) {
      // Remove quotes from table name for SQL query
      const cleanTable = table.replace(/"/g, '');
      
      // Get all current record IDs
      const currentRecordsResult = await getDBClient(c).query(
        `SELECT id FROM ${table} ORDER BY id`
      );
      const currentIds = currentRecordsResult.rows.map(row => String(row.id));
      const currentCount = currentIds.length;

      // Get all changes from change_history for this table
      const changeHistoryResult = await getDBClient(c).query(
        `SELECT 
          lsn,
          table_name,
          operation,
          data,
          updated_at
         FROM change_history 
         WHERE table_name = $1
         ORDER BY lsn::pg_lsn ASC`,
        [cleanTable]
      );

      // Transform to Change[] format
      const changes = changeHistoryResult.rows.map(row => ({
        table: row.table_name,
        operation: row.operation,
        data: row.data,
        lsn: row.lsn,
        updated_at: row.updated_at.toISOString()
      }));

      // Track operations by ID before deduplication
      const changeHistoryById: Record<string, {
        final_operation: 'insert' | 'update' | 'delete';
        operations_count: {
          inserts: number;
          updates: number;
          deletes: number;
        };
      }> = {};

      // Process all changes to build operation history
      for (const change of changes) {
        const id = change.operation === 'delete' 
          ? String(change.data?.id)  // For deletes, use the ID from data since we don't store old_data anymore
          : String(change.data?.id);

        if (!id) continue;

        if (!changeHistoryById[id]) {
          changeHistoryById[id] = {
            final_operation: change.operation,
            operations_count: {
              inserts: 0,
              updates: 0,
              deletes: 0
            }
          };
        }

        // Update operation counts
        changeHistoryById[id].operations_count[`${change.operation}s` as 'inserts' | 'updates' | 'deletes']++;
        // Update final operation
        changeHistoryById[id].final_operation = change.operation;
      }

      // Deduplicate changes to get the final state
      const dedupedChanges = deduplicateChanges(changes);

      // Count operations in deduplicated changes
      const changeHistory = {
        inserts: dedupedChanges.filter(c => c.operation === 'insert').length,
        updates: dedupedChanges.filter(c => c.operation === 'update').length,
        deletes: dedupedChanges.filter(c => c.operation === 'delete').length
      };

      // Calculate expected count based on deduplicated changes
      const expectedCount = changeHistory.inserts + changeHistory.updates - changeHistory.deletes;

      // Get all IDs from deduplicated changes that should exist
      const expectedIds = new Set<string>();
      for (const change of dedupedChanges) {
        if (change.operation !== 'delete') {
          const id = String(change.data?.id);
          if (id) expectedIds.add(id);
        }
      }

      // Find missing and extra IDs
      const missingIds = Array.from(expectedIds).filter(id => !currentIds.includes(id));
      const extraIds = currentIds.filter(id => !expectedIds.has(id));

      // Add detailed verification metrics
      results.push({
        table: cleanTable,
        current_count: currentCount,
        expected_count: expectedCount,
        matches: currentCount === expectedCount,
        change_history: changeHistory,
        details: {
          current_ids: currentIds,
          missing_ids: missingIds,
          extra_ids: extraIds,
          change_history_by_id: changeHistoryById
        }
      });

      // Log detailed results
      replicationLogger.info(`Verification results for ${cleanTable}:`, {
        current_count: currentCount,
        expected_count: expectedCount,
        matches: currentCount === expectedCount,
        missing_count: missingIds.length,
        extra_count: extraIds.length,
        change_history: changeHistory
      });

      if (missingIds.length > 0) {
        replicationLogger.info(`Missing records in ${cleanTable}:`, {
          ids: missingIds,
          details: missingIds.map(id => changeHistoryById[id])
        });
      }

      if (extraIds.length > 0) {
        replicationLogger.info(`Extra records in ${cleanTable}:`, {
          ids: extraIds
        });
      }
    }

    return {
      success: true,
      timestamp: new Date().toISOString(),
      verification: results
    };
  } catch (error) {
    replicationLogger.error('Changes verification failed:', error);
    return {
      success: false,
      timestamp: new Date().toISOString(),
      verification: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Router for health check related endpoints
 */
export class HealthCheckRouter {
  constructor(private readonly app: Hono<{ Bindings: Env }>) {
    this.setupRoutes();
  }

  private setupRoutes() {
    this.app.get('/api/health-check', this.handleHealthCheck.bind(this));
    this.app.post('/api/health-check/cleanup', this.handleInitialCleanup.bind(this));
    this.app.post('/api/health-check/verify', this.handleVerifyChanges.bind(this));
  }

  private async handleHealthCheck(c: Context<{ Bindings: Env }>): Promise<Response> {
    try {
      const result = await performHealthCheck(c);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  }

  private async handleInitialCleanup(c: Context<{ Bindings: Env }>): Promise<Response> {
    try {
      const result = await performInitialCleanup(c);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  }

  private async handleVerifyChanges(c: Context<{ Bindings: Env }>): Promise<Response> {
    try {
      const result = await verifyChanges(c);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  }
} 
