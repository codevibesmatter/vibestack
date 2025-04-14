/**
 * Entity Changes - Validation Module V2
 * 
 * Provides validation utilities that interface directly with ChangeTracker
 * for validating entity changes across database and clients.
 * 
 * Enhanced with schema validation, reference validation, and pluggable validation rules.
 */

import { getDataSource } from './change-applier.ts';
import { createLogger } from '../logger.ts';
import { TableChangeTest, ValidationResult } from './types.ts';
import { ChangeTracker, globalChangeTracker } from './change-tracker.ts';
import { 
  EntityType, 
  TABLE_TO_ENTITY, 
  getEntityClass,
  EntityRelationship,
  getOutgoingRelationships,
  getIncomingRelationships,
  findRelationshipByInverseName
} from './entity-adapter.ts';
import { TableChange } from '@repo/sync-types';
import { validate, ValidationError, ValidatorOptions } from 'class-validator';
import { In } from 'typeorm';

// Create logger for this module
const logger = createLogger('entity-changes.validation');

// Types and interfaces for enhanced validation

/**
 * Schema validation options
 */
export interface SchemaValidationOptions extends ValidatorOptions {
  allowUnknownProperties?: boolean;
  requiredProperties?: string[];
  customValidators?: CustomValidator[];
}

/**
 * Reference validation options
 */
export interface ReferenceValidationOptions {
  checkRelatedEntities?: boolean;
  validateRelationships?: boolean;
  allowMissingReferences?: boolean;
  allowDanglingReferences?: boolean;
  customReferenceValidators?: CustomReferenceValidator[];
}

/**
 * Combined validation options
 */
export interface ValidationOptions {
  schema?: SchemaValidationOptions;
  reference?: ReferenceValidationOptions;
  intentionalDuplicates?: { original: TableChangeTest, duplicate: TableChangeTest }[];
  allowExtraChanges?: boolean;
}

/**
 * Custom validator function type
 */
export type CustomValidator = (
  entity: any, 
  entityType: EntityType, 
  operation: 'create' | 'update' | 'delete'
) => Promise<string[]>;

/**
 * Custom reference validator function type
 */
export type CustomReferenceValidator = (
  entity: any,
  entityType: EntityType,
  relatedEntities: Record<string, any[]>
) => Promise<string[]>;

/**
 * Detailed validation error format
 */
export interface DetailedValidationError {
  entityId: string;
  entityType: EntityType;
  property?: string;
  errors: string[];
  operation: string;
  severity: 'error' | 'warning';
}

/**
 * Extended validation result with detailed errors
 */
export interface DetailedValidationResult {
  success: boolean;
  errors: DetailedValidationError[];
  warnings: DetailedValidationError[];
  summary: {
    total: number;
    errors: number;
    warnings: number;
    byEntityType: Record<string, number>;
    byOperation: Record<string, number>;
  };
}

/**
 * Extended ValidationResult type with additional properties for sync validation
 */
export interface SyncValidationResult {
  success: boolean;
  summary: {
    total: {
      database: number;
      received: number;
      expected: number;
      intentionalDuplicates: number;
      deduplicationSuccess: boolean;
    };
    byTable: Record<string, {
      database: number;
      received: number;
      missing: number;
      extra: number;
    }>;
    byOperation: Record<string, {
      database: number;
      received: number;
      missing: number;
      extra: number;
    }>;
  };
  details: {
    missingChanges: TableChangeTest[];
    extraChanges: TableChangeTest[];
    intentionalDuplicates: { original: TableChangeTest, duplicate: TableChangeTest }[];
    deduplicatedChanges: { original: TableChangeTest, duplicate: TableChangeTest }[];
    receivedDuplicates: {original: TableChangeTest, duplicates: TableChangeTest[]}[];
  };
}

// Global registry for custom validators
const customValidators: CustomValidator[] = [];
const customReferenceValidators: CustomReferenceValidator[] = [];

/**
 * Register a custom validator
 * @param validator The custom validator to register
 */
export function registerCustomValidator(validator: CustomValidator): void {
  customValidators.push(validator);
  logger.info(`Registered custom validator, total: ${customValidators.length}`);
}

/**
 * Register a custom reference validator
 * @param validator The custom reference validator to register
 */
export function registerCustomReferenceValidator(validator: CustomReferenceValidator): void {
  customReferenceValidators.push(validator);
  logger.info(`Registered custom reference validator, total: ${customReferenceValidators.length}`);
}

/**
 * Clear all registered custom validators
 */
export function clearCustomValidators(): void {
  customValidators.length = 0;
  customReferenceValidators.length = 0;
  logger.info('Cleared all custom validators');
}

// SCHEMA VALIDATION FUNCTIONS

/**
 * Validate entity schema using class-validator enhanced with custom validation
 * @param entity The entity to validate
 * @param entityType The type of the entity
 * @param operation The operation being performed
 * @param options Validation options
 * @returns Array of validation error messages
 */
export async function validateEntitySchema(
  entity: any, 
  entityType: EntityType,
  operation: 'create' | 'update' | 'delete',
  options: SchemaValidationOptions = {}
): Promise<string[]> {
  const errors: string[] = [];
  
  try {
    // Use class-validator for standard validation
    const validationErrors = await validate(entity, options);
    
    if (validationErrors.length > 0) {
      errors.push(
        ...validationErrors.map(error => 
          `${error.property}: ${Object.values(error.constraints || {}).join(', ')}`
        )
      );
    }
    
    // Check for required properties
    if (options.requiredProperties && operation !== 'delete') {
      for (const prop of options.requiredProperties) {
        if (entity[prop] === undefined || entity[prop] === null) {
          errors.push(`${prop}: Property is required`);
        }
      }
    }
    
    // Check for unknown properties
    if (!options.allowUnknownProperties && operation !== 'delete') {
      const EntityClass = getEntityClass(entityType);
      const entity_instance = new EntityClass();
      const knownProps = Object.getOwnPropertyNames(entity_instance);
      
      // Also consider id as a known property
      knownProps.push('id');
      
      for (const prop in entity) {
        if (!knownProps.includes(prop) && !prop.startsWith('__')) {
          errors.push(`${prop}: Unknown property not defined in entity schema`);
        }
      }
    }
    
    // Apply custom validators
    const customValidatorsToApply = [
      ...(options.customValidators || []),
      ...customValidators
    ];
    
    for (const validator of customValidatorsToApply) {
      const customErrors = await validator(entity, entityType, operation);
      errors.push(...customErrors);
    }
    
    return errors;
  } catch (error) {
    logger.error(`Error validating entity schema: ${error}`);
    return [`Schema validation error: ${error}`];
  }
}

