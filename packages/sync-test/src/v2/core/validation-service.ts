import { v4 as uuidv4 } from 'uuid';
import { 
  EntityChange,
  EntityType,
  Operation,
  ChangeStats,
  MissingChangeReport,
  DuplicateChangeReport
} from '../types.ts';
import { createLogger } from './logger.ts';
import type {
  TableChange,
  ServerChangesMessage
} from '@repo/sync-types';

/**
 * Compare two LSN (Log Sequence Number) values to determine their relative order
 * @param lsn1 First LSN in format "X/YYYYYYY"
 * @param lsn2 Second LSN in format "X/YYYYYYY"
 * @returns 1 if lsn1 > lsn2, -1 if lsn1 < lsn2, 0 if equal
 */
export function compareLSNs(lsn1: string, lsn2: string): number {
  if (lsn1 === lsn2) return 0;
  
  // Handle invalid LSN cases
  if (lsn1 === '0/0') return -1;
  if (lsn2 === '0/0') return 1;
  
  try {
    const [seg1A, seg1B] = lsn1.split('/');
    const [seg2A, seg2B] = lsn2.split('/');
    
    // Compare the first segment (numeric)
    const numA1 = parseInt(seg1A, 10);
    const numA2 = parseInt(seg2A, 10);
    
    if (numA1 !== numA2) {
      return numA1 > numA2 ? 1 : -1;
    }
    
    // If first segments are equal, compare the second segment (hexadecimal)
    const numB1 = parseInt(seg1B, 16);
    const numB2 = parseInt(seg2B, 16);
    
    if (numB1 !== numB2) {
      return numB1 > numB2 ? 1 : -1;
    }
    
    // They are truly equal
    return 0;
  } catch (e) {
    // Handle malformed LSNs - treat them as less than valid LSNs
    console.warn(`Error comparing LSNs ${lsn1} and ${lsn2}: ${e}`);
    return -1;
  }
}

/**
 * Validates if a LSN has proper format
 * @param lsn LSN string to validate
 * @returns boolean indicating if the LSN is valid
 */
export function isValidLSN(lsn: string): boolean {
  if (!lsn || typeof lsn !== 'string') return false;
  if (lsn === '0/0') return false; // Often represents an invalid state
  
  // LSN format should be X/YYYYYY where X is numeric and Y is hexadecimal
  return /^\d+\/[0-9A-F]+$/i.test(lsn);
}

/**
 * ValidationResult interface for validation checks
 */
export interface ValidationResult {
  success: boolean;
  totalExpected: number;
  totalReceived: number;
  missingChanges: MissingChangeReport[];
  duplicateChanges: DuplicateChangeReport[];
  stats: ChangeStats;
  completedAt: Date;
  duration: number;
}

/**
 * ValidationOptions for configuring validation checks
 */
export interface ValidationOptions {
  allowOutOfOrderChanges?: boolean;
  validateDataIntegrity?: boolean;
  timeoutMs?: number;
  strictEntityTypes?: boolean;
  ignoreExtraChanges?: boolean;
  requiredFields?: { [entityType: string]: string[] };
}

/**
 * MissingChangeVerificationResult interface for database verification results
 */
export interface MissingChangeVerificationResult {
  change: EntityChange;
  existsInDatabase: boolean;
  verificationFailed?: boolean;
  entityType: EntityType;
  operation: Operation;
  error?: string;
}

/**
 * ValidationService handles tracking and validating changes
 * between database operations and client receipts
 */
export class ValidationService {
  private logger = createLogger('Validation');
  private sessionId: string;
  private verbose: boolean = false;
  private idMapping: Record<string, string> = {}; // Map from synthetic IDs to real IDs
  
  // Change tracking collections
  private expectedChanges: Map<string, EntityChange> = new Map();
  private receivedChanges: Map<string, EntityChange> = new Map();
  private duplicateChanges: Map<string, EntityChange[]> = new Map();
  
  // Timing tracking
  private startTime: number = 0;
  private endTime: number = 0;
  
  // Stats tracking
  private stats: ChangeStats = {
    total: 0,
    byType: {} as Record<EntityType, number>,
    byOperation: {
      create: 0,
      update: 0,
      delete: 0
    },
    errors: 0
  };
  
