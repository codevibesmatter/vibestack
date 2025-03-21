import type { Config } from './types.js';

export const DEFAULT_CONFIG: Config = {
  wsUrl: 'ws://localhost:8787/api/sync',
  connectTimeout: 10000,
  syncWaitTime: 1000,
  changeWaitTime: 2000,
  chunkTimeout: 30000
}; 