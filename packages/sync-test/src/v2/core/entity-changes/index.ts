/**
 * Entity Changes - Main API
 * 
 * This module exports all the functionality from the entity-changes system.
 * It provides a cleaner, more maintainable approach to generating test data
 * for synchronization and database testing.
 */

// Types and entity definitions
export * from './entity-definitions.ts';

// Database utilities
export { 
  initialize,
  getDataSource,
  fetchExistingEntityIds,
  applyBatchChanges
} from './db-utils.ts';

// Entity generators
export {
  generateEntity,
  generateEntities
} from './generators.ts';

// Change operations
export {
  generateChanges,
  convertToTableChanges,
  generateAndApplyChanges,
  applyChangesInBatches,
  seedDatabase,
  createChangeTracker,
  generateAndTrackChanges,
  generateTrackAndValidateChanges
} from './change-operations.ts';

// Change tracking
export { 
  ChangeTracker
} from './change-tracker.ts';

// Validation utilities
export {
  verifyWALChanges,
  queryChangeHistory,
  initializeReplication,
  getCurrentLSN,
  queryWALDirectly,
  getReplicationSlotInfo,
  listReplicationSlots,
  validateEntityChanges
} from './validation.ts'; 

// Export the batch change generation function
export { 
  generateMixedChanges,
  generateAndApplyMixedChanges
} from './batch-changes.ts';