/**
 * Validate multiple entities' schemas
 * @param entities Entities to validate
 * @param entityType The type of the entities
 * @param operation The operation being performed
 * @param options Validation options
 * @returns Record of validation errors by entity ID
 */
export async function validateEntitiesSchema(
  entities: any[],
  entityType: EntityType,
  operation: 'create' | 'update' | 'delete',
  options: SchemaValidationOptions = {}
): Promise<Record<string, string[]>> {
  const validationErrors: Record<string, string[]> = {};
  
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    const errors = await validateEntitySchema(entity, entityType, operation, options);
    
    if (errors.length > 0) {
      const idOrIndex = entity.id || `index_${i}`;
      validationErrors[idOrIndex] = errors;
    }
  }
  
  return validationErrors;
}

// REFERENCE VALIDATION FUNCTIONS

/**
 * Get all relationships for an entity type (both incoming and outgoing)
 * @param entityType The entity type to get relationships for
 * @returns Record of relationships by property name
 */
function getEntityRelationships(entityType: EntityType): Record<string, EntityRelationship> {
  const outgoing = getOutgoingRelationships(entityType);
  const incoming = getIncomingRelationships(entityType);
  
  // Combine and index by property name
  const result: Record<string, EntityRelationship> = {};
  
  // Process outgoing relationships (where this entity is the source)
  for (const rel of outgoing) {
    if (rel.sourceField) {
      result[rel.sourceField] = rel;
    }
  }
  
  // Process incoming relationships (where this entity is the target)
  for (const rel of incoming) {
    if (rel.targetField) {
      result[rel.targetField] = rel;
    }
  }
  
  return result;
}

/**
 * Validate entity references based on relationships defined in entity-adapter
 * @param entity The entity to validate
 * @param entityType The type of the entity
 * @param options Reference validation options
 * @returns Array of validation error messages
 */
export async function validateEntityReferences(
  entity: any,
  entityType: EntityType,
  options: ReferenceValidationOptions = {}
): Promise<string[]> {
  if (!entity.id) {
    return ['Cannot validate references without entity ID'];
  }
  
  const errors: string[] = [];
  const dataSource = await getDataSource();
  const relationships = getEntityRelationships(entityType);
  
  // Skip if no relationships to validate
  if (!relationships || Object.keys(relationships).length === 0) {
    return [];
  }
  
  // Gather all referenced IDs to check
  const referencesToCheck: Record<EntityType, string[]> = {
    user: [],
    project: [],
    task: [],
    comment: []
  };
  
  // Find all referenced entities
  for (const [prop, rel] of Object.entries(relationships)) {
    const referencedId = entity[prop];
    if (referencedId && typeof referencedId === 'string') {
      referencesToCheck[rel.targetEntity].push(referencedId);
    }
  }
  
  // Check if all referenced entities exist
  const relatedEntities: Record<string, any[]> = {};
  
  for (const [refEntityType, ids] of Object.entries(referencesToCheck)) {
    if (ids.length === 0) continue;
    
    const refType = refEntityType as EntityType;
    const EntityClass = getEntityClass(refType);
    const repository = dataSource.getRepository(EntityClass);
    
    // Find all referenced entities in one query
    try {
      const foundEntities = await repository.find({
        where: { id: In(ids) }
      });
      
      // Store found entities for custom validators
      relatedEntities[refEntityType] = foundEntities;
      
      // Validation will be skipped if allowed by options
      if (options.allowMissingReferences) {
        continue;
      }
      
      // Create a set of found IDs for efficient lookup
      const foundIds = new Set<string>(foundEntities.map(e => e.id));
      
      // Check if all referenced IDs were found
      for (const [prop, rel] of Object.entries(relationships)) {
        if (rel.targetEntity === refType) {
          const referencedId = entity[prop];
          if (referencedId && !foundIds.has(referencedId)) {
            errors.push(`${prop}: Referenced ${refEntityType} with ID ${referencedId} does not exist`);
          }
        }
      }
    } catch (error) {
      logger.error(`Error checking references for ${refEntityType}: ${error}`);
      errors.push(`Reference check error for ${refEntityType}: ${error}`);
    }
  }
  
  // Apply custom reference validators
  const customRefsToApply = [
    ...(options.customReferenceValidators || []),
    ...customReferenceValidators
  ];
  
  for (const validator of customRefsToApply) {
    const customErrors = await validator(entity, entityType, relatedEntities);
    errors.push(...customErrors);
  }
  
  return errors;
}

/**
 * Validate multiple entities' references
 * @param entities Entities to validate
 * @param entityType The type of the entities
 * @param options Reference validation options
 * @returns Record of validation errors by entity ID
 */
export async function validateEntitiesReferences(
  entities: any[],
  entityType: EntityType,
  options: ReferenceValidationOptions = {}
): Promise<Record<string, string[]>> {
  const validationErrors: Record<string, string[]> = {};
  
  for (const entity of entities) {
    if (!entity.id) continue;
    
    const errors = await validateEntityReferences(entity, entityType, options);
    
    if (errors.length > 0) {
      validationErrors[entity.id] = errors;
    }
  }
  
  return validationErrors;
}

