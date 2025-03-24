/**
 * Configuration options for sync operations
 */
export interface SyncConfig {
  /**
   * Database related configuration
   */
  database: {
    /**
     * Default batch size for database operations
     * Controls how many records are processed at once
     */
    batchSize: number;

    /**
     * Maximum number of retries for transient database errors
     */
    maxRetries: number;

    /**
     * Statement timeout in milliseconds
     * Prevents queries from running too long
     */
    statementTimeoutMs: number;

    /**
     * Whether to use transactions for batch operations
     */
    useTransactions: boolean;
  };

  /**
   * WebSocket related configuration
   */
  websocket: {
    /**
     * Maximum message size in bytes
     */
    maxMessageSizeBytes: number;

    /**
     * Chunk size for large messages
     * Controls how many changes are sent in a single message
     */
    chunkSize: number;
  };

  /**
   * Logging related configuration
   */
  logging: {
    /**
     * Whether to log CRDT conflicts
     */
    logCRDTConflicts: boolean;

    /**
     * Whether to log detailed performance metrics
     */
    logPerformanceMetrics: boolean;
  };
}

/**
 * Default sync configuration
 */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  database: {
    batchSize: 100,
    maxRetries: 3,
    statementTimeoutMs: 20000, // 20 seconds
    useTransactions: true,
  },
  websocket: {
    maxMessageSizeBytes: 5 * 1024 * 1024, // 5MB
    chunkSize: 500,
  },
  logging: {
    logCRDTConflicts: true,
    logPerformanceMetrics: true,
  },
}; 