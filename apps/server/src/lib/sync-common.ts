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
  
  // Convert to numbers
  const major1 = parseInt(major1Str, 10);
  const minor1 = parseInt(minor1Str, 16); // Hex value
  const major2 = parseInt(major2Str, 10);
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
 */
export function deduplicateChanges(changes: TableChange[]): TableChange[] {
  const latestChanges = new Map<string, TableChange>();

  for (const change of changes) {
    // Skip if no id in the change data
    if (!change.data?.id) {
      continue;
    }

    const key = `${change.table}:${change.data.id}`;
    const existing = latestChanges.get(key);
    
    // Keep change if no existing one, or if this one is newer
    if (!existing || new Date(change.updated_at) >= new Date(existing.updated_at)) {
      latestChanges.set(key, change);
    }
  }

  // Convert back to array and sort by LSN for consistency
  return Array.from(latestChanges.values())
    .sort((a, b) => compareLSN(a.lsn!, b.lsn!));
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