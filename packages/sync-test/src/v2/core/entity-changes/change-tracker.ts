/**
 * Change Tracker V2
 * 
 * A comprehensive tracker for changes that provides:
 * - ID tracking and reservation
 * - LSN and batch tracking
 * - Duplicate detection
 * - Applied changes history
 */

import { createLogger } from '../logger.ts';
import { TableChangeTest } from './types.ts';
import { EntityType, TABLE_TO_ENTITY } from './entity-adapter.ts';
import { v4 as uuidv4 } from 'uuid';

// Extended interface for tracking options
export interface ChangeTrackerOptions {
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  maxHistorySize?: number; // Maximum number of changes to keep in history
  trackLSN?: boolean; // Whether to track LSN info
  trackUpdatedEntities?: boolean; // Whether to track which batch entities were updated in
  idReleaseAfterBatches?: number; // Number of batches after which to release updated IDs
}

// Interface for ID reservation
export interface IDReservation {
  id: string;
  entityType: EntityType;
  reservedFor: 'create' | 'update' | 'delete';
  expiresAt?: number; // Timestamp when reservation expires
  batchId?: string;
  metadata?: Record<string, any>;
}

// Interface for LSN Range tracking
export interface LSNRange {
  min: string;
  max: string;
  batchId?: string;
  timestamp: number;
  count: number;
}

export class ChangeTracker {
  private logger = createLogger('entity-changes.tracker');
  
  // Core tracking - applied changes and batches
  private appliedChanges: TableChangeTest[] = [];
  private appliedChangesByBatch: Record<string, TableChangeTest[]> = {};
  private maxHistorySize: number = 1000; // Default history size
  
  // Track confirmed IDs (successfully applied to DB)
  private confirmedIds: Record<EntityType, Set<string>> = {
    user: new Set<string>(),
    project: new Set<string>(),
    task: new Set<string>(),
    comment: new Set<string>()
  };
  
  // Track reserved IDs (not yet confirmed but planned to use)
  private reservedIds: Record<EntityType, IDReservation[]> = {
    user: [],
    project: [],
    task: [],
    comment: []
  };
  
  // Track intentional duplicates
  private intentionalDuplicates: TableChangeTest[] = [];
  
  // Track LSN information
  private trackLSN: boolean = true;
  private lsnRanges: LSNRange[] = [];
  private lastLSN: string | null = null;
  
  // Track which batch entities were updated in
  private trackUpdatedEntities: boolean = true;
  private updatedEntities: Record<EntityType, Map<string, number>> = {
    user: new Map<string, number>(),
    project: new Map<string, number>(),
    task: new Map<string, number>(),
    comment: new Map<string, number>()
  };
  
  // Current batch number - incremented on each recordAppliedChanges call with a new batchId
  private currentBatchNumber: number = 0;
  private batchToNumber: Map<string, number> = new Map();
  
  // How many batches before releasing updated entity IDs
  private idReleaseAfterBatches: number = 5;
  
  constructor(options: ChangeTrackerOptions = {}) {
    // Configure options
    if (options.maxHistorySize) {
      this.maxHistorySize = options.maxHistorySize;
    }
    
    if (options.trackLSN !== undefined) {
      this.trackLSN = options.trackLSN;
    }
    
    if (options.trackUpdatedEntities !== undefined) {
      this.trackUpdatedEntities = options.trackUpdatedEntities;
    }
    
    if (options.idReleaseAfterBatches !== undefined) {
      this.idReleaseAfterBatches = options.idReleaseAfterBatches;
    }
    
    // Log initialization
    if (options.logLevel) {
      this.logger.info(`ChangeTracker V2 initialized with ${options.logLevel} log level`);
    } else {
      this.logger.info('ChangeTracker V2 initialized');
    }
    
    this.logger.info(`History size: ${this.maxHistorySize}, LSN tracking: ${this.trackLSN}, Update tracking: ${this.trackUpdatedEntities}, ID release after: ${this.idReleaseAfterBatches} batches`);
  }
  
