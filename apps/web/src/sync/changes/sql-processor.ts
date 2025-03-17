/**
 * SQL Processor
 * 
 * This module provides functions for directly applying server changes to the database
 * using SQL without going through entity-specific API modules.
 * 
 * Changes come pre-grouped by table from the server and are trusted.
 */

import { ServerChange } from '../message-types';
import { getDatabase } from '../../db/core';
import { syncLogger } from '../../utils/logger';

/**
 * Apply a batch of server changes directly using SQL
 * @param changes Array of changes to apply
 */
export async function applyServerChanges(changes: ServerChange[]): Promise<void> {
  if (!changes.length) return;
  
  const db = await getDatabase();
  let transactionStarted = false;
  
  try {
    await db.query('BEGIN');
    transactionStarted = true;
    
    // Process each change in the batch
    for (const change of changes) {
      const { table, operation, data, old_data } = change;
      const id = data?.id || old_data?.id;
      
      // Log raw data for debugging
      syncLogger.info(`Raw change data for ${table}:${id}: ${JSON.stringify({
        operation,
        data,
        old_data
      }, null, 2)}`);
      
      syncLogger.info(`Processing change: ${operation} ${table}:${id}`);
      
      try {
        // Check for skip conditions
        let skipReason = null;
        if ((operation === 'insert' || operation === 'update') && !data) {
          skipReason = `Skipping ${operation} - no data provided`;
          syncLogger.info(skipReason);
          continue;
        } else if (operation === 'insert') {
          // Check if record exists for inserts only
          const exists = await db.query(
            `SELECT 1 FROM "${table}" WHERE id = $1`,
            [id]
          );
          
          if (exists.rows.length > 0) {
            skipReason = 'Skipping insert - record already exists';
            syncLogger.info(skipReason);
            continue;
          }
        }

        switch (operation.toLowerCase()) {
          case 'insert': {
            const columns = Object.keys(data);
            const values = Object.values(data);
            const placeholders = columns.map((_, i) => `$${i + 1}`);
            
            await db.query(
              `INSERT INTO "${table}" ("${columns.join('", "')}") 
               VALUES (${placeholders.join(', ')})`,
              values
            );
            break;
          }
          
          case 'update': {
            // Check if record exists
            const exists = await db.query(
              `SELECT 1 FROM "${table}" WHERE id = $1`,
              [id]
            );
            
            if (exists.rows.length) {
              // Record exists - update
              const columns = Object.keys(data);
              const values = Object.values(data);
              const setClauses = columns.map((key, i) => `"${key}" = $${i + 2}`);
              
              await db.query(
                `UPDATE "${table}" 
                 SET ${setClauses.join(', ')}
                 WHERE id = $1`,
                [id, ...values]
              );
            } else {
              // Record doesn't exist - insert
              const columns = Object.keys(data);
              const values = Object.values(data);
              const placeholders = columns.map((_, i) => `$${i + 1}`);
              
              await db.query(
                `INSERT INTO "${table}" ("${columns.join('", "')}") 
                 VALUES (${placeholders.join(', ')})`,
                values
              );
            }
            break;
          }
          
          case 'delete': {
            await db.query(
              `DELETE FROM "${table}" WHERE id = $1`,
              [id]
            );
            break;
          }
        }
      } catch (error) {
        syncLogger.error(
          `Error processing change: ${operation} ${table}:${id}`,
          error
        );
        throw error;
      }
    }
    
    await db.query('COMMIT');
    transactionStarted = false;
    
  } catch (error) {
    syncLogger.error('Error applying server changes', error);
    
    if (transactionStarted) {
      await db.query('ROLLBACK');
    }
    
    throw error;
  }
} 