  // Type tracking for more efficient lookups
  private changesByType: Map<EntityType, Set<string>> = new Map();
  private changesByOperation: Map<Operation, Set<string>> = new Map();
  
  // Options
  private options: ValidationOptions = {
    allowOutOfOrderChanges: true,
    validateDataIntegrity: true,
    timeoutMs: 60000,
    strictEntityTypes: false,
    ignoreExtraChanges: true
  };
  
  /**
   * Create a new validation service
   */
  constructor(options?: Partial<ValidationOptions>, verbose: boolean = false) {
    this.sessionId = uuidv4().substring(0, 8);
    this.verbose = verbose;
    
    if (options) {
      this.options = { ...this.options, ...options };
    }
    
    this.logger.info(`ValidationService created with session ID: ${this.sessionId}`);
    if (this.verbose) {
      this.logger.info(`Options: ${JSON.stringify(this.options)}`);
    }
    
    this.reset();
  }
  
  /**
   * Reset the validation service for a new test
   */
  public reset(): void {
    this.expectedChanges.clear();
    this.receivedChanges.clear();
    this.duplicateChanges.clear();
    
    this.changesByType.clear();
    this.changesByOperation.clear();
    
    this.startTime = Date.now();
    this.endTime = 0;
    
    this.stats = {
      total: 0,
      byType: {} as Record<EntityType, number>,
      byOperation: {
        create: 0,
        update: 0,
        delete: 0
      },
      errors: 0
    };
    
    this.logger.info(`ValidationService reset for session: ${this.sessionId}`);
  }
  
  /**
   * Compare two LSN values (wrapper for the utility function)
   * @param lsn1 First LSN
   * @param lsn2 Second LSN
   * @returns 1 if lsn1 > lsn2, -1 if lsn1 < lsn2, 0 if equal
   */
  public compareLSNs(lsn1: string, lsn2: string): number {
    return compareLSNs(lsn1, lsn2);
  }
  
  /**
   * Validates if an LSN is in the correct format and not the invalid 0/0 state
   * @param lsn LSN to validate
   * @returns boolean indicating if the LSN is valid
   */
  public isValidLSN(lsn: string): boolean {
    return isValidLSN(lsn);
  }
  
  /**
   * Determines if an LSN is greater than another LSN
   * @param lsn LSN to check
   * @param compareTo LSN to compare against
   * @returns true if lsn > compareTo
   */
  public isGreaterLSN(lsn: string, compareTo: string): boolean {
    return this.compareLSNs(lsn, compareTo) > 0;
  }
  
  /**
   * Track an expected change from the database
   */
  public trackExpectedChange(change: EntityChange): void {
    // Generate consistent key for the change
    const changeKey = this.getChangeKey(change);
    
    // Store the change
    this.expectedChanges.set(changeKey, change);
    
    // Update stats
    this.stats.total++;
    
    // Update type tracking
    if (!this.changesByType.has(change.type)) {
      this.changesByType.set(change.type, new Set());
    }
    this.changesByType.get(change.type)!.add(changeKey);
    
    // Update operation tracking
    if (!this.changesByOperation.has(change.operation)) {
      this.changesByOperation.set(change.operation, new Set());
    }
    this.changesByOperation.get(change.operation)!.add(changeKey);
    
    // Update stats by type
    if (!this.stats.byType[change.type]) {
      this.stats.byType[change.type] = 0;
    }
    this.stats.byType[change.type]++;
    
    // Update stats by operation
    if (change.operation === 'create') {
      this.stats.byOperation.create++;
    } else if (change.operation === 'update') {
      this.stats.byOperation.update++;
    } else if (change.operation === 'delete') {
      this.stats.byOperation.delete++;
    }
    
    if (this.verbose) {
      this.logger.debug(`Tracked expected change: ${changeKey} (type: ${change.type}, op: ${change.operation})`);
    }
  }
  