  /**
   * Record changes that were successfully applied to the database
   * @param changes Applied changes from change-applier
   * @param batchId Optional batch ID for tracking
   * @returns Number of changes recorded
   */
  recordAppliedChanges(changes: TableChangeTest[], batchId?: string): number {
    // Add to overall applied changes
    this.appliedChanges.push(...changes);
    
    // Enforce history size limit
    if (this.appliedChanges.length > this.maxHistorySize) {
      const overflow = this.appliedChanges.length - this.maxHistorySize;
      this.appliedChanges = this.appliedChanges.slice(overflow);
      this.logger.info(`Trimmed ${overflow} old changes to maintain history size limit`);
    }
    
    // Track by batch ID if provided
    if (batchId) {
      if (!this.appliedChangesByBatch[batchId]) {
        this.appliedChangesByBatch[batchId] = [];
      }
      this.appliedChangesByBatch[batchId].push(...changes);
    }
    
    // Track confirmed IDs for entity types and release reservations
    changes.forEach(change => {
      const id = change.data?.id?.toString();
      if (!id) return;
      
      // Determine entity type from table name
      const entityType = this.getEntityTypeFromTable(change.table);
      if (entityType) {
        // Add to confirmed IDs
        this.confirmedIds[entityType].add(id);
        
        // Release any reservation for this ID
        this.releaseReservation(entityType, id);
      }
      
      // Track intentional duplicates
      if (change.data && change.data.__intentionalDuplicate) {
        this.intentionalDuplicates.push(change);
      }
      
      // Track LSN if available
      if (this.trackLSN && change.lsn) {
        this.trackLSNChange(change.lsn, batchId);
      }
    });
    
    this.logger.info(`Recorded ${changes.length} applied changes${batchId ? ` for batch ${batchId}` : ''}`);
    
    // Clean expired reservations
    this.cleanExpiredReservations();
    
    // Assign batch number if new batch ID
    if (batchId && !this.batchToNumber.has(batchId)) {
      this.currentBatchNumber++;
      this.batchToNumber.set(batchId, this.currentBatchNumber);
      this.logger.debug(`Assigned batch number ${this.currentBatchNumber} to batch ${batchId}`);
    }
    
    // Track updated entities by batch number
    if (this.trackUpdatedEntities) {
      const batchNumber = batchId ? (this.batchToNumber.get(batchId) || this.currentBatchNumber) : this.currentBatchNumber;
      this.trackEntityUpdates(changes, batchNumber);
    }
    
    return changes.length;
  }
  
  /**
   * Reserve an ID for a specific operation
   * @param entityType The entity type to reserve an ID for
   * @param operation The operation to reserve the ID for (create/update/delete)
   * @param id Optional ID to reserve (auto-generated UUID if not provided)
   * @param options Additional reservation options
   * @returns The reserved ID
   */
  reserveId(
    entityType: EntityType, 
    operation: 'create' | 'update' | 'delete',
    id?: string,
    options: {
      expirySeconds?: number;
      batchId?: string;
      metadata?: Record<string, any>;
    } = {}
  ): string {
    // For create operations, generate UUID if not provided
    if (operation === 'create' && !id) {
      id = uuidv4();
    } else if (!id) {
      throw new Error(`ID must be provided for ${operation} operations`);
    }
    
    // Check if ID is already reserved
    const existingReservation = this.reservedIds[entityType].find(r => r.id === id);
    if (existingReservation) {
      throw new Error(`ID ${id} is already reserved for ${existingReservation.reservedFor} operation`);
    }
    
    // Create reservation
    const reservation: IDReservation = {
      id,
      entityType,
      reservedFor: operation,
      batchId: options.batchId,
      metadata: options.metadata
    };
    
    // Set expiry if specified
    if (options.expirySeconds) {
      reservation.expiresAt = Date.now() + (options.expirySeconds * 1000);
    }
    
    // Add to reserved IDs
    this.reservedIds[entityType].push(reservation);
    
    this.logger.info(`Reserved ID ${id} for ${operation} operation on ${entityType}`);
    return id;
  }
  
