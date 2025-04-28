import type { TableChange } from '@repo/sync-types';
import { SERVER_TABLE_HIERARCHY } from '@repo/dataforge/server-entities';
import { getDBClient, sql } from './db'; // Import necessary DB helpers
import type { MinimalContext } from '../types/hono'; // Import context type
import { syncLogger } from '../middleware/logger'; // Import logger
import type { QueryResult } from '@neondatabase/serverless'; // Import QueryResult type

const MODULE_NAME = 'sync-common';

/**
 * Compare two LSNs
 * @returns -1 if lsn1 < lsn2, 0 if equal, 1 if lsn1 > lsn2
 */
export function compareLSN(lsn1: string, lsn2: string): number {
  if (lsn1 === lsn2) return 0;
  
  // Parse the LSNs into parts
  const [major1Str, minor1Str] = lsn1.split('/');
  const [major2Str, minor2Str] = lsn2.split('/');
  
  // Convert to numbers correctly (both parts are hex)
  const major1 = parseInt(major1Str, 16); // Fix: Use base 16 for major
  const minor1 = parseInt(minor1Str, 16); // Hex value
  const major2 = parseInt(major2Str, 16); // Fix: Use base 16 for major
  const minor2 = parseInt(minor2Str, 16); // Hex value
  
  // Compare parts
  if (major1 < major2) return -1;
  if (major1 > major2) return 1;
  if (minor1 < minor2) return -1;
  if (minor1 > minor2) return 1;
  return 0;
}

/**
 * Helper to determine if an update operation changes unique fields
 * compared to existing updates
 */
function hasUniqueFieldChanges(update: TableChange, existingUpdates: TableChange[]): {
  hasChanges: boolean;
  fields: string[];
} {
  // Extract the fields being changed in this update (excluding metadata fields)
  const changedFields = Object.keys(update.data).filter(k => 
    k !== 'id' && k !== 'updated_at' && k !== 'client_id'
  );
  
  const uniqueFields: string[] = [];
  
  // Check if any field in this update hasn't been changed in previous updates
  for (const field of changedFields) {
    const fieldAlreadyChanged = existingUpdates.some(existing => 
      Object.keys(existing.data).includes(field)
    );
    
    if (!fieldAlreadyChanged) {
      uniqueFields.push(field);
    }
  }
  
  return {
    hasChanges: uniqueFields.length > 0,
    fields: uniqueFields
  };
}

/**
 * Parse timestamp string to number for comparison
 */
function parseTimestamp(ts: string): number {
  return new Date(ts).getTime();
}

/**
 * Deduplicate changes while preserving important update operations
 * @param changes Array of changes to deduplicate
 * @param clientId Optional client ID to filter out own changes
 * @returns Object containing deduplicated changes and info about skipped changes
 */
