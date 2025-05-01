import type { Config } from './types.ts';

export const DEFAULT_CONFIG: Config = {
  wsUrl: 'wss://127.0.0.1:8787/api/sync',
  baseUrl: 'https://127.0.0.1:8787',
  connectTimeout: 10000,
  syncWaitTime: 1000,
  changeWaitTime: 2000,
  chunkTimeout: 30000
}; 