  /**
   * Check if an ID is reserved
   * @param entityType The entity type to check
   * @param id The ID to check
   * @returns Whether the ID is reserved
   */
  isReserved(entityType: EntityType, id: string): boolean {
    return this.reservedIds[entityType].some(r => r.id === id);
  }
  
  /**
   * Get reservation details for an ID
   * @param entityType The entity type to check
   * @param id The ID to check
   * @returns The reservation details or null if not reserved
   */
  getReservation(entityType: EntityType, id: string): IDReservation | null {
    return this.reservedIds[entityType].find(r => r.id === id) || null;
  }
  
  /**
   * Release a reservation for an ID
   * @param entityType The entity type to release
   * @param id The ID to release
   * @returns Whether the reservation was released
   */
  releaseReservation(entityType: EntityType, id: string): boolean {
    const initialLength = this.reservedIds[entityType].length;
    this.reservedIds[entityType] = this.reservedIds[entityType].filter(r => r.id !== id);
    
    const wasReleased = this.reservedIds[entityType].length < initialLength;
    if (wasReleased) {
      this.logger.info(`Released reservation for ID ${id} on ${entityType}`);
    }
    
    return wasReleased;
  }
  
  /**
   * Clean up expired reservations
   * @returns Number of expired reservations removed
   */
  cleanExpiredReservations(): number {
    const now = Date.now();
    let expiredCount = 0;
    
    for (const entityType of Object.keys(this.reservedIds) as EntityType[]) {
      const initialLength = this.reservedIds[entityType].length;
      this.reservedIds[entityType] = this.reservedIds[entityType].filter(r => {
        if (!r.expiresAt || r.expiresAt > now) return true;
        return false;
      });
      
      expiredCount += initialLength - this.reservedIds[entityType].length;
    }
    
    if (expiredCount > 0) {
      this.logger.info(`Cleaned up ${expiredCount} expired reservations`);
    }
    
    return expiredCount;
  }
  
  /**
   * Track LSN for a change
   * @param lsn The LSN to track
   * @param batchId Optional batch ID
   */
  private trackLSNChange(lsn: string, batchId?: string): void {
    if (!this.trackLSN) return;
    
    // Initialize LSN range if this is the first LSN
    if (!this.lastLSN) {
      this.lsnRanges.push({
        min: lsn,
        max: lsn,
        timestamp: Date.now(),
        count: 1,
        batchId
      });
      this.lastLSN = lsn;
      return;
    }
    
    // Check if part of current range
    const currentRange = this.lsnRanges[this.lsnRanges.length - 1];
    
    // Compare LSNs (simple string comparison)
    if (lsn > currentRange.max) {
      currentRange.max = lsn;
      currentRange.count = (currentRange.count || 0) + 1;
    } else if (lsn < currentRange.min) {
      currentRange.min = lsn;
      currentRange.count = (currentRange.count || 0) + 1;
    } else {
      // Within existing range, just increment count
      currentRange.count = (currentRange.count || 0) + 1;
    }
    
    this.lastLSN = lsn;
  }
  
  /**
   * Set the last known LSN
   * @param lsn The LSN to set
   */
  setLastLSN(lsn: string): void {
    if (!this.trackLSN) return;
    
    this.lastLSN = lsn;
    
    // Create a new range if none exists
    if (this.lsnRanges.length === 0) {
      this.lsnRanges.push({
        min: lsn,
        max: lsn,
        timestamp: Date.now(),
        count: 0
      });
    }
    
    this.logger.debug(`Set last LSN to ${lsn}`);
  }
  
  /**
   * Get the last known LSN
   * @returns The last known LSN
   */
  getLastLSN(): string | null {
    return this.lastLSN;
  }
  
  /**
   * Get LSN ranges tracked
   * @returns Array of LSN ranges
   */
  getLSNRanges(): LSNRange[] {
    return [...this.lsnRanges];
  }
  