  /**
   * Track a batch of expected changes from the database
   */
  public trackExpectedChanges(changes: EntityChange[]): void {
    if (!changes || !Array.isArray(changes) || changes.length === 0) {
      this.logger.warn('No changes provided to trackExpectedChanges');
      return;
    }
    
    this.logger.info(`Tracking batch of ${changes.length} expected changes`);
    
    for (const change of changes) {
      // Skip invalid changes
      if (!change || !change.id) {
        this.logger.warn('Invalid change object skipped');
        continue;
      }
      
      // Store valid entity type
      if (!change.type || !this.isValidEntityType(change.type)) {
        this.logger.warn(`Invalid entity type for change ${change.id}: ${change.type}`);
        
        // Try to infer type from ID if synthetic
        if (change.id.includes('-')) {
          const parts = change.id.split('-');
          if (parts.length > 1 && this.isValidEntityType(parts[1])) {
            this.logger.info(`Inferring entity type '${parts[1]}' for change ${change.id}`);
            change.type = parts[1] as EntityType;
          }
        }
        
        // If still invalid, skip
        if (!change.type || !this.isValidEntityType(change.type)) {
          this.logger.warn(`Skipping change with invalid type: ${change.id}`);
          continue;
        }
      }
      
      // Track the change
      this.trackExpectedChange(change);
    }
  }
  
  /**
   * Check if an entity type is valid
   */
  private isValidEntityType(type: string): boolean {
    return ['user', 'post', 'comment', 'project', 'task'].includes(type);
  }
  
  /**
   * Track a received change from the client
   */
  public trackReceivedChange(change: EntityChange): void {
    // Generate consistent key for the change
    const changeKey = this.getChangeKey(change);
    
    // Check if we've already received this change
    if (this.receivedChanges.has(changeKey)) {
      // Duplicate change - track it separately
      if (!this.duplicateChanges.has(changeKey)) {
        this.duplicateChanges.set(changeKey, []);
      }
      this.duplicateChanges.get(changeKey)!.push(change);
      this.logger.warn(`Duplicate change received: ${changeKey}`);
      return;
    }
    
    // Store the change
    this.receivedChanges.set(changeKey, change);
    
    if (this.verbose) {
      this.logger.debug(`Tracked received change: ${changeKey} (type: ${change.type}, op: ${change.operation})`);
    }
  }
  
  /**
   * Track a batch of received changes from server
   */
  public trackReceivedChanges(changes: EntityChange[]): void {
    if (!changes || !Array.isArray(changes) || changes.length === 0) {
      this.logger.debug('No changes provided to trackReceivedChanges');
      return;
    }
    
    this.logger.info(`Tracking batch of ${changes.length} received changes`);
    
    // Count duplicates to reduce logging noise
    let duplicateCount = 0;
    let newChangeCount = 0;
    
    for (const change of changes) {
      if (!change || !change.id) {
        this.logger.debug('Invalid change object skipped');
        continue;
      }
      
      // Get a consistent change key
      const changeKey = this.getChangeKey(change);
      
      // Check if this change was already received (duplicate)
      if (this.receivedChanges.has(changeKey)) {
        // Add to duplicates
        if (!this.duplicateChanges.has(changeKey)) {
          this.duplicateChanges.set(changeKey, []);
        }
        this.duplicateChanges.get(changeKey)!.push(change);
        
        // Count but don't log each duplicate individually
        duplicateCount++;
      } else {
        // New change
        this.receivedChanges.set(changeKey, change);
        newChangeCount++;
      }
    }
    
    // Log summary of duplicates instead of individual messages
    if (duplicateCount > 0) {
      this.logger.warn(`Received ${duplicateCount} duplicate changes out of ${changes.length} total`);
    }
    
    this.logger.info(`Tracked ${newChangeCount} new changes, ignored ${duplicateCount} duplicates`);
  }
  
  /**
   * Get missing changes that were expected but not received
   */
  public getMissingChanges(): EntityChange[] {
    const missing: EntityChange[] = [];
    
    // Loop through expected changes and check if they were received
    for (const [changeKey, change] of this.expectedChanges.entries()) {
      if (!this.receivedChanges.has(changeKey)) {
        // Add safety check to ensure entity type is preserved
        if (!change.type) {
          this.logger.warn(`Expected change missing entity type: ${JSON.stringify(change)}`);
          // Try to infer the type from the change key
          const keyParts = changeKey.split(':');
          if (keyParts.length > 0) {
            this.logger.info(`Inferring entity type '${keyParts[0]}' from change key: ${changeKey}`);
            change.type = keyParts[0] as EntityType;
          }
        }
        
        missing.push(change);
      }
    }
    
    // Log summary
    if (missing.length > 0) {
      const byType: Record<string, number> = {};
      const byOperation: Record<string, number> = {};
      
      for (const change of missing) {
        // Safety check before incrementing counts
        const type = change.type || 'unknown';
        const operation = change.operation || 'unknown';
        
        byType[type] = (byType[type] || 0) + 1;
        byOperation[operation] = (byOperation[operation] || 0) + 1;
      }
      
      this.logger.warn(`❌ Validation failed! Missing ${missing.length} changes.`);
      this.logger.warn(`Missing by type: ${JSON.stringify(byType)}`);
      this.logger.warn(`Missing by operation: ${JSON.stringify(byOperation)}`);
    }
    
    return missing;
  }
  
