/**
 * Core change type for replication
 * Represents a change to a table that needs to be replicated
 */
export interface TableChange {
  table: string;
  operation: 'insert' | 'update' | 'delete';
  data: Record<string, unknown>;
  lsn: string;
  updated_at: string;  // ISO timestamp of when the record was updated
}

// Type guards for message handling
export function isTableChange(payload: unknown): payload is TableChange {
  const p = payload as TableChange;
  return p 
    && typeof p.table === 'string'
    && ['insert', 'update', 'delete'].includes(p.operation)
    && typeof p.data === 'object'
    && p.data !== null
    && typeof p.lsn === 'string'
    && typeof p.updated_at === 'string';
} 