/**
 * Validate changes from different perspectives
 * @param arg1 First argument - could be an array of changes to validate or database changes
 * @param arg2 Optional second argument - could be client changes or options
 * @param arg3 Optional third argument - options when first two are dbChanges and clientChanges
 * @returns Validation result with appropriate structure based on arguments
 */
export async function validateChanges(
  arg1: TableChangeTest[] | TableChange[],
  arg2?: ValidationOptions | TableChange[],
  arg3?: ValidationOptions
): Promise<DetailedValidationResult | SyncValidationResult> {
  // Case 1: Single array of changes with validation options
  if (!arg2 || typeof arg2 === 'object' && !Array.isArray(arg2)) {
    const changes = arg1 as TableChangeTest[];
    const options = arg2 as ValidationOptions || {};
    
    return validateEntitiesWithSchema(changes, options);
  }
  
  // Case 2: Database changes and client changes with options
  const dbChanges = arg1 as TableChangeTest[];
  const clientChanges = arg2 as TableChange[];
  const options = arg3 || {};
  
  // Call the sync validation function
  return validateSyncChanges(dbChanges, clientChanges, options);
}

/**
 * Internal function for validating entities with schema
 */
async function validateEntitiesWithSchema(
  changes: TableChangeTest[],
  options: ValidationOptions = {}
): Promise<DetailedValidationResult> {
  if (!changes.length) {
    return {
      success: true,
      errors: [],
      warnings: [],
      summary: {
        total: 0,
        errors: 0,
        warnings: 0,
        byEntityType: {},
        byOperation: {}
      }
    };
  }
  
  logger.info(`Validating ${changes.length} changes with enhanced validation`);
  
  // Group changes by entity type and operation for more efficient validation
  const changesByEntityType: Record<EntityType, {
    create: TableChangeTest[],
    update: TableChangeTest[],
    delete: TableChangeTest[]
  }> = {
    user: { create: [], update: [], delete: [] },
    project: { create: [], update: [], delete: [] },
    task: { create: [], update: [], delete: [] },
    comment: { create: [], update: [], delete: [] }
  };
  
  // Organize changes by entity type and operation
  for (const change of changes) {
    const entityType = TABLE_TO_ENTITY[change.table];
    if (!entityType) continue;
    
    const operation = change.operation;
    if (operation === 'insert') {
      changesByEntityType[entityType].create.push(change);
    } else if (operation === 'update') {
      changesByEntityType[entityType].update.push(change);
    } else if (operation === 'delete') {
      changesByEntityType[entityType].delete.push(change);
    }
  }
  
  // Collect validation errors and warnings
  const errors: DetailedValidationError[] = [];
  const warnings: DetailedValidationError[] = [];
  
  // Validate all entity types
  for (const entityType of Object.keys(changesByEntityType) as EntityType[]) {
    for (const [operation, opChanges] of Object.entries(changesByEntityType[entityType])) {
      if (opChanges.length === 0) continue;
      
      // Map operation to the right type for schema validation
      const opType = operation === 'insert' ? 'create' : 
                    operation === 'update' ? 'update' : 'delete';
      
      // Extract entity data from changes
      const entities = opChanges.map(change => change.data);
      
      // Validate schema if requested
      if (options.schema) {
        const schemaErrors = await validateEntitiesSchema(
          entities,
          entityType,
          opType as 'create' | 'update' | 'delete',
          options.schema
        );
        
        // Process schema validation errors
        for (const [entityId, entityErrors] of Object.entries(schemaErrors)) {
          errors.push({
            entityId,
            entityType,
            errors: entityErrors,
            operation,
            severity: 'error'
          });
        }
      }
      
      // Validate references if requested and not a delete operation
      if (options.reference && operation !== 'delete') {
        const referenceErrors = await validateEntitiesReferences(
          entities,
          entityType,
          options.reference
        );
        
        // Process reference validation errors
        for (const [entityId, entityErrors] of Object.entries(referenceErrors)) {
          // Reference errors can be warnings if allowMissingReferences is true
          const severity = options.reference.allowMissingReferences ? 'warning' : 'error';
          
          (severity === 'error' ? errors : warnings).push({
            entityId,
            entityType,
            errors: entityErrors,
            operation,
            severity
          });
        }
      }
    }
  }
  
  // Count errors and warnings by entity type and operation
  const byEntityType: Record<string, number> = {};
  const byOperation: Record<string, number> = {};
  
  for (const error of errors) {
    byEntityType[error.entityType] = (byEntityType[error.entityType] || 0) + 1;
    byOperation[error.operation] = (byOperation[error.operation] || 0) + 1;
  }
  
  const success = errors.length === 0;
  
  // Log validation summary
  logger.info(`Validation ${success ? 'succeeded' : 'failed'} with ${errors.length} errors and ${warnings.length} warnings`);
  
  if (errors.length > 0) {
    logger.error(`Validation errors by entity type:`);
    Object.entries(byEntityType).forEach(([entityType, count]) => {
      if (count > 0) {
        logger.error(`- ${entityType}: ${count} errors`);
      }
    });
  }
  
  return {
    success,
    errors,
    warnings,
    summary: {
      total: changes.length,
      errors: errors.length,
      warnings: warnings.length,
      byEntityType,
      byOperation
    }
  };
}

/**
 * Validate that client-received changes match database changes tracked by ChangeTracker
 * 
 * @param clientReceived Changes received by the client
 * @param tracker ChangeTracker instance (defaults to global)
 * @returns Validation result with summary and details
 */