  /**
   * Validate the changes to see if all expected changes were received
   */
  public validate(): ValidationResult {
    this.endTime = Date.now();
    const duration = this.endTime - this.startTime;
    
    this.logger.info(`Validating changes after ${duration}ms`);
    
    // Get the number of expected and received changes
    const totalExpected = this.expectedChanges.size;
    const totalReceived = this.receivedChanges.size;
    
    this.logger.info(`Expected: ${totalExpected}, Received: ${totalReceived}`);
    
    // Check for missing changes
    const missingChanges: MissingChangeReport[] = [];
    const missingEntities = this.getMissingChanges();
    
    for (const change of missingEntities) {
      // Ensure we have a type, use unknown if missing
      const entityType = change.type || 'unknown';
      const operation = change.operation || 'unknown';
      
      missingChanges.push({
        id: change.id,
        entityType, 
        operation,
        timestamp: change.timestamp || 0
      });
    }
    
    // Check for duplicate changes
    const duplicateChanges: DuplicateChangeReport[] = [];
    for (const [key, changes] of this.duplicateChanges.entries()) {
      if (changes.length > 0) {
        const change = changes[0];
        duplicateChanges.push({
          id: change.id,
          entityType: change.type || 'unknown',
          operation: change.operation || 'unknown',
          count: changes.length,
          timestamp: change.timestamp || 0
        });
      }
    }
    
    // Success is when we have no missing changes
    const success = missingChanges.length === 0;
    
    return {
      success,
      totalExpected,
      totalReceived,
      missingChanges,
      duplicateChanges,
      stats: this.stats,
      completedAt: new Date(this.endTime),
      duration
    };
  }
  
  /**
   * Get validation stats
   */
  public getStats(): ChangeStats {
    return { ...this.stats };
  }
  
  /**
   * Get a human-readable validation summary
   */
  public getSummary(): string {
    const result = this.validate();
    
    const summary = [
      `Validation Summary (Session: ${this.sessionId})`,
      `------------------------------------------`,
      `Result: ${result.success ? 'SUCCESS ✅' : 'FAILURE ❌'}`,
      `Duration: ${result.duration}ms`,
      `Expected Changes: ${result.totalExpected}`,
      `Received Changes: ${result.totalReceived}`,
      `Missing Changes: ${result.missingChanges.length}`,
      `Duplicate Changes: ${result.duplicateChanges.length}`,
      ``,
      `Changes By Type:`,
    ];
    
    // Add type breakdown
    for (const [type, count] of Object.entries(result.stats.byType)) {
      const received = Array.from(this.changesByType.get(type as EntityType) || [])
        .filter(key => this.receivedChanges.has(key)).length;
      
      summary.push(`  - ${type}: ${received}/${count} (${Math.round(received / count * 100)}%)`);
    }
    
    summary.push(``, `Changes By Operation:`);
    
    // Add operation breakdown
    for (const [op, count] of Object.entries(result.stats.byOperation)) {
      const received = Array.from(this.changesByOperation.get(op as Operation) || [])
        .filter(key => this.receivedChanges.has(key)).length;
      
      summary.push(`  - ${op}: ${received}/${count} (${Math.round(received / count * 100)}%)`);
    }
    
    // Add missing changes info if any
    if (result.missingChanges.length > 0) {
      summary.push(``, `Missing Changes (showing first 10):`);
      
      for (let i = 0; i < Math.min(10, result.missingChanges.length); i++) {
        const missing = result.missingChanges[i];
        summary.push(`  - ${missing.entityType}.${missing.operation}: ${missing.id}`);
      }
      
      if (result.missingChanges.length > 10) {
        summary.push(`  ... and ${result.missingChanges.length - 10} more`);
      }
    }
    
    return summary.join('\n');
  }
  
