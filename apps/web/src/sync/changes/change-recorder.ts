/**
 * Change Recorder
 * 
 * This module handles recording server changes to the local_changes table
 * for history tracking and error handling.
 */

import { ServerChange } from '../message-types';
import { ServerChangeRecord } from './types';
import { getDatabase } from '../../db/core';
import { syncLogger } from '../../utils/logger';

/**
 * Record a server change to the local_changes table
 */
export async function recordServerChange(change: ServerChange): Promise<ServerChangeRecord> {
  const { table, operation, data, old_data } = change;
  const id = data?.id || old_data?.id;
  
  syncLogger.info(`Recording server change: ${operation} ${table}:${id}`);
  
  const db = await getDatabase();
  
  try {
    // Insert the change record
    const result = await db.query<ServerChangeRecord>(
      `INSERT INTO local_changes (
        entity_type, entity_id, operation, data, old_data,
        timestamp, processed_local, processed_sync, from_server
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        table,
        String(id),
        operation,
        data ? JSON.stringify(data) : null,
        old_data ? JSON.stringify(old_data) : null,
        Date.now(),
        false, // Will be set to true after processing
        false,
        true
      ]
    );
    
    return result.rows[0];
  } catch (error) {
    syncLogger.error(`Failed to record server change: ${operation} ${table}:${id}`, error);
    throw error;
  }
}

/**
 * Update a change record's status after processing
 */
export async function updateChangeStatus(
  changeId: string,
  success: boolean,
  error?: string
): Promise<void> {
  const db = await getDatabase();
  
  try {
    await db.query(
      `UPDATE local_changes
       SET processed_local = $2,
           error = $3,
           attempts = CASE WHEN $2 = false THEN COALESCE(attempts, 0) + 1 ELSE attempts END
       WHERE id = $1`,
      [changeId, success, error || null]
    );
  } catch (updateError) {
    syncLogger.error(`Failed to update change status for ${changeId}`, updateError);
    throw updateError;
  }
}

/**
 * Get failed server changes for retry
 */
export async function getFailedServerChanges(maxAttempts = 3): Promise<ServerChangeRecord[]> {
  const db = await getDatabase();
  
  try {
    const result = await db.query<ServerChangeRecord>(
      `SELECT * FROM local_changes
       WHERE from_server = true
         AND processed_local = false
         AND (attempts IS NULL OR attempts < $1)
       ORDER BY timestamp ASC`,
      [maxAttempts]
    );
    
    return result.rows;
  } catch (error) {
    syncLogger.error('Failed to get failed server changes', error);
    throw error;
  }
} 