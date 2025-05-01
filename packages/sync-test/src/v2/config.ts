import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import type { Config } from './types.ts';

/**
 * Global configuration for the sync test suite
 */

/**
 * Database table configuration
 */
export const DB_TABLES = {
  // Use plural form as per database schema
  USERS: 'users',
  PROJECTS: 'projects',
  TASKS: 'tasks',
  COMMENTS: 'comments'
};

/**
 * Domain tables aligned with server definitions
 */
export const SERVER_DOMAIN_TABLES = [
  'comments',
  'projects',
  'tasks',
  'users',
] as const;

// Lookup map for normalized table names (without quotes)
export const SERVER_DOMAIN_TABLE_MAP = {
  'comments': 'comment',
  'projects': 'project',
  'tasks': 'task',
  'users': 'user'
};

/**
 * WebSocket configuration
 */
export const WS_CONFIG = {
  // Default WebSocket URL
  URL: process.env.WS_URL || 'wss://127.0.0.1:8787/api/sync',
  
  // WebSocket connection parameters
  PARAMS: {
    // Required parameters for WebSocket connection
    clientId: true,
    lsn: true, // 0/0 for initial sync, required for catchup
  },
  
  // Connection timeout in milliseconds
  CONNECT_TIMEOUT: 10000,
  
  // Heartbeat interval in milliseconds
  HEARTBEAT_INTERVAL: 10000
};

/**
 * HTTP API configuration
 */
export const API_CONFIG = {
  // Base API URL - hardcoded for simplicity
  BASE_URL: 'https://127.0.0.1:8787',
  
  // Replication initialization endpoint
  REPLICATION_INIT: '/api/replication/init',
  
  // Get current LSN endpoint
  GET_LSN: '/api/replication/lsn',
  
  // HTTP request timeout in milliseconds
  REQUEST_TIMEOUT: 5000
};

/**
 * Default configuration for the sync test suite
 */
export const DEFAULT_CONFIG: Config = {
  // WebSocket URL
  wsUrl: WS_CONFIG.URL,
  
  // API base URL (derived from WebSocket URL)
  baseUrl: WS_CONFIG.URL.replace('ws:', 'http:').replace('/api/sync', ''),
  
  // Connection timeout in milliseconds
  connectTimeout: WS_CONFIG.CONNECT_TIMEOUT,
  
  // Wait time for sync completion in milliseconds
  syncWaitTime: 30000,
  
  // Wait time for changes to appear in milliseconds
  changeWaitTime: 2000,
  
  // Timeout for chunk receipt in milliseconds
  chunkTimeout: 30000
};

/**
 * Test configuration defaults
 */
export const TEST_DEFAULTS = {
  // Default timeout for tests (30 seconds)
  TIMEOUT: 30000,
  
  // Default timeout for long-running tests (2 minutes)
  LONG_TIMEOUT: 120000,
  
  // Default batch size for batch mode
  BATCH_SIZE: 5,
  
  // Default entity types to use for tests
  ENTITY_TYPES: Object.values(SERVER_DOMAIN_TABLE_MAP),
  
  // Default operations to use for tests
  OPERATIONS: ['create', 'update', 'delete'],
  
  // Default entity distribution for batch mode
  ENTITY_DISTRIBUTION: {
    user: 0.2,
    project: 0.2,
    task: 0.5,
    comment: 0.1
  }
};

/**
 * LSN state management
 */
export const LSN_STATE = {
  // LSN state file path
  FILE_PATH: path.join(process.cwd(), '.sync-test-lsn.json'),
  
};

/**
 * Utility functions
 */
export const UTILS = {
  /**
   * Generate a UUID v4 for client ID
   */
  generateClientId: (): string => {
    return uuidv4();
  },
  
  /**
   * Generate a unique message ID
   */
  generateMessageId: (prefix: string = 'msg'): string => {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  },
  
  /**
   * Compare two LSNs
   * Returns:
   * -1 if lsn1 < lsn2
   *  0 if lsn1 = lsn2
   *  1 if lsn1 > lsn2
   */
  compareLSN: (lsn1: string, lsn2: string): number => {
    if (lsn1 === lsn2) return 0;
    
    // Parse the LSNs into parts
    const [major1Str, minor1Str] = lsn1.split('/');
    const [major2Str, minor2Str] = lsn2.split('/');
    
    // Convert to numbers (both parts should be hex)
    const major1 = parseInt(major1Str || '0', 16); 
    const minor1 = parseInt(minor1Str || '0', 16);
    const major2 = parseInt(major2Str || '0', 16);
    const minor2 = parseInt(minor2Str || '0', 16);
    
    // Compare parts
    if (major1 < major2) return -1;
    if (major1 > major2) return 1;
    if (minor1 < minor2) return -1;
    if (minor1 > minor2) return 1;
    return 0;
  }
};

/**
 * Get configuration from environment variables, falling back to defaults
 */
export function getConfig(): Config {
  return {
    wsUrl: process.env.WS_URL || DEFAULT_CONFIG.wsUrl,
    baseUrl: process.env.API_URL || DEFAULT_CONFIG.baseUrl,
    connectTimeout: parseInt(process.env.CONNECT_TIMEOUT || '') || DEFAULT_CONFIG.connectTimeout,
    syncWaitTime: parseInt(process.env.SYNC_WAIT_TIME || '') || DEFAULT_CONFIG.syncWaitTime,
    changeWaitTime: parseInt(process.env.CHANGE_WAIT_TIME || '') || DEFAULT_CONFIG.changeWaitTime,
    chunkTimeout: parseInt(process.env.CHUNK_TIMEOUT || '') || DEFAULT_CONFIG.chunkTimeout
  };
}

export const ENTITY_OPERATIONS = {
  // Default ratio for operation types
  OPERATION_DISTRIBUTION: {
    create: 0.45,
    update: 0.45,
    delete: 0.1
  },
  
  // Percentage of records that should have duplicate operations
  // This is used to test deduplication logic
  DUPLICATE_PERCENTAGE: 0.5, // 50% of records will have duplicates (increased for better testing)
  
  // Minimum number of records needed to generate duplicates
  MIN_RECORDS_FOR_DUPLICATES: 3
}; 