  /**
   * Check if a specific change was received
   */
  public wasChangeReceived(change: EntityChange): boolean {
    const changeKey = this.getChangeKey(change);
    return this.receivedChanges.has(changeKey);
  }
  
  /**
   * Get all expected changes by entity type
   */
  public getExpectedChangesByType(entityType: EntityType): EntityChange[] {
    const changes: EntityChange[] = [];
    
    if (!this.changesByType.has(entityType)) {
      return changes;
    }
    
    for (const changeKey of this.changesByType.get(entityType) || []) {
      const change = this.expectedChanges.get(changeKey);
      if (change) {
        changes.push(change);
      }
    }
    
    return changes;
  }
  
  /**
   * Get all missing changes by entity type
   */
  public getMissingChangesByType(entityType: EntityType): EntityChange[] {
    const missing: EntityChange[] = [];
    
    if (!this.changesByType.has(entityType)) {
      return missing;
    }
    
    for (const changeKey of this.changesByType.get(entityType) || []) {
      if (!this.receivedChanges.has(changeKey)) {
        const change = this.expectedChanges.get(changeKey);
        if (change) {
          missing.push(change);
        }
      }
    }
    
    return missing;
  }
  
  /**
   * Generate consistent change key for entity changes
   */
  private getChangeKey(change: EntityChange): string {
    if (!change || !change.id || !change.type || !change.operation) {
      this.stats.errors++;
      this.logger.error(`Invalid change object: ${JSON.stringify(change)}`);
      throw new Error('Invalid change object: missing required fields');
    }
    
    return `${change.type}:${change.id}:${change.operation}`;
  }
  
  /**
   * Set ID mapping for database verification
   * This allows the validation service to correctly verify IDs in the database
   * when synthetic IDs are used for tracking
   */
  public setIdMapping(mapping: Record<string, string>): void {
    this.idMapping = mapping || {};
    if (this.verbose) {
      this.logger.info(`Set ID mapping with ${Object.keys(this.idMapping).length} entries`);
    }
  }
  
  /**
   * Process verification result considering operation type
   * @param result Initial verification result
   * @returns Updated verification result with operation-aware validity
   */
  private processDatabaseVerificationResult(result: MissingChangeVerificationResult): MissingChangeVerificationResult {
    // For delete operations, entity SHOULD NOT exist in database if deletion was successful
    if (result.operation === 'delete') {
      return {
        ...result,
        // For deletes, NOT finding the entity means success, finding it means failure
        existsInDatabase: !result.existsInDatabase
      };
    }
    // For create/update operations, entity SHOULD exist in database
    return result;
  }
  
