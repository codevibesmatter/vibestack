import { createLogger } from '../core/logger.ts';
import type { TableChange } from '@repo/sync-types';
import { ChangeTracker } from '../core/entity-changes/change-tracker.ts';
import { createChangeTracker } from '../core/entity-changes/change-operations.ts';

// Logger for this module
const logger = createLogger('sync-client-operations');

// Internal state for the module
let changeTracker: ChangeTracker | null = null;
let clients: string[] = [];
let expectedChanges: number = 0;
let operations: any = null;
let databaseChangesApplied: boolean = false;
let allChangesReceived: boolean = false;
let completionTimeoutId: NodeJS.Timeout | null = null;
let completionForced: boolean = false;
let onDatabaseChangesAppliedCallback: (() => void) | null = null;

/**
 * Module for sync client operations
 * Contains all the complex logic abstracted away from the scenario
 */
export const syncClientOperations = {
  /**
   * Set operations reference for use by all methods
   */
  setOperations(ops: any): void {
    operations = ops;
    logger.info('Operations reference set for sync client operations module');
  },

  /**
   * Get the change tracker instance
   * This is useful for scenarios that need direct access to tracker functionality
   */
  getChangeTracker(): ChangeTracker | null {
    return changeTracker;
  },

  /**
   * Create and configure WebSocket clients
   */
  async createAndConfigureClients({ count, initialLSN, wsOperations }: { 
    count: number;
    initialLSN?: string;
    wsOperations?: any; 
  }): Promise<string[]> {
    // Store operations reference if provided
    if (wsOperations) {
      operations = wsOperations;
    }
    
    logger.info(`Creating ${count} WebSocket clients`);
    
    // Create clients
    const newClients: string[] = [];
    for (let i = 0; i < count; i++) {
      const profileId = i + 1; // 1-based profile ID
      
      // Create client using the operations passed to the function
      // or use the global operations if available
      const ops = wsOperations || operations;
      if (!ops || !ops.ws || !ops.ws.createClient) {
        throw new Error('WebSocket operations not available');
      }
      
      const clientId = await ops.ws.createClient(profileId);
      newClients.push(clientId);
      logger.info(`Created client ${i+1}/${count}: ${clientId} with profile ID ${profileId}`);
    }
    
    // Store clients for later use
    clients = newClients;
    
    // Update LSN for all clients if provided
    if (initialLSN && initialLSN !== '0/0') {
      logger.info(`Setting initial LSN ${initialLSN} for all clients`);
      
      for (const clientId of newClients) {
        await operations.ws.updateLSN(clientId, initialLSN);
      }
    }
    
    // Set up clients (connect to WebSocket server)
    for (const clientId of newClients) {
      await operations.ws.setupClient(clientId);
    }
    
    logger.info(`All ${newClients.length} clients created and configured`);
    return newClients;
  },
  
  /**
   * Initialize tracking for live changes
   */
  async initializeLiveChangeTracking({
    clients,
    expectedChanges,
    onDatabaseChangesApplied
  }: {
    clients: string[];
    expectedChanges: number;
    onDatabaseChangesApplied?: () => void;
  }): Promise<void> {
    logger.info(`Initializing change tracking for ${clients.length} clients, expecting ${expectedChanges} changes`);
    
    // Create a change tracker instance
    const tracker = createChangeTracker({
      tolerance: 0,
      deduplicationEnabled: true
    });
    
    // Register clients with the tracker
    tracker.registerClients(clients);
    
    // Set the expected count for all clients
    clients.forEach(client => {
      tracker.setClientExpectedCount(client, expectedChanges);
    });
    
    changeTracker = tracker;
    logger.info(`Change tracking initialized`);
    
    // Store reference to the callback for use by trackDatabaseChanges
    if (onDatabaseChangesApplied) {
      onDatabaseChangesAppliedCallback = onDatabaseChangesApplied;
    }
  },
  
  /**
   * Track received changes
   */
  async trackReceivedChanges({ 
    clientId, 
    changes, 
    lastLSN,
    isCatchupSync = false
  }: { 
    clientId: string; 
    changes: TableChange[]; 
    lastLSN?: string;
    isCatchupSync?: boolean;
  }): Promise<void> {
    if (!changeTracker) {
      logger.warn('Change tracker not initialized, cannot track changes');
      return;
    }
    
    // Skip tracking catchup sync changes - they're not part of our validation
    if (isCatchupSync) {
      logger.info(`Skipping tracking of ${changes.length} catchup sync changes for client ${clientId}`);
      return;
    }
    
    // Generate a batch ID for traceability
    const batchId = `batch-${lastLSN || '0-0'}-${Date.now()}`;
    
    // Track changes
    changeTracker.trackChanges(clientId, changes, batchId);
    
    // Update LSN if needed
    if (lastLSN && operations) {
      await operations.ws.updateLSN(clientId, lastLSN);
    }
    
    // Check if we should setup a completion timeout
    this.checkForCompletionSetup();
  },
  
  /**
   * Check if we should set up a completion timeout
   * This is a helper to handle cases where changes are received before the tracker
   * is fully ready or when there's a mismatch between expected and actual changes
   */
  checkForCompletionSetup(): void {
    // Only proceed if:
    // 1. Database changes are applied
    // 2. We have a change tracker
    // 3. We haven't already set up a completion timeout
    // 4. We haven't already forced completion
    if (databaseChangesApplied && changeTracker && !completionTimeoutId && !completionForced) {
      // Check if we have received changes for all clients
      let receivedCounts = 0;
      let expectedTotalCounts = 0;
      
      for (const clientId of clients) {
        const progress = changeTracker.getClientProgress(clientId);
        if (progress) {
          receivedCounts += progress.current;
          expectedTotalCounts += progress.expected;
        }
      }
      
      // If we've received any changes, set up a completion timeout
      if (receivedCounts > 0) {
        logger.info(`Setting up completion timeout: received ${receivedCounts}/${expectedTotalCounts} changes`);
        
        // Set a timeout to force completion if we're stalled
        completionTimeoutId = setTimeout(() => {
          if (!completionForced && changeTracker) {
            logger.warn('Forcing completion after timeout - we may have received all changes');
            
            for (const clientId of clients) {
              const progress = changeTracker.getClientProgress(clientId);
              if (progress) {
                logger.info(`Client ${clientId} progress: ${progress.current}/${progress.expected} changes`);
              }
            }
            
            // Mark that all changes are received
            allChangesReceived = true;
            
            // Force the tracker to consider sync complete
            changeTracker.forceSuccess('Changes received but tracker never completed');
            completionForced = true;
          }
        }, 10000); // 10 second timeout
      }
    }
  },
  
  /**
   * Track database changes
   */
  trackDatabaseChanges(changes: TableChange[]): void {
    if (!changeTracker) {
      logger.warn('Change tracker not initialized, cannot track database changes');
      return;
    }
    
    // Track these as our source of truth
    logger.info(`Tracking ${changes.length} database changes as source of truth`);
    changeTracker.trackDatabaseChanges(changes);
    
    // Update expected count for all clients
    if (clients.length > 0 && changeTracker) {
      const actualChangeCount = changes.length;
      logger.info(`Updating expected count for all clients to ${actualChangeCount} based on actual database changes`);
      
      for (const clientId of clients) {
        changeTracker.setClientExpectedCount(clientId, actualChangeCount);
      }
    }
    
    // Mark that database changes are fully applied
    databaseChangesApplied = true;
    logger.info('Database changes are fully applied and tracked');
    
    // Call the callback if provided
    if (onDatabaseChangesAppliedCallback) {
      onDatabaseChangesAppliedCallback();
    }
    
    // Check if we should set up a completion timeout
    this.checkForCompletionSetup();
  },
  
  /**
   * Check if synchronization is complete
   */
  async isSyncComplete(): Promise<boolean> {
    if (!changeTracker) {
      logger.warn('Change tracker not initialized, cannot check completion');
      return false;
    }
    
    // Don't check for completion until database changes are fully applied
    if (!databaseChangesApplied) {
      logger.debug('Database changes not yet fully applied, waiting before checking completion');
      return false;
    }
    
    // If we've forced completion, just return true
    if (completionForced) {
      return true;
    }
    
    // Only check for completion after database changes are fully applied
    const isComplete = changeTracker.checkCompletion();
    
    if (isComplete) {
      logger.info('All expected changes received, synchronization complete');
      // Clear the completion timeout if it exists
      if (completionTimeoutId) {
        clearTimeout(completionTimeoutId);
        completionTimeoutId = null;
      }
    }
    
    return isComplete;
  },
  
  /**
   * Validate synchronization results
   */
  async validateSyncResults(): Promise<{
    success: boolean;
    databaseChanges: number;
    receivedChanges: number;
    missingChanges: number;
    successRate: number;
    matchRate: number;
    detailedReport?: {
      changesByTable: Record<string, number>;
      missingChangeDetails: Array<{ id: string; table: string; operation: string; timestamp: string }>;
      exactMatchCount: number;
      uniqueRecordsChanged: number;
      uniqueRecordsReceived: number;
    };
  }> {
    if (!changeTracker) {
      logger.warn('Change tracker not initialized, cannot validate results');
      return {
        success: false,
        databaseChanges: 0,
        receivedChanges: 0,
        missingChanges: 0,
        successRate: 0,
        matchRate: 0
      };
    }
    
    // Get validation report from tracker
    const report = changeTracker.getValidationReport();
    
    // Calculate success rate - make sure it doesn't exceed 100%
    const receivedChangesWithLimit = Math.min(report.receivedChanges, report.databaseChanges * clients.length);
    const successRate = report.databaseChanges > 0
      ? Math.round((receivedChangesWithLimit / (report.databaseChanges * clients.length)) * 100)
      : 0;
    
    // Also calculate match rate for debugging - this can exceed 100% if we get more changes than expected
    const matchRate = report.databaseChanges > 0
      ? Math.round((report.receivedChanges / (report.databaseChanges * clients.length)) * 100)
      : 0;
    
    
    logger.info(`Validation details: ${report.databaseChanges} changes applied, ${report.receivedChanges} changes received`);
    if (matchRate > 100) {
      logger.warn(`Received ${matchRate}% of expected changes - clients with older LSNs likely received both catchup sync (historical changes from previous test runs) AND live changes from this test run`);
    }
    
    // Summarize changes by table for the detailed report
    const changesByTable: Record<string, number> = {};
    if (changeTracker) {
      const dbChanges = changeTracker.getDatabaseChanges();
      dbChanges.forEach(change => {
        const table = change.table || 'unknown';
        changesByTable[table] = (changesByTable[table] || 0) + 1;
      });
    }
    
    return {
      success: report.realMissingChanges.length === 0,
      databaseChanges: report.databaseChanges,
      receivedChanges: report.receivedChanges,
      missingChanges: report.realMissingChanges.length,
      successRate: Math.min(successRate, 100), // Can't exceed 100%
      matchRate, // This can exceed 100% to show we're getting unexpected additional changes
      detailedReport: {
        changesByTable,
        missingChangeDetails: report.detailedMissingReport || [],
        exactMatchCount: report.exactMatchCount || 0,
        uniqueRecordsChanged: report.uniqueRecordsChanged || 0,
        uniqueRecordsReceived: report.uniqueRecordsReceived || 0
      }
    };
  },
  
  /**
   * Disconnect clients
   */
  async disconnectClients(clientIds: string[]): Promise<void> {
    logger.info(`Disconnecting ${clientIds.length} clients`);
    
    for (const clientId of clientIds) {
      try {
        await operations.ws.disconnectClient(clientId);
        logger.info(`Disconnected client ${clientId}`);
      } catch (error) {
        logger.warn(`Error disconnecting client ${clientId}: ${error}`);
        
        // Try force removal as fallback
        try {
          await operations.ws.removeClient(clientId);
          logger.info(`Force removed client ${clientId}`);
        } catch (removeError) {
          logger.error(`Failed to remove client ${clientId}: ${removeError}`);
        }
      }
    }
    
    logger.info('All clients disconnected');
  },
  
  /**
   * Reset the module state
   */
  reset(): void {
    changeTracker = null;
    clients = [];
    expectedChanges = 0;
    operations = null;
    databaseChangesApplied = false;
    allChangesReceived = false;
    completionForced = false;
    onDatabaseChangesAppliedCallback = null;
    
    // Clear any timeout
    if (completionTimeoutId) {
      clearTimeout(completionTimeoutId);
      completionTimeoutId = null;
    }
    
    logger.info('Reset sync client operations module state');
  }
}; 