export function deduplicateChanges(changes: TableChange[], clientId?: string): {
  changes: TableChange[];
  skipped: {
    missingId: TableChange[];
    outdated: TableChange[];
  };
  transformations: {
    count: number;
    details: Array<{
      from: string;
      to: string;
      entityId: string;
      table: string;
      reason: string;
      timestamp?: string;
      lsn?: string;
      originalTs?: string;
      newTs?: string;
    }>;
  };
  changesByEntity: Record<string, string[]>;
} {
  const result: TableChange[] = [];
  const skipped = {
    missingId: [] as TableChange[],
    outdated: [] as TableChange[],
  };
  const transformations = {
    count: 0,
    details: [] as Array<{
      from: string;
      to: string;
      entityId: string;
      table: string;
      reason: string;
      timestamp?: string;
      lsn?: string;
      originalTs?: string;
      newTs?: string;
    }>,
  };
  const changesByEntity: Record<string, string[]> = {};

  // Group changes by entity
  const changesByEntityId = new Map<string, TableChange[]>();
  for (const change of changes) {
    const entityId = change.data?.id as string | undefined;
    if (!entityId) {
      skipped.missingId.push(change);
      continue;
    }

    const entityChanges = changesByEntityId.get(entityId) || [];
    entityChanges.push(change);
    changesByEntityId.set(entityId, entityChanges);
  }

  // Process each entity's changes
  for (const [entityId, entityChanges] of changesByEntityId.entries()) {
    // Sort changes by timestamp (newest first)
    entityChanges.sort((a, b) => {
      const aTs = parseTimestamp((a.data?.updated_at || a.data?.created_at || '') as string);
      const bTs = parseTimestamp((b.data?.updated_at || b.data?.created_at || '') as string);
      return bTs - aTs;
    });

    // Track changes for this entity
    changesByEntity[entityId] = entityChanges.map(c => (c.data?.id || '') as string);

    // First check if there's a delete operation
    const hasDelete = entityChanges.some(change => change.operation === 'delete');
    const deleteTimestamp = hasDelete 
      ? entityChanges.find(change => change.operation === 'delete')?.data?.updated_at 
      : null;

    let latestChange: TableChange;
    let latestTimestamp: number;

    // If there's a delete, only keep it and ignore all other operations
    if (hasDelete && deleteTimestamp) {
      latestChange = entityChanges.find(change => 
        change.operation === 'delete' && 
        change.data?.updated_at === deleteTimestamp
      )!;
      
      // Add all other changes to skipped
      entityChanges.forEach(change => {
        if (change.operation !== 'delete' || change.data?.updated_at !== deleteTimestamp) {
          skipped.outdated.push(change);
        }
      });
    } else {
      // Original merging logic for non-delete cases
      latestChange = entityChanges[0];
      latestTimestamp = parseTimestamp((latestChange.data?.updated_at || latestChange.data?.created_at || '') as string);

      for (let i = 1; i < entityChanges.length; i++) {
        const currentChange = entityChanges[i];
        const currentTimestamp = parseTimestamp((currentChange.data?.updated_at || currentChange.data?.created_at || '') as string);

        // Skip outdated changes
        if (currentTimestamp < latestTimestamp) {
          skipped.outdated.push(currentChange);
          continue;
        }

        // Handle insert + update merge
        if (latestChange.operation === 'insert' && currentChange.operation === 'update') {
          latestChange = {
            ...latestChange,
            data: {
              ...latestChange.data,
              ...currentChange.data,
            },
          };
          transformations.count++;
          transformations.details.push({
            from: 'update',
            to: 'insert',
            entityId,
            table: latestChange.table,
            reason: 'merged_update_into_insert',
            timestamp: currentChange.data?.updated_at as string | undefined,
            originalTs: currentChange.data?.updated_at as string | undefined,
            newTs: latestChange.data?.updated_at as string | undefined,
          });
        }
        // Handle update + update merge
        else if (latestChange.operation === 'update' && currentChange.operation === 'update') {
          latestChange = {
            ...latestChange,
            data: {
              ...currentChange.data,
              ...latestChange.data,
            },
          };
          transformations.count++;
          transformations.details.push({
            from: 'update',
            to: 'update',
            entityId,
            table: latestChange.table,
            reason: 'merged_update',
            timestamp: currentChange.data?.updated_at as string | undefined,
            originalTs: currentChange.data?.updated_at as string | undefined,
            newTs: latestChange.data?.updated_at as string | undefined,
          });
        }
        // For any other combination, keep the latest change
        else {
          latestChange = currentChange;
          latestTimestamp = currentTimestamp;
        }
      }
    }

    // Add the final change to results
    result.push(latestChange);
  }

  // Apply client ID filtering - filters out changes from the same client
  const filteredChanges = clientId
    ? result.filter(change => change.data?.client_id !== clientId)
    : result;

  return {
    changes: filteredChanges,
    skipped,
    transformations,
    changesByEntity,
  };
}

type TableName = keyof typeof SERVER_TABLE_HIERARCHY;

/**
 * Order changes based on table hierarchy and operation type
 * - Creates/Updates: Process parents before children
 * - Deletes: Process children before parents
 */
export function orderChangesByDomain(changes: TableChange[]): TableChange[] {
  // Log tables before sorting
  const beforeTablesCount = changes.reduce((acc, change) => {
    if (change.table) acc.push(change.table);
    return acc;
  }, [] as string[]).length;
  
  // Create a new copy to sort to avoid modifying the original array
  const ordered = [...changes].sort((a, b) => {
    // Add quotes to match SERVER_TABLE_HIERARCHY keys
    const aLevel = SERVER_TABLE_HIERARCHY[`"${a.table}"` as TableName] ?? 0;
    const bLevel = SERVER_TABLE_HIERARCHY[`"${b.table}"` as TableName] ?? 0;

    // For deletes, reverse the hierarchy
    if (a.operation === 'delete' && b.operation === 'delete') {
      return bLevel - aLevel;
    }

    // For mixed operations, deletes come last
    if (a.operation === 'delete') return 1;
    if (b.operation === 'delete') return -1;

    // For creates/updates, follow hierarchy
    return aLevel - bLevel;
  });

  // Log tables after sorting
  const afterTablesCount = ordered.reduce((acc, change) => {
    if (change.table) acc.push(change.table);
    return acc;
  }, [] as string[]).length;
  
  // Log if there's a difference
  if (beforeTablesCount !== afterTablesCount) {
    console.error(`TABLE PROPERTY LOST during sort: before=${beforeTablesCount}, after=${afterTablesCount}`);
    
    // Examine properties
    if (changes.length > 0 && ordered.length > 0) {
      console.log('First change before:', Object.keys(changes[0]));
      console.log('First change after:', Object.keys(ordered[0]));
    }
  }

  return ordered;
}

/**
 * Get the latest LSN recorded in the change_history table.
 * Returns '0/0' if the table is empty or an error occurs.
 */
export async function getLatestChangeHistoryLSN(context: MinimalContext): Promise<string> {
  try {
    // Use the sql helper function from db.ts to handle connection and query
    const result = await sql<{ latest_lsn: string | null }>(context,
      'SELECT MAX(lsn::pg_lsn)::text as latest_lsn FROM change_history;'
    );
    
    const latestLSN = result[0]?.latest_lsn;
    
    if (latestLSN) {
      return latestLSN;
    }
    // No need for manual connection closing here, sql() handles it
    return '0/0'; // Return default on error
  } catch (error) {
    console.error('Error getting latest change history LSN:', error);
    return '0/0'; // Return default on error
  }
} 