  /**
   * Verify missing changes against database
   */
  public async verifyMissingChangesInDatabase(
    missingChanges: EntityChange[],
    dbConnection: any
  ): Promise<MissingChangeVerificationResult[]> {
    if (!missingChanges || !missingChanges.length) {
      return [];
    }
    
    this.logger.info(`Verifying ${missingChanges.length} missing changes in database...`);
    
    // Group missing changes by entity type for efficient querying
    const changesByType: Record<string, EntityChange[]> = {};
    
    for (const missingChange of missingChanges) {
      // Skip if missing change has no type
      if (!missingChange.type) {
        this.logger.warn(`Missing type for change: ${JSON.stringify(missingChange)}`);
        continue;
      }
      
      const entityType = missingChange.type;
      if (!changesByType[entityType]) {
        changesByType[entityType] = [];
      }
      changesByType[entityType].push(missingChange);
    }
    
    // Get table mapping
    const tableMap: Record<string, string> = {
      task: 'tasks',
      project: 'projects',
      user: 'users',
      comment: 'comments'
    };
    
    // Verify each entity type in database
    const verificationResults: MissingChangeVerificationResult[] = [];
    
    for (const [entityType, changes] of Object.entries(changesByType)) {
      // Skip if we don't have a table mapping
      if (!tableMap[entityType]) {
        this.logger.warn(`No table mapping for entity type: ${entityType}`);
        continue;
      }
      
      const table = tableMap[entityType];
      
      // Use actual IDs directly instead of mapping synthetic IDs
      for (const change of changes) {
        if (!change.id || change.id === '') {
          this.logger.warn(`Missing ID for change: ${JSON.stringify(change)}`);
          continue;
        }
        
        try {
          // Use the checkEntityExists method from db-service
          let existsInDb = false;
          
          if (dbConnection.checkEntityExists) {
            // Use the helper method for better separation of concerns
            existsInDb = await dbConnection.checkEntityExists(table, change.id);
          } else if (dbConnection.verifyEntitiesExist) {
            // Backward compatibility with the deprecated method
            const existingIds = await dbConnection.verifyEntitiesExist(table, [change.id]);
            existsInDb = existingIds.includes(change.id);
          } else {
            // No database verification method available
            this.logger.warn('No database verification method available');
            verificationResults.push({
              change,
              existsInDatabase: false,
              verificationFailed: true,
              entityType: entityType as EntityType,
              operation: change.operation,
              error: 'Database verification methods not available'
            });
            continue;
          }
          
          // Create the base verification result
          const baseResult: MissingChangeVerificationResult = {
            change,
            existsInDatabase: existsInDb,
            entityType: entityType as EntityType,
            operation: change.operation
          };
          
          // Process result based on operation type
          const processedResult = this.processDatabaseVerificationResult(baseResult);
          verificationResults.push(processedResult);
          
          // Determine if entity is truly valid based on operation
          const isActuallyValid = 
            (change.operation === 'delete' && !existsInDb) || // Delete success: not in DB
            (change.operation !== 'delete' && existsInDb);
          
          if (this.verbose) {
            const status = isActuallyValid ? 'VALID' : 'INVALID';
            this.logger.info(`Change ${change.id} (${entityType}.${change.operation}): ${status} (DB existence: ${existsInDb ? 'TRUE' : 'FALSE'})`);
          }
        } catch (error) {
          this.logger.error(`Error verifying change in database: ${change.id} (${entityType}): ${error}`);
          
          // Add failed verification result
          verificationResults.push({
            change,
            existsInDatabase: false,
            verificationFailed: true,
            entityType: entityType as EntityType,
            operation: change.operation,
            error: String(error)
          });
        }
      }
    }
    
    return verificationResults;
  }
  
  /**
   * Generate detailed missing changes report with database verification
   */
  public async getDetailedMissingReport(
    dbConnection: any,
    tableMap: Record<EntityType, string>
  ): Promise<string> {
    const missingChanges = this.getMissingChanges();
    const dbVerification = await this.verifyMissingChangesInDatabase(missingChanges, dbConnection);
    const validationResult = this.validate();
    
    const summary = [
      `Detailed Missing Changes Report`,
      `------------------------------`,
      `Total Expected: ${validationResult.totalExpected}`,
      `Total Received: ${validationResult.totalReceived}`,
      `Missing: ${validationResult.missingChanges.length}`,
      ``
    ];
    
    // Group verification results by entity type
    const resultsByType: Record<string, MissingChangeVerificationResult[]> = {};
    
    for (const result of dbVerification) {
      if (!resultsByType[result.entityType]) {
        resultsByType[result.entityType] = [];
      }
      resultsByType[result.entityType].push(result);
    }
    
    // Add detailed breakdown by entity type
    if (Object.keys(resultsByType).length === 0) {
      summary.push(`No missing changes to verify`);
    } else {
      for (const [entityType, results] of Object.entries(resultsByType)) {
        summary.push(`${entityType}:`);
        
        // Group by operation
        const byOperation: Record<string, MissingChangeVerificationResult[]> = {};
        for (const result of results) {
          if (!byOperation[result.operation]) {
            byOperation[result.operation] = [];
          }
          byOperation[result.operation].push(result);
        }
        
        // Report by operation
        for (const [operation, opResults] of Object.entries(byOperation)) {
          summary.push(`  ${operation}:`);
          
          for (const result of opResults) {
            const status = result.verificationFailed 
              ? '❓ VERIFICATION FAILED' 
              : result.existsInDatabase 
                ? '✅ EXISTS IN DB'
                : '❌ MISSING FROM DB';
            
            // Simply display the change ID
            const idDisplay = result.change.id;
              
            summary.push(`    - ${idDisplay}: ${status}`);
          }
        }
        
        summary.push(``);
      }
    }
    
    return summary.join('\n');
  }
} 