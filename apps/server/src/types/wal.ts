import type { QueryResultRow } from '@neondatabase/serverless';

export interface WALData {
  lsn: string;
  data: string;
  xid?: string;
}

export interface PostgresWALMessage {
  change?: Array<{
    schema: string;
    table: string;
    kind: 'insert' | 'update' | 'delete';
    columnnames: string[];
    columnvalues: unknown[];
  }>;
  lsn: string;
  xid?: number;
}

export interface WALChange extends QueryResultRow {
  lsn: string;
  table_name: string;
  operation: 'insert' | 'update' | 'delete';
  new_data: Record<string, unknown>;
  timestamp?: Date;
  xid?: string;
}

export interface ChunkOptions {
  chunkSize?: number;
  cursor?: string | null;
}

export interface ChunkResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
} 