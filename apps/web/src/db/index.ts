/**
 * Database module index file
 * 
 * This file re-exports everything from the database module
 * to provide a clean public API.
 */

// Re-export from core
export {
  db,
  initializeDatabase,
  getDatabase,
  clearDatabaseStorage,
  terminateDatabase,
  assertDatabaseWithLive,
  getDatabaseStatus,
  validateDatabaseSchema
} from './core';

// Re-export from storage
export {
  resetDatabase,
  resetDB,
  getDatabaseStats,
  loadServerData,
  clearAllData,
  dropAllTables
} from './storage';

// Re-export from types
export type {
  PGliteWithLive,
  PGliteWorkerWithLive,
  AnyPGliteWithLive,
  DatabaseError,
  QueryState
} from './types';

export {
  assertPGliteWithLive,
  ensureDB
} from './types';

// Export the minimal PGlite provider component
export { MinimalPGliteProvider } from './pglite-provider';

// Export message bus
export { dbMessageBus } from './message-bus';
export type { DbEventType, DbCommandType } from './message-bus';

// Export migration manager
export {
  checkAndApplyMigrations,
  fetchMigrationsFromServer,
  applyMigrations,
  checkMigrationTableExists,
  getLatestAppliedMigration
} from './migration-manager';
export type { Migration } from './migration-manager';