/// <reference path="../worker-configuration.d.ts" />

// Set up node polyfills first
import 'reflect-metadata';

// Import and re-export Durable Objects
import { SyncDO } from './sync/SyncDO';
import { ReplicationDO } from './replication/ReplicationDO';

// Import the default export from index
import worker from './index';

// Re-export everything from index.ts
export * from './index';

// Explicitly export Durable Objects
export { SyncDO, ReplicationDO };

// Default export with fetch handler
export default worker; 