  /**
   * Get all confirmed IDs for a specific entity type
   * @param entityType The entity type to get IDs for
   * @returns Array of confirmed IDs
   */
  getConfirmedIds(entityType: EntityType): string[] {
    return Array.from(this.confirmedIds[entityType]);
  }
  
  /**
   * Get all reserved IDs for a specific entity type and operation
   * @param entityType The entity type to get IDs for
   * @param operation Optional operation filter
   * @returns Array of reserved IDs
   */
  getReservedIds(entityType: EntityType, operation?: 'create' | 'update' | 'delete'): string[] {
    if (operation) {
      return this.reservedIds[entityType]
        .filter(r => r.reservedFor === operation)
        .map(r => r.id);
    }
    
    return this.reservedIds[entityType].map(r => r.id);
  }
  
  /**
   * Find duplicate changes in a set of changes
   * @param changes The changes to check for duplicates
   * @returns Object with duplicate information
   */
  findDuplicates(changes: TableChangeTest[]): {
    duplicates: {id: string, table: string, operation: string, changes: TableChangeTest[]}[];
    count: number;
  } {
    const changesByKey: Record<string, TableChangeTest[]> = {};
    
    // Group changes by table+id+operation
    for (const change of changes) {
      const id = change.data?.id;
      if (!id) continue;
      
      const key = `${change.table}:${id}:${change.operation}`;
      
      if (!changesByKey[key]) {
        changesByKey[key] = [];
      }
      
      changesByKey[key].push(change);
    }
    
    // Find groups with more than one change
    const duplicateGroups = Object.entries(changesByKey)
      .filter(([_, changesArray]) => changesArray.length > 1)
      .map(([key, changesArray]) => {
        const [table, id, operation] = key.split(':');
        return {
          id,
          table,
          operation,
          changes: changesArray
        };
      });
      
    return {
      duplicates: duplicateGroups,
      count: duplicateGroups.reduce((sum, group) => sum + group.changes.length - 1, 0)
    };
  }
  
  /**
   * Get all intentional duplicates that were applied
   * @returns Array of intentional duplicate changes
   */
  getIntentionalDuplicates(): TableChangeTest[] {
    return [...this.intentionalDuplicates];
  }
  
  /**
   * Get applied changes for a specific batch
   * @param batchId The batch ID to get changes for
   * @returns Array of applied changes for the batch
   */
  getAppliedChangesForBatch(batchId: string): TableChangeTest[] {
    return this.appliedChangesByBatch[batchId] || [];
  }
  
  /**
   * Get all applied changes
   * @returns Array of all applied changes
   */
  getAllAppliedChanges(): TableChangeTest[] {
    return [...this.appliedChanges];
  }
  
  /**
   * Get a summary of applied changes by entity type and operation
   * @returns Summary object with counts
   */
  getSummary(): {
    totalChanges: number;
    byEntityType: Record<EntityType, number>;
    byOperation: Record<string, number>;
    byBatch: Record<string, number>;
    intentionalDuplicates: number;
    reservations: Record<EntityType, number>;
    lsnRanges: number;
  } {
    const summary = {
      totalChanges: this.appliedChanges.length,
      byEntityType: {
        user: 0,
        project: 0,
        task: 0,
        comment: 0
      } as Record<EntityType, number>,
      byOperation: {} as Record<string, number>,
      byBatch: {} as Record<string, number>,
      intentionalDuplicates: this.intentionalDuplicates.length,
      reservations: {
        user: this.reservedIds.user.length,
        project: this.reservedIds.project.length,
        task: this.reservedIds.task.length,
        comment: this.reservedIds.comment.length
      },
      lsnRanges: this.lsnRanges.length
    };
    
    this.appliedChanges.forEach(change => {
      // Count by entity type
      const entityType = this.getEntityTypeFromTable(change.table);
      if (entityType) {
        summary.byEntityType[entityType]++;
      }
      
      // Count by operation
      const operation = change.operation || 'unknown';
      summary.byOperation[operation] = (summary.byOperation[operation] || 0) + 1;
    });
    
    // Count by batch
    Object.entries(this.appliedChangesByBatch).forEach(([batchId, changes]) => {
      summary.byBatch[batchId] = changes.length;
    });
    
    return summary;
  }
  
