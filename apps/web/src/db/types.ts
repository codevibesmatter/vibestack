import type { PGlite } from '@electric-sql/pglite'
import type { PGliteWorker } from '@electric-sql/pglite/worker'
import type { LiveNamespace } from '@electric-sql/pglite/live'

// PGlite type with live namespace
export interface PGliteWithLive extends PGlite {
  live: LiveNamespace
}

// PGliteWorker type with live namespace
export interface PGliteWorkerWithLive extends PGliteWorker {
  live: LiveNamespace
}

// Combined type for PGlite with live namespace
export type AnyPGliteWithLive = PGliteWithLive | PGliteWorkerWithLive;

// Database error type
export interface DatabaseError extends Error {
  code?: string
  detail?: string
  hint?: string
}

// Query state types
export interface QueryState<T> {
  data: T[]
  loading: boolean
  error: DatabaseError | null
}

// Type assertion helper
export function assertPGliteWithLive(db: any): asserts db is AnyPGliteWithLive {
  if (!db || !db.live || typeof db.live.query !== 'function') {
    throw new Error('Invalid PGlite instance: missing live namespace')
  }
}

// Ensure db is not null in our queries
export function ensureDB<T extends PGlite | PGliteWorker>(db: T | null): T {
  if (!db) throw new Error('Database not initialized')
  return db
}