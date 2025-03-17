export { ReplicationDO } from './ReplicationDO';
export { 
  getSlotStatus, 
  advanceReplicationSlot, 
  DEFAULT_REPLICATION_CONFIG,
  peekSlotHistory
} from './slot';
export { 
  processWALChanges,
  transformWALToTableChange,
  type WALData
} from './changes';
export { ClientManager } from './client-manager';
export { StateManager } from './state-manager';
export { PollingManager } from './polling';
export { 
  performHealthCheck,
  performInitialCleanup,
  verifyChanges
} from './health-check';
export type { 
  ReplicationConfig,
  ReplicationState,
  ReplicationMetrics,
  ReplicationLagStatus,
  SlotStatus,
  DomainTable,
  HealthCheckMetrics,
  HealthCheckResult,
  InitialCleanupMetrics,
  InitialCleanupResult,
  VerificationMetrics,
  VerificationResult
} from './types'; 