  /**
   * Track which entities were updated in which batch
   * @param changes The changes to track
   * @param batchNumber The batch number
   */
  private trackEntityUpdates(changes: TableChangeTest[], batchNumber: number): void {
    for (const change of changes) {
      if (change.operation !== 'update') continue;
      
      const id = change.data?.id?.toString();
      if (!id) continue;
      
      const entityType = this.getEntityTypeFromTable(change.table);
      if (!entityType) continue;
      
      // Record which batch this entity was updated in
      this.updatedEntities[entityType].set(id, batchNumber);
    }
  }
  
  /**
   * Explicitly track entity updates by type and ID
   * @param entityType The entity type that was updated
   * @param ids Array of entity IDs that were updated
   * @param batchNumber Optional batch number (uses current batch if not specified)
   */
  trackSpecificEntityUpdates(
    entityType: EntityType,
    ids: string[],
    batchNumber?: number
  ): void {
    if (!this.trackUpdatedEntities) return;
    
    const batchNum = batchNumber || this.currentBatchNumber;
    
    for (const id of ids) {
      this.updatedEntities[entityType].set(id, batchNum);
    }
    
    this.logger.debug(`Tracked ${ids.length} ${entityType} updates in batch ${batchNum}`);
  }
  
  /**
   * Release entity IDs that were updated more than a specified number of batches ago
   * This allows these IDs to be used in change generation again
   * @param currentBatch The current batch number
   * @param releaseAfterBatches How many batches after which to release IDs (defaults to this.idReleaseAfterBatches)
   * @returns Number of IDs released
   */
  releaseUpdatedIds(
    currentBatch?: number,
    releaseAfterBatches?: number
  ): number {
    if (!this.trackUpdatedEntities) return 0;
    
    const currentBatchNum = currentBatch || this.currentBatchNumber;
    const batchThreshold = releaseAfterBatches || this.idReleaseAfterBatches;
    
    let releasedTotal = 0;
    
    for (const entityType of Object.keys(this.updatedEntities) as EntityType[]) {
      const idsToRelease: string[] = [];
      
      this.updatedEntities[entityType].forEach((batchNum, id) => {
        if (currentBatchNum - batchNum >= batchThreshold) {
          idsToRelease.push(id);
        }
      });
      
      // Remove released IDs from tracking
      for (const id of idsToRelease) {
        this.updatedEntities[entityType].delete(id);
      }
      
      releasedTotal += idsToRelease.length;
      
      if (idsToRelease.length > 0) {
        this.logger.debug(`Released ${idsToRelease.length} ${entityType} IDs updated before batch ${currentBatchNum - batchThreshold}`);
      }
    }
    
    if (releasedTotal > 0) {
      this.logger.info(`Released ${releasedTotal} entity IDs updated before batch ${currentBatchNum - batchThreshold}`);
    }
    
    return releasedTotal;
  }
  
  /**
   * Get the current batch number
   * @returns The current batch number
   */
  getCurrentBatchNumber(): number {
    return this.currentBatchNumber;
  }
  
  /**
   * Get batch information for a specific batch ID
   * @param batchId The batch ID
   * @returns Batch information
   */
  getBatchInformation(batchId: string): {
    batchNumber: number;
    changeCount: number;
    timestamp: string;
  } | null {
    if (!this.batchToNumber.has(batchId)) {
      return null;
    }
    
    const batchNumber = this.batchToNumber.get(batchId) as number;
    const changes = this.appliedChangesByBatch[batchId] || [];
    
    // Get timestamp from first change
    let timestamp = new Date().toISOString();
    if (changes.length > 0 && changes[0].updated_at) {
      timestamp = changes[0].updated_at;
    }
    
    return {
      batchNumber,
      changeCount: changes.length,
      timestamp
    };
  }
  
