import type { TableChange } from '@repo/sync-types';
import { SERVER_TABLE_HIERARCHY } from '@repo/dataforge/server-entities';

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
 * Deduplicate changes by keeping only the latest change for each record
 * Uses last-write-wins based on updated_at timestamp
 * Also optimizes insert+update sequences into a single insert with latest data
 */
export function deduplicateChanges(changes: TableChange[]): TableChange[] {
  // Process into a map with the latest change for each record id
  const latestChanges = new Map<string, TableChange>();
  
  // Also track which tables+ids have inserts (for optimization)
  const insertMap = new Map<string, TableChange>();

  // First pass - find the latest change for each record
  for (const change of changes) {
    // Skip if no id in the change data
    if (!change.data?.id) {
      continue;
    }

    const key = `${change.table}:${change.data.id}`;
    const existing = latestChanges.get(key);
    
    // Keep track of inserts for later optimization
    if (change.operation === 'insert') {
      insertMap.set(key, change);
    }
    
    // Keep change if no existing one, or if this one is newer
    if (!existing || new Date(change.updated_at) >= new Date(existing.updated_at)) {
      latestChanges.set(key, change);
    }
  }
  
  // Second pass - optimize insert+update patterns
  const result: TableChange[] = [];
  
  for (const [key, change] of latestChanges.entries()) {
    // If this is an update and we previously saw an insert for this record
    if (change.operation === 'update' && insertMap.has(key)) {
      const insert = insertMap.get(key)!;
      
      // Skip if the insert is already the latest change (no optimization needed)
      if (insert === change) {
        result.push(change);
        continue;
      }
      
      // Create an optimized change that merges the insert and update
      const optimizedChange: TableChange = {
        table: change.table,
        operation: 'insert', // Keep as insert but will use ON CONFLICT in DB
        data: {
          ...insert.data, // Base data from insert
          ...change.data, // Overridden by update data
          id: change.data.id,
          client_id: change.data.client_id
        },
        updated_at: change.updated_at,
        lsn: change.lsn // Keep the latest LSN
      };
      
      result.push(optimizedChange);
    } else {
      // For all other cases, use the deduplicated change as is
      result.push(change);
    }
  }

  // Sort changes by LSN for consistency
  return orderChangesByDomain(result.sort((a, b) => compareLSN(a.lsn!, b.lsn!)));
}

type TableName = keyof typeof SERVER_TABLE_HIERARCHY;

/**
 * Order changes based on table hierarchy and operation type
 * - Creates/Updates: Process parents before children
 * - Deletes: Process children before parents
 */
export function orderChangesByDomain(changes: TableChange[]): TableChange[] {
  const ordered = changes.sort((a, b) => {
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

  return ordered;
} 