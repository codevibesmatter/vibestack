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
 * ValidationService handles tracking and validating changes
 * between database operations and client receipts
 */
export class ValidationService {
  private logger = createLogger('Validation');
  private sessionId: string;
  
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
  constructor(options?: Partial<ValidationOptions>) {
    this.sessionId = uuidv4().substring(0, 8);
    
    if (options) {
      this.options = { ...this.options, ...options };
    }
    
    this.logger.info(`ValidationService created with session ID: ${this.sessionId}`);
    this.logger.info(`Options: ${JSON.stringify(this.options)}`);
    
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
    
    this.logger.debug(`Tracked expected change: ${changeKey} (type: ${change.type}, op: ${change.operation})`);
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
      this.trackExpectedChange(change);
    }
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
    
    this.logger.debug(`Tracked received change: ${changeKey} (type: ${change.type}, op: ${change.operation})`);
  }
  
  /**
   * Track a batch of received changes from the client
   */
  public trackReceivedChanges(changes: EntityChange[]): void {
    if (!changes || !Array.isArray(changes) || changes.length === 0) {
      this.logger.warn('No changes provided to trackReceivedChanges');
      return;
    }
    
    this.logger.info(`Tracking batch of ${changes.length} received changes`);
    
    for (const change of changes) {
      this.trackReceivedChange(change);
    }
  }
  
  /**
   * Validate changes to see if all expected changes were received
   */
  public validate(): ValidationResult {
    this.endTime = Date.now();
    const duration = this.endTime - this.startTime;
    
    this.logger.info(`Validating changes after ${duration}ms`);
    this.logger.info(`Expected: ${this.expectedChanges.size}, Received: ${this.receivedChanges.size}`);
    
    // Find missing changes
    const missingChanges: MissingChangeReport[] = [];
    
    for (const [changeKey, expectedChange] of this.expectedChanges.entries()) {
      if (!this.receivedChanges.has(changeKey)) {
        missingChanges.push({
          change: expectedChange,
          reason: 'Not received',
          timestamp: Date.now()
        });
      }
    }
    
    // Find duplicate changes
    const duplicateChangeReports: DuplicateChangeReport[] = [];
    
    for (const [changeKey, duplicates] of this.duplicateChanges.entries()) {
      const originalChange = this.receivedChanges.get(changeKey) || duplicates[0];
      
      for (const duplicate of duplicates) {
        duplicateChangeReports.push({
          change: duplicate,
          originalChange,
          timestamp: Date.now()
        });
      }
    }
    
    // Generate full validation result
    const result: ValidationResult = {
      success: missingChanges.length === 0,
      totalExpected: this.expectedChanges.size,
      totalReceived: this.receivedChanges.size,
      missingChanges,
      duplicateChanges: duplicateChangeReports,
      stats: { ...this.stats },
      completedAt: new Date(),
      duration
    };
    
    // Log validation results
    if (result.success) {
      this.logger.info(`✅ Validation successful! All ${result.totalExpected} changes received.`);
    } else {
      this.logger.warn(`❌ Validation failed! Missing ${missingChanges.length} changes.`);
      
      // Log detailed missing changes info by type and operation
      const missingByType: Record<string, number> = {};
      const missingByOp: Record<string, number> = {};
      
      for (const missing of missingChanges) {
        const type = missing.change.type;
        const op = missing.change.operation;
        
        missingByType[type] = (missingByType[type] || 0) + 1;
        missingByOp[op] = (missingByOp[op] || 0) + 1;
      }
      
      this.logger.warn(`Missing by type: ${JSON.stringify(missingByType)}`);
      this.logger.warn(`Missing by operation: ${JSON.stringify(missingByOp)}`);
    }
    
    return result;
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
        summary.push(`  - ${missing.change.type}.${missing.change.operation}: ${missing.change.id}`);
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
} 