  /**
   * Get statistics for all batches
   * @returns Batch statistics
   */
  getBatchStatistics(): {
    totalBatches: number;
    totalChangesReceived: number;
    lastBatchTime: string;
    changesByBatch: {
      batchId: string;
      batchNumber: number;
      changeCount: number;
      timestamp: string;
    }[];
  } {
    const batchIds = Object.keys(this.appliedChangesByBatch);
    const changesByBatch = batchIds.map(batchId => {
      const info = this.getBatchInformation(batchId);
      return {
        batchId,
        batchNumber: info?.batchNumber || 0,
        changeCount: info?.changeCount || 0,
        timestamp: info?.timestamp || new Date().toISOString()
      };
    });
    
    // Sort by batch number
    changesByBatch.sort((a, b) => a.batchNumber - b.batchNumber);
    
    // Calculate total changes
    const totalChangesReceived = changesByBatch.reduce((sum, batch) => sum + batch.changeCount, 0);
    
    // Get timestamp of last batch
    let lastBatchTime = new Date().toISOString();
    if (changesByBatch.length > 0) {
      lastBatchTime = changesByBatch[changesByBatch.length - 1].timestamp;
    }
    
    return {
      totalBatches: this.batchToNumber.size,
      totalChangesReceived,
      lastBatchTime,
      changesByBatch
    };
  }
  
  /**
   * Get updated entity IDs for a specific entity type
   * @param entityType The entity type
   * @param minBatchNumber Optional minimum batch number
   * @param maxBatchNumber Optional maximum batch number
   * @returns Array of updated entity IDs
   */
  getUpdatedEntityIds(
    entityType: EntityType,
    minBatchNumber?: number,
    maxBatchNumber?: number
  ): string[] {
    if (!this.trackUpdatedEntities) return [];
    
    const ids: string[] = [];
    
    this.updatedEntities[entityType].forEach((batchNum, id) => {
      if (minBatchNumber !== undefined && batchNum < minBatchNumber) return;
      if (maxBatchNumber !== undefined && batchNum > maxBatchNumber) return;
      ids.push(id);
    });
    
    return ids;
  }
  
  /**
   * Get IDs that should be excluded from updates
   * This includes recently created and recently updated IDs
   * @param entityType The entity type
   * @returns Set of IDs to exclude
   */
  getIdsToExcludeFromUpdates(entityType: EntityType): Set<string> {
    const excludeIds = new Set<string>();
    
    // Add confirmed IDs (recently created)
    this.confirmedIds[entityType].forEach(id => excludeIds.add(id));
    
    // Add updated entity IDs
    if (this.trackUpdatedEntities) {
      this.updatedEntities[entityType].forEach((_, id) => excludeIds.add(id));
    }
    
    // Add reserved IDs
    this.reservedIds[entityType].forEach(r => excludeIds.add(r.id));
    
    return excludeIds;
  }
  
  /**
   * Clear the tracker state
   */
  clear(): void {
    this.appliedChanges = [];
    this.appliedChangesByBatch = {};
    this.intentionalDuplicates = [];
    this.lsnRanges = [];
    this.lastLSN = null;
    
    this.confirmedIds = {
      user: new Set<string>(),
      project: new Set<string>(),
      task: new Set<string>(),
      comment: new Set<string>()
    };
    
    this.reservedIds = {
      user: [],
      project: [],
      task: [],
      comment: []
    };
    
    this.updatedEntities = {
      user: new Map<string, number>(),
      project: new Map<string, number>(),
      task: new Map<string, number>(),
      comment: new Map<string, number>()
    };
    
    this.currentBatchNumber = 0;
    this.batchToNumber.clear();
    
    this.logger.info('Tracker state cleared');
  }
  
  /**
   * Convert table name to entity type
   * @param table Table name
   * @returns EntityType or undefined
   */
  private getEntityTypeFromTable(table?: string): EntityType | undefined {
    if (!table) return undefined;
    return TABLE_TO_ENTITY[table];
  }
}

/**
 * Singleton instance for global tracking
 */
export const globalChangeTracker = new ChangeTracker(); 