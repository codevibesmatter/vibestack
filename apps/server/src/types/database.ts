/**
 * Types representing database table schemas and related types
 */

/**
 * Represents a row in the change_history table
 */
export interface ChangeHistoryRow {
  /** Unique identifier for the change record */
  id: string;
  /** Log Sequence Number for this change */
  lsn: string;
  /** Name of the table that was changed */
  table_name: string;
  /** Type of operation performed */
  operation: 'insert' | 'update' | 'delete';
  /** Current data for the record */
  data: Record<string, unknown>;
  /** Timestamp of when the record was updated */
  updated_at: Date;
  /** Optional client that originated the change */
  client_id?: string | null;
} 