export async function validateClientChanges(
  clientReceived: TableChangeTest[],
  tracker: ChangeTracker = globalChangeTracker
): Promise<ValidationResult> {
  logger.info(`Validating ${clientReceived.length} client-received changes against ChangeTracker`);
  
  // Get all applied changes from the tracker
  const databaseChanges = tracker.getAllAppliedChanges();
  const intentionalDuplicates = tracker.getIntentionalDuplicates();
  
  // Create maps for efficient lookup
  const databaseChangeMap = new Map<string, TableChangeTest>();
  const clientChangeMap = new Map<string, TableChangeTest>();
  
  // Initialize counters for the summary
  const byTable: Record<string, {
    database: number;
    received: number;
    missing: number;
    extra: number;
  }> = {};
  
  const byOperation: Record<string, {
    database: number;
    received: number;
    missing: number;
    extra: number;
  }> = {};
  
  // Create a set of intentional duplicate keys for quick lookup
  const intentionalDuplicateKeys = new Set<string>();
  for (const change of intentionalDuplicates) {
    if (change.data?.id) {
      const key = `${change.table}:${change.operation}:${change.data.id}`;
      intentionalDuplicateKeys.add(key);
    }
  }
  
  // Index database changes
  for (const change of databaseChanges) {
    if (change.data?.id) {
      const key = `${change.table}:${change.operation}:${change.data.id}`;
      databaseChangeMap.set(key, change as TableChangeTest);
      
      // Initialize or update table counters
      if (!byTable[change.table || 'unknown']) {
        byTable[change.table || 'unknown'] = { database: 0, received: 0, missing: 0, extra: 0 };
      }
      byTable[change.table || 'unknown'].database++;
      
      // Initialize or update operation counters
      if (!byOperation[change.operation || 'unknown']) {
        byOperation[change.operation || 'unknown'] = { database: 0, received: 0, missing: 0, extra: 0 };
      }
      byOperation[change.operation || 'unknown'].database++;
    }
  }
  
  // Index client changes
  for (const change of clientReceived) {
    if (change.data?.id) {
      const key = `${change.table}:${change.operation}:${change.data.id}`;
      clientChangeMap.set(key, change);
      
      // Initialize or update table counters
      if (!byTable[change.table || 'unknown']) {
        byTable[change.table || 'unknown'] = { database: 0, received: 0, missing: 0, extra: 0 };
      }
      byTable[change.table || 'unknown'].received++;
      
      // Initialize or update operation counters
      if (!byOperation[change.operation || 'unknown']) {
        byOperation[change.operation || 'unknown'] = { database: 0, received: 0, missing: 0, extra: 0 };
      }
      byOperation[change.operation || 'unknown'].received++;
    }
  }
  
  // Find missing changes (in database but not received by client)
  const missingChanges: TableChangeTest[] = [];
  for (const [key, change] of databaseChangeMap.entries()) {
    if (!clientChangeMap.has(key) && !intentionalDuplicateKeys.has(key)) {
      missingChanges.push(change);
      
      // Update missing counters
      if (change.table) {
        byTable[change.table].missing++;
      }
      if (change.operation) {
        byOperation[change.operation].missing++;
      }
    }
  }
  
  // Find extra changes (received by client but not in database)
  const extraChanges: TableChangeTest[] = [];
  for (const [key, change] of clientChangeMap.entries()) {
    if (!databaseChangeMap.has(key)) {
      extraChanges.push(change);
      
      // Update extra counters
      if (change.table) {
        byTable[change.table].extra++;
      }
      if (change.operation) {
        byOperation[change.operation].extra++;
      }
    }
  }
  
  // Log validation summary
  logger.info(`Validation summary:`);
  logger.info(`- Database changes: ${databaseChanges.length}`);
  logger.info(`- Client received: ${clientReceived.length}`);
  logger.info(`- Missing changes: ${missingChanges.length}`);
  logger.info(`- Extra changes: ${extraChanges.length}`);
  logger.info(`- Intentional duplicates: ${intentionalDuplicates.length}`);
  
  const success = missingChanges.length === 0;
  if (success) {
    logger.info(`✅ Validation successful - client has all expected changes`);
  } else {
    logger.warn(`❌ Validation failed - ${missingChanges.length} changes missing`);
    
    // Log missing changes by table
    const missingByTable = missingChanges.reduce((acc, change) => {
      const table = change.table || 'unknown';
      acc[table] = (acc[table] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    Object.entries(missingByTable).forEach(([table, count]) => {
      logger.warn(`  - Missing ${count} ${table} changes`);
    });
  }
  
  return {
    success,
    summary: {
      total: {
        database: databaseChanges.length,
        received: clientReceived.length
      },
      byTable,
      byOperation,
      intentionalDuplicates: intentionalDuplicates.length
    },
    details: {
      missingChanges,
      extraChanges,
      intentionalDuplicates: intentionalDuplicates as TableChangeTest[]
    }
  };
}

/**
 * Validate changes with batch ID were properly recorded in the database
 * 
 * @param batchId The batch ID to validate
 * @param tracker ChangeTracker instance (defaults to global)
 * @returns Validation results with success status
 */
export async function validateBatchChanges(
  batchId: string,
  tracker: ChangeTracker = globalChangeTracker
): Promise<{
  success: boolean;
  batchId: string;
  summary: {
    total: number;
    byTable: Record<string, number>;
    byOperation: Record<string, number>;
  };
  trackerChanges: TableChangeTest[];
  databaseRecords: Record<EntityType, any[]>;
}> {
  if (!batchId) {
    logger.warn('No batch ID provided for validation');
    return {
      success: false,
      batchId: '',
      summary: {
        total: 0,
        byTable: {},
        byOperation: {}
      },
      trackerChanges: [],
      databaseRecords: {
        user: [],
        project: [],
        task: [],
        comment: []
      }
    };
  }

  logger.info(`Validating changes for batch ID: ${batchId}`);

  // Get data source for database queries
  const dataSource = await getDataSource();
  
  // Get tracked changes for this batch from the tracker
  const trackerChanges = tracker.getAppliedChangesForBatch(batchId) as TableChangeTest[];
  
  // Query the database for records with this batch ID
  const tables = ['users', 'projects', 'tasks', 'comments'];
  const databaseRecords: Record<EntityType, any[]> = {
    user: [],
    project: [],
    task: [],
    comment: []
  };
  
  // Try to find entities in each table
  for (const table of tables) {
    try {
      // For inserts and updates, we can find entities with __batchId
      const entities = await dataSource.query(
        `SELECT * FROM "${table}" WHERE "__batchId" = $1`,
        [batchId]
      );
      
      if (entities.length > 0) {
        const entityType = getEntityTypeFromTable(table);
        if (entityType) {
          databaseRecords[entityType] = entities;
        }
      }
    } catch (error) {
      // If the table doesn't have __batchId column, we'll get an error
      // This is expected for some tables, so just log a debug message
      logger.debug(`Could not query ${table} for batch ID: ${error}`);
    }
  }
  
  // Generate summary by table and operation
  const byTable: Record<string, number> = {};
  const byOperation: Record<string, number> = {};
  
  trackerChanges.forEach(change => {
    // Count by table
    const table = change.table || 'unknown';
    byTable[table] = (byTable[table] || 0) + 1;
    
    // Count by operation
    const operation = change.operation || 'unknown';
    byOperation[operation] = (byOperation[operation] || 0) + 1;
  });
  
  // Count database records found
  const totalDatabaseRecords = Object.values(databaseRecords)
    .reduce((sum, records) => sum + records.length, 0);
  
  // Validation logic
  const success = trackerChanges.length > 0 && totalDatabaseRecords > 0;
  
  // Log summary
  logger.info(`Found ${trackerChanges.length} tracked changes and ${totalDatabaseRecords} database records for batch ${batchId}`);
  Object.entries(byTable).forEach(([table, count]) => {
    logger.info(`  ${table}: ${count} changes`);
  });
  
  return {
    success,
    batchId,
    summary: {
      total: trackerChanges.length,
      byTable,
      byOperation
    },
    trackerChanges,
    databaseRecords
  };
}

/**
 * Validate database changes directly by checking database records
 * 
 * @param changes Array of TableChange objects to validate in the database
 * @returns Validation results with success status
 */
export async function validateDatabaseChanges(changes: TableChangeTest[]): Promise<{
  success: boolean;
  summary: {
    total: number;
    byTable: Record<string, number>;
    byOperation: Record<string, number>;
  };
  details: {
    verified: TableChangeTest[];
    notVerified: TableChangeTest[];
  };
}> {
  if (!changes.length) {
    logger.warn('No changes to validate');
    return {
      success: true,
      summary: {
        total: 0,
        byTable: {},
        byOperation: {}
      },
      details: {
        verified: [],
        notVerified: []
      }
    };
  }

  logger.info(`Validating ${changes.length} changes in the database`);

  // Get data source
  const dataSource = await getDataSource();
  
  // Group changes by table and operation for easier validation
  const changesByTable: Record<string, TableChangeTest[]> = {};
  const changesByOperation: Record<string, number> = {
    insert: 0,
    update: 0,
    delete: 0
  };
  
  // Track validation results
  const verified: TableChangeTest[] = [];
  const notVerified: TableChangeTest[] = [];
  
  // Organize changes by table
  for (const change of changes) {
    if (!change.table || !change.operation) continue;
    
    if (!changesByTable[change.table]) {
      changesByTable[change.table] = [];
    }
    
    changesByTable[change.table].push(change);
    changesByOperation[change.operation] = (changesByOperation[change.operation] || 0) + 1;
  }
  
  // Log summary of changes to validate
  logger.info('Changes to validate by table:');
  Object.entries(changesByTable).forEach(([table, tableChanges]) => {
    logger.info(`  ${table}: ${tableChanges.length} changes`);
  });
  
  // Validate each change by checking the database
  for (const [table, tableChanges] of Object.entries(changesByTable)) {
    logger.info(`Validating ${tableChanges.length} changes for table ${table}`);
    
    // Group changes by operation for this table
    const insertChanges = tableChanges.filter(c => c.operation === 'insert');
    const updateChanges = tableChanges.filter(c => c.operation === 'update');
    const deleteChanges = tableChanges.filter(c => c.operation === 'delete');
    
    // Validate inserts and updates by checking if records exist
    if (insertChanges.length > 0 || updateChanges.length > 0) {
      const idsToCheck = [
        ...insertChanges.map(c => c.data?.id).filter(Boolean),
        ...updateChanges.map(c => c.data?.id).filter(Boolean)
      ];
      
      if (idsToCheck.length > 0) {
        try {
          // Check if these records exist in the database
          const found = await dataSource.query(
            `SELECT id FROM "${table}" WHERE id IN (${idsToCheck.map((_, i) => `$${i+1}`).join(',')})`,
            idsToCheck
          );
          
          // Map of found IDs for quick lookup
          const foundIds = new Set(found.map((row: any) => row.id));
          
          // Mark changes as verified if their IDs were found
          for (const change of [...insertChanges, ...updateChanges]) {
            if (change.data?.id && foundIds.has(change.data.id)) {
              verified.push(change);
            } else {
              notVerified.push(change);
            }
          }
          
          logger.info(`  ${foundIds.size}/${idsToCheck.length} records verified for inserts/updates in ${table}`);
        } catch (error) {
          logger.error(`Error validating inserts/updates for ${table}: ${error}`);
          notVerified.push(...insertChanges, ...updateChanges);
        }
      }
    }
    
    // Validate deletes by checking that records DON'T exist
    if (deleteChanges.length > 0) {
      const idsToCheck = deleteChanges.map(c => c.data?.id).filter(Boolean);
      
      if (idsToCheck.length > 0) {
        try {
          // Check how many of these records still exist (should be 0 if properly deleted)
          const found = await dataSource.query(
            `SELECT id FROM "${table}" WHERE id IN (${idsToCheck.map((_, i) => `$${i+1}`).join(',')})`,
            idsToCheck
          );
          
          // Map of found IDs for quick lookup
          const foundIds = new Set(found.map((row: any) => row.id));
          
          // Mark deletes as verified if their IDs were NOT found (they should be deleted)
          for (const change of deleteChanges) {
            if (change.data?.id && !foundIds.has(change.data.id)) {
              verified.push(change);
            } else {
              notVerified.push(change);
            }
          }
          
          const verifiedCount = idsToCheck.length - foundIds.size;
          logger.info(`  ${verifiedCount}/${idsToCheck.length} records verified for deletes in ${table}`);
        } catch (error) {
          logger.error(`Error validating deletes for ${table}: ${error}`);
          notVerified.push(...deleteChanges);
        }
      }
    }
  }
  
  // Generate summary information
  const byTable: Record<string, number> = {};
  Object.entries(changesByTable).forEach(([table, tableChanges]) => {
    byTable[table] = tableChanges.length;
  });
  
  // Calculate success percentage
  const successPercentage = changes.length > 0 
    ? Math.round((verified.length / changes.length) * 100) 
    : 100;
  
  logger.info(`Validation complete: ${verified.length}/${changes.length} changes verified (${successPercentage}%)`);
  
  return {
    success: verified.length === changes.length,
    summary: {
      total: changes.length,
      byTable,
      byOperation: changesByOperation
    },
    details: {
      verified,
      notVerified
    }
  };
}

/**
 * Validate that client received all expected changes from database, with support for intentional duplicates
 * 
 * @param dbChanges Database changes that were applied
 * @param clientChanges Changes received by the client
 * @param options Validation options
 * @returns Validation result with summary and details
 */
export async function validateSyncChanges(
  dbChanges: TableChangeTest[],
  clientChanges: TableChange[],
  options: {
    intentionalDuplicates?: { original: TableChangeTest, duplicate: TableChangeTest }[];
    allowExtraChanges?: boolean;
  } = {}
): Promise<SyncValidationResult> {
  logger.info(`Validating ${clientChanges.length} client-received changes against ${dbChanges.length} database changes`);
  
  const intentionalDuplicates = options.intentionalDuplicates || [];
  const allowExtraChanges = options.allowExtraChanges || false;
  
  // Create maps for efficient lookup
  const dbChangeMap = new Map<string, TableChangeTest>();
  const clientChangeMap = new Map<string, TableChangeTest>();
  
  // Track duplicates received by client (same change received multiple times)
  const clientDuplicatesMap = new Map<string, TableChangeTest[]>();
  const receivedDuplicates: {original: TableChangeTest, duplicates: TableChangeTest[]}[] = [];
  
  // Initialize counters for the summary
  const byTable: Record<string, {
    database: number;
    received: number;
    missing: number;
    extra: number;
  }> = {};
  
  const byOperation: Record<string, {
    database: number;
    received: number;
    missing: number;
    extra: number;
  }> = {};
  
  // Create a set of intentional duplicate keys for quick lookup
  const intentionalDuplicateKeys = new Set<string>();
  for (const dup of intentionalDuplicates) {
    if (dup.duplicate?.data?.id) {
      const key = `${dup.duplicate.table}:${dup.duplicate.operation}:${dup.duplicate.data.id}`;
      intentionalDuplicateKeys.add(key);
    }
  }
  
  // Process database changes
  for (const change of dbChanges) {
    if (!change.table || !change.operation || !change.data?.id) {
      logger.warn(`Skipping invalid database change without table, operation, or ID: ${JSON.stringify(change)}`);
      continue;
    }
    
    // Initialize table counters if needed
    if (!byTable[change.table]) {
      byTable[change.table] = { database: 0, received: 0, missing: 0, extra: 0 };
    }
    byTable[change.table].database++;
    
    // Initialize operation counters if needed
    if (!byOperation[change.operation]) {
      byOperation[change.operation] = { database: 0, received: 0, missing: 0, extra: 0 };
    }
    byOperation[change.operation].database++;
    
    // Create a unique key for the change
    const key = `${change.table}:${change.operation}:${change.data.id}`;
    dbChangeMap.set(key, change);
  }
  
  // Process client changes
  for (const change of clientChanges) {
    if (!change.table || !change.operation || !change.data?.id) {
      logger.warn(`Skipping invalid client change without table, operation, or ID: ${JSON.stringify(change)}`);
      continue;
    }
    
    // Initialize table counters if needed
    if (!byTable[change.table]) {
      byTable[change.table] = { database: 0, received: 0, missing: 0, extra: 0 };
    }
    byTable[change.table].received++;
    
    // Initialize operation counters if needed
    if (!byOperation[change.operation]) {
      byOperation[change.operation] = { database: 0, received: 0, missing: 0, extra: 0 };
    }
    byOperation[change.operation].received++;
    
    // Create a unique key for the change
    const key = `${change.table}:${change.operation}:${change.data.id}`;
    
    // Check if we've already seen this change from the client
    if (clientChangeMap.has(key)) {
      // Track duplicates
      if (!clientDuplicatesMap.has(key)) {
        clientDuplicatesMap.set(key, [clientChangeMap.get(key) as TableChangeTest]);
      }
      clientDuplicatesMap.get(key)?.push(change as TableChangeTest);
    } else {
      clientChangeMap.set(key, change as TableChangeTest);
    }
  }
  
  // Process received duplicates
  for (const [key, duplicates] of clientDuplicatesMap.entries()) {
    const original = duplicates.shift() as TableChangeTest;
    receivedDuplicates.push({
      original,
      duplicates
    });
    
    logger.warn(`Found duplicate change received ${duplicates.length + 1} times: ${key}`);
  }
  
  // Find missing changes (in database but not in client)
  const missingChanges: TableChangeTest[] = [];
  for (const [key, change] of dbChangeMap.entries()) {
    if (!clientChangeMap.has(key) && !intentionalDuplicateKeys.has(key)) {
      missingChanges.push(change);
      
      // Update missing counters
      if (change.table) {
        byTable[change.table].missing++;
      }
      if (change.operation) {
        byOperation[change.operation].missing++;
      }
    }
  }
  
  // Find extra changes (received by client but not in database)
  const extraChanges: TableChangeTest[] = [];
  for (const [key, change] of clientChangeMap.entries()) {
    if (!dbChangeMap.has(key)) {
      extraChanges.push(change);
      
      // Update extra counters
      if (change.table) {
        byTable[change.table].extra++;
      }
      if (change.operation) {
        byOperation[change.operation].extra++;
      }
    }
  }
  
  // Calculate deduplicated changes (intentional duplicates that were successfully deduplicated by server)
  const deduplicatedChanges = intentionalDuplicates.filter(dup => {
    if (dup.duplicate?.data?.id) {
      const key = `${dup.duplicate.table}:${dup.duplicate.operation}:${dup.duplicate.data.id}`;
      return !clientChangeMap.has(key);
    }
    return false;
  });
  
  // Check if any of the intentional duplicates are hard to identify because they lack explicit markers
  for (const dup of intentionalDuplicates) {
    if (!dup.duplicate?.data?.__intentionalDuplicate) {
      logger.warn(`Intentional duplicate lacks an explicit marker: ${dup.duplicate?.data?.id}`);
    }
  }
  
  // Calculate deduplication success rate - all duplicates are accounted for if:
  // 1. We have the proper number of changes (matching count minus dupes)
  // 2. We don't have any missing essential changes
  const expectedCountWithoutDuplicates = dbChanges.length - intentionalDuplicates.length;
  const deduplicationResult = analyzeDeduplication(
    dbChanges.length,
    clientChanges.length,
    deduplicatedChanges.length,
    missingChanges.length
  );
  
  // Determine if validation succeeded
  let success = deduplicationResult.success;
  
  // If extra changes are allowed, ignore them for determining success
  if (allowExtraChanges && extraChanges.length > 0) {
    if (missingChanges.length === 0) {
      logger.info('✅ Validation successful - client has all expected changes');
      if (extraChanges.length > 0) {
        logger.warn(`  - Extra ${extraChanges.length} changes allowed`);
        
        // Group extra changes by table for cleaner reporting
        const extraByTable = extraChanges.reduce((acc, change) => {
          const table = change.table || 'unknown';
          acc[table] = (acc[table] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        
        Object.entries(extraByTable).forEach(([table, count]) => {
          logger.warn(`  - Extra ${count} ${table} changes`);
        });
      }
    }
  } else if (success && extraChanges.length > 0) {
    logger.warn(`⚠️ Client received ${extraChanges.length} unexpected extra changes`);
    
    // Only mark as failure if extra changes should fail the validation
    if (!allowExtraChanges) {
      success = false;
    }
  }
  
  // Log validation status
  const statusSymbol = success ? '✅' : '❌';
  logger.info(`Validation ${success ? '✅ SUCCESS' : '❌ FAILURE'}: DB=${dbChanges.length}, Client=${clientChanges.length}, ` +
    `Missing=${missingChanges.length}, Extra=${extraChanges.length}, ` +
    `Dupes=${intentionalDuplicates.length}, Dedup=${deduplicationResult.success ? 'Yes' : 'No'}, ` +
    `Unintended dupes=${receivedDuplicates.length} (${receivedDuplicates.reduce((sum, rd) => sum + rd.duplicates.length, 0)} copies)`);
  
  // Display more details if validation failed
  if (!success) {
    logger.error(`❌ Validation failed - ${missingChanges.length} required changes missing from client`);
    
    // Only log missing changes by table if there are any
    if (missingChanges.length > 0) {
      const missingByTable = missingChanges.reduce((acc, change) => {
        const table = change.table || 'unknown';
        acc[table] = (acc[table] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      Object.entries(missingByTable).forEach(([table, count]) => {
        logger.error(`  - Missing ${count} ${table} changes`);
      });
    }
  }
  
  // Only log extra changes in detail if there are any and only at warning level
  if (extraChanges.length > 0) {
    logger.info('\nExtra Changes:');
    logDetailedChangesTable('Extra Changes', extraChanges);
  }
  
  // Return validation result with full details
  return {
    success,
    summary: {
      total: {
        database: dbChanges.length,
        received: clientChanges.length,
        expected: expectedCountWithoutDuplicates,
        intentionalDuplicates: intentionalDuplicates.length,
        deduplicationSuccess: deduplicationResult.success
      },
      byTable,
      byOperation
    },
    details: {
      missingChanges,
      extraChanges,
      intentionalDuplicates,
      deduplicatedChanges,
      receivedDuplicates
    }
  };
}

/**
 * Helper function to analyze deduplication results
 */
function analyzeDeduplication(
  dbCount: number,
  clientCount: number,
  intentionalDuplicatesCount: number,
  missingCount: number
): { success: boolean; expected: number; clientCount: number; intentionalDuplicatesCount: number } {
  const expected = dbCount - intentionalDuplicatesCount;
  const success = clientCount === expected && missingCount === 0;
  
  return {
    success,
    expected,
    clientCount,
    intentionalDuplicatesCount
  };
}

/**
 * Helper function to convert table name to entity type
 */
function getEntityTypeFromTable(table: string): EntityType | undefined {
  return TABLE_TO_ENTITY[table];
}

/**
 * Helper function to log a detailed table of changes
 * @param title Title for the table
 * @param changes Array of changes to display
 */
function logDetailedChangesTable(title: string, changes: TableChangeTest[]): void {
  if (changes.length === 0) return;
  
  logger.info(`\n${title}:`);
  logger.info('┌────────────┬──────────┬──────────────────────────────────┬────────────────┐');
  logger.info('│ Table      │ Operation│ Entity ID                        │ Batch ID       │');
  logger.info('├────────────┼──────────┼──────────────────────────────────┼────────────────┤');
  
  changes.slice(0, 20).forEach(change => {
    const table = (change.table || 'unknown').padEnd(10);
    const operation = (change.operation || 'unknown').padEnd(8);
    const id = (change.data?.id || 'no-id').toString().padEnd(32);
    const batchId = (change.batchId || 'no-batch').toString().padEnd(12);
    
    logger.info(`│ ${table} │ ${operation} │ ${id} │ ${batchId} │`);
  });
  
  if (changes.length > 20) {
    logger.info('├────────────┴──────────┴──────────────────────────────────┴────────────────┤');
    logger.info(`│ ... and ${changes.length - 20} more changes (showing first 20 only)`.padEnd(77) + '│');
  }
  
  logger.info('└────────────┴──────────┴──────────────────────────────────┴────────────────┘\n');
}

/**
 * Look up extra changes in the database change tables for additional context
 * @param extraChanges The extra changes that were not in the original database changes
 * @returns Detailed information about where these changes came from
 */
export async function lookupExtraChangesDetails(
  extraChanges: TableChangeTest[]
): Promise<{
  historyFound: TableChangeTest[];
  entityDataFound: Record<string, any[]>;
  unmatchedChanges: TableChangeTest[];
  details: Record<string, any>;
}> {
  if (extraChanges.length === 0) {
    return {
      historyFound: [],
      entityDataFound: {},
      unmatchedChanges: [],
      details: {}
    };
  }

  logger.info(`Looking up ${extraChanges.length} extra changes in database change tables`);
  
  const dataSource = await getDataSource();
  const historyFound: TableChangeTest[] = [];
  const entityDataFound: Record<string, any[]> = {};
  const unmatchedChanges: TableChangeTest[] = [];
  const details: Record<string, any> = {};
  
  // Extract all entity IDs from extra changes
  const entityIds = extraChanges
    .map(change => change.data?.id)
    .filter(Boolean) as string[];
  
  if (entityIds.length === 0) {
    logger.warn('No entity IDs found in extra changes');
    return {
      historyFound: [],
      entityDataFound: {},
      unmatchedChanges: extraChanges,
      details: {}
    };
  }
  
  // Group extra changes by table to look up entity data
  const changesByTable: Record<string, TableChangeTest[]> = {};
  for (const change of extraChanges) {
    if (change.table) {
      if (!changesByTable[change.table]) {
        changesByTable[change.table] = [];
      }
      changesByTable[change.table].push(change);
    }
  }
  
  // Query each entity table for actual entity data
  for (const [tableName, changes] of Object.entries(changesByTable)) {
    const tableEntityIds = changes
      .map(change => change.data?.id)
      .filter(Boolean) as string[];
    
    if (tableEntityIds.length === 0) continue;
    
    try {
      const entityResults = await dataSource.query(
        `SELECT * FROM "${tableName}" WHERE id = ANY($1) LIMIT 100`,
        [tableEntityIds]
      );
      
      if (entityResults.length > 0) {
        logger.info(`Found ${entityResults.length} records in the ${tableName} table`);
        entityDataFound[tableName] = entityResults;
        
        // Map entity details by ID for easy lookup
        for (const entity of entityResults) {
          if (entity.id) {
            const id = String(entity.id);
            if (!details[id]) {
              details[id] = {};
            }
            
            details[id].entity_data = {
              found: true,
              table: tableName,
              created_at: entity.created_at,
              updated_at: entity.updated_at,
              data: entity
            };
            
            // Special handling for comments table - check for null parent_id fields
            if (tableName === 'comments') {
              const commentsWithNullParent = entityResults.filter((entity: { parent_id: string | null }) => entity.parent_id === null);
              if (commentsWithNullParent.length > 0) {
                logger.info(`Found ${commentsWithNullParent.length} comments with null parent_id field`);
                
                // Add parent_id info to details for each comment with null parent_id
                for (const comment of commentsWithNullParent) {
                  const id = String(comment.id);
                  if (details[id]?.entity_data) {
                    details[id].entity_data.has_null_parent_id = true;
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      logger.warn(`Error querying ${tableName} table: ${error}`);
    }
  }
  
  // Query the change_history table
  try {
    const historyResults = await dataSource.query(
      `SELECT * FROM "change_history" WHERE data->>'id' = ANY($1) LIMIT 100`,
      [entityIds]
    );
    
    if (historyResults.length > 0) {
      logger.info(`Found ${historyResults.length} matches in the change_history table`);
      historyFound.push(...historyResults);
      
      // Map details by ID for easy lookup
      for (const change of historyResults) {
        if (change.data?.id) {
          const id = String(change.data.id);
          if (!details[id]) {
            details[id] = {};
          }
          
          details[id].changes_history_table = {
            found: true,
            recorded_at: change.created_at,
            client_id: change.client_id,
            sequence: change.sequence,
            batch_id: change.batch_id,
            lsn: change.lsn,
            synced_at: change.synced_at
          };
        }
      }
    }
  } catch (error) {
    logger.warn(`Error querying change_history table: ${error}`);
  }
  
  // Identify which extra changes were not found in any table
  for (const change of extraChanges) {
    if (change.data?.id) {
      const id = String(change.data.id);
      if (!details[id]?.changes_history_table && !details[id]?.entity_data) {
        unmatchedChanges.push(change);
      }
    }
  }
  
  // Log a summary of findings
  logger.info(`Change lookup summary:`);
  logger.info(`- Extra changes: ${extraChanges.length}`);
  logger.info(`- Found in original entity tables: ${Object.values(entityDataFound).flat().length}`);
  logger.info(`- Found in change_history table: ${historyFound.length}`);
  logger.info(`- Not found in any table: ${unmatchedChanges.length}`);
  
  return {
    historyFound,
    entityDataFound,
    unmatchedChanges,
    details
  };
} 