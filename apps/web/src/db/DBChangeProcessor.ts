import { PGliteRepository, PGliteQueryBuilder } from './typeorm/PGliteQueryBuilder';
import { PGliteQueryRunner } from './typeorm/PGliteQueryRunner';
import { getNewPGliteDataSource } from './newtypeorm/NewDataSource';
import { Task } from '@dataforge/generated/client-entities';
import { EntityManager } from 'typeorm';

/**
 * Represents a database change operation
 */
export interface Change {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  entity: string;
  data: Record<string, any>;
  relationships?: Array<{
    table: string;
    data: Record<string, any>;
    foreignKey: string;
  }>;
}

/**
 * Error class for database change processing
 */
export class DBChangeProcessorError extends Error {
  constructor(
    message: string,
    public operation: string,
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'DBChangeProcessorError';
  }
}

/**
 * DBChangeProcessor handles all database change operations using TypeORM
 */
export class DBChangeProcessor {
  private repositories: Map<string, PGliteRepository<any>> = new Map();
  private queryBuilders: Map<string, PGliteQueryBuilder<any>> = new Map();

  constructor(
    private queryRunner: PGliteQueryRunner,
    private getRepository: (entity: string) => PGliteRepository<any>,
    private getQueryBuilder: (entity: string) => PGliteQueryBuilder<any>
  ) {}

  /**
   * Process a single change operation
   */
  async processChange(change: Change): Promise<void> {
    const { type, entity, data, relationships } = change;
    
    try {
      switch (type) {
        case 'INSERT':
          await this.handleInsert(entity, data, relationships);
          break;
        case 'UPDATE':
          await this.handleUpdate(entity, data, relationships);
          break;
        case 'DELETE':
          await this.handleDelete(entity, data);
          break;
        default:
          throw new DBChangeProcessorError(
            `Unsupported change type: ${type}`,
            'processChange'
          );
      }
    } catch (error) {
      throw new DBChangeProcessorError(
        `Failed during ${type} operation for ${entity}`,
        'processChange',
        error
      );
    }
  }

  /**
   * Handle entity insertion with relationships
   */
  private async handleInsert(
    entity: string,
    data: Record<string, any>,
    relationships?: Array<{
      table: string;
      data: Record<string, any>;
      foreignKey: string;
    }>
  ): Promise<void> {
    if (!this.queryRunner.manager) {
      throw new DBChangeProcessorError('EntityManager not available on QueryRunner', 'handleInsert');
    }

    if (entity === 'tasks') {
      await this.queryRunner.manager.insert(Task, data);
    } else {
      throw new DBChangeProcessorError(`Direct insert not implemented for entity: ${entity}`, 'handleInsert');
    }

    if (relationships?.length) {
      for (const rel of relationships) {
        const relRepository = this.getRepository(rel.table);
        await relRepository.save({
          ...rel.data,
          [rel.foreignKey]: data.id
        });
      }
    }
  }

  /**
   * Handle entity update with relationships
   */
  private async handleUpdate(
    entity: string,
    data: Record<string, any>,
    relationships?: Array<{
      table: string;
      data: Record<string, any>;
      foreignKey: string;
    }>
  ): Promise<void> {
    // Get or create repository for the entity
    const repository = this.getRepository(entity);

    // Update main entity
    await repository.update(data.id, data);

    // Update relationships if any
    if (relationships?.length) {
      for (const rel of relationships) {
        const relRepository = this.getRepository(rel.table);
        await relRepository.update(rel.data.id, {
          ...rel.data,
          [rel.foreignKey]: data.id
        });
      }
    }
  }

  /**
   * Handle entity deletion with relationships
   */
  private async handleDelete(entity: string, data: Record<string, any>): Promise<void> {
    // Get or create repository for the entity
    const repository = this.getRepository(entity);

    // --- Temporarily Commented Out Relationship Deletion Logic ---
    // const queryBuilder = this.getQueryBuilder('entity_relationships');
    // const relationships = await queryBuilder
    //   .select(['id', 'table', 'entity_id'])
    //   .where('entity_id = :id', { id: data.id })
    //   .getMany();
    // 
    // for (const rel of relationships) {
    //   const relRepository = this.getRepository(rel.table);
    //   await relRepository.delete(rel.id);
    // }
    // --- End Comment Out ---

    // Then delete the main entity
    await repository.delete(data.id);
  }

  /**
   * Process a batch of changes with optimization
   */
  async processBatch(changes: Change[]): Promise<void> {
    // Optimize changes (deduplicate, order by dependencies)
    const optimizedChanges = this.optimizeChanges(changes);
    
    // Process in batches
    const batchSize = 100;
    for (let i = 0; i < optimizedChanges.length; i += batchSize) {
      const batch = optimizedChanges.slice(i, i + batchSize);
      await this.processBatchWithTransaction(batch);
    }
  }

  /**
   * Process a batch within a transaction
   */
  private async processBatchWithTransaction(changes: Change[]): Promise<void> {
    await this.queryRunner.startTransaction();
    try {
      for (const change of changes) {
        await this.processChange(change);
      }
      await this.queryRunner.commitTransaction();
    } catch (error) {
      await this.queryRunner.rollbackTransaction();
      throw new DBChangeProcessorError(
        'Failed to process batch of changes',
        'processBatchWithTransaction',
        error
      );
    }
  }

  /**
   * Optimize changes for processing
   */
  private optimizeChanges(changes: Change[]): Change[] {
    // Remove duplicates
    const uniqueChanges = new Map<string, Change>();
    for (const change of changes) {
      const key = `${change.entity}_${change.data.id}`;
      uniqueChanges.set(key, change);
    }
    
    // Order by dependencies
    return Array.from(uniqueChanges.values())
      .sort((a, b) => this.getDependencyOrder(a) - this.getDependencyOrder(b));
  }

  /**
   * Get dependency order for a change
   * Lower number means higher priority
   */
  private getDependencyOrder(change: Change): number {
    // Define dependency order for different entity types
    const entityOrder: Record<string, number> = {
      'users': 1,
      'projects': 2,
      'tasks': 3,
      'comments': 4
    };

    return entityOrder[change.entity] || 999;
  }
} 