import { TableChange } from '@repo/sync-types';
import { createSyncAdapters } from './sync-adapters';
import { createRepositories } from './repositories';
import { createServices } from './services';
import { SyncManager } from '../sync/SyncManager';
import { getNewPGliteDataSource } from './newtypeorm/NewDataSource';

/**
 * Change Processor for handling database changes
 */
export class ChangeProcessor {
  private syncAdapters: ReturnType<typeof createSyncAdapters> | null = null;
  private initialized = false;
  
  constructor() {}
  
  /**
   * Initialize the change processor with all dependencies
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    // Get DataSource
    const dataSource = await getNewPGliteDataSource();
    
    // Create repositories
    const repositories = await createRepositories();
    
    // Get SyncChangeManager
    const syncManager = SyncManager.getInstance();
    const outgoingChangeProcessor = syncManager.getOutgoingChangeProcessor();
    
    // Create services using the service factory
    const services = createServices(repositories, outgoingChangeProcessor);
    
    // Create sync adapters
    this.syncAdapters = createSyncAdapters(services);
    
    this.initialized = true;
  }
  
  /**
   * Process a single table change
   */
  async processChange(change: TableChange): Promise<void> {
    // Initialize if not already initialized
    if (!this.initialized && !this.syncAdapters) {
      await this.initialize();
    }
    
    if (!this.syncAdapters) {
      throw new Error('Change processor not initialized');
    }

    const { table, operation, data } = change;
    console.log(`[ChangeProcessor] Processing change for table: ${table}, operation: ${operation}, ID: ${data.id}`);
    
    const legacyType = operation.toUpperCase() as 'INSERT' | 'UPDATE' | 'DELETE';
    
    const legacyChange = {
      type: legacyType,
      entity: table,
      data: data as Record<string, any>
    };
    
    try {
      switch (table) {
        case 'users':
          await this.syncAdapters.users.processChange(legacyChange);
          break;
        case 'projects':
          await this.syncAdapters.projects.processChange(legacyChange);
          break;
        case 'tasks':
          await this.syncAdapters.tasks.processChange(legacyChange);
          break;
        case 'comments':
          await this.syncAdapters.comments.processChange(legacyChange);
          break;
        default:
          throw new Error(`Unsupported entity type: ${table}`);
      }
      console.log(`[ChangeProcessor] Successfully processed change for table: ${table}, ID: ${data.id}`);
    } catch (error) {
      console.error(`[ChangeProcessor] Error processing change for table: ${table}, ID: ${data.id}`);
      console.error(`[ChangeProcessor] Error details:`,
        error instanceof Error ? { message: error.message, stack: error.stack } : String(error));
      throw error;
    }
  }
  
  /**
   * Process a batch of table changes
   */
  async processBatch(changes: TableChange[]): Promise<void> {
    // Initialize if not already initialized
    if (!this.initialized && !this.syncAdapters) {
      await this.initialize();
    }
    
    // Optimize changes (deduplicate, order by dependencies)
    const optimizedChanges = this.optimizeChanges(changes);
    
    // Process in batches using a transaction
    const dataSource = await getNewPGliteDataSource();
    const queryRunner = dataSource.createQueryRunner();
    
    try {
      await queryRunner.startTransaction();
      
      for (const change of optimizedChanges) {
        await this.processChange(change);
      }
      
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
  
  /**
   * Optimize changes for processing
   */
  private optimizeChanges(changes: TableChange[]): TableChange[] {
    // Remove duplicates
    const uniqueChanges = new Map<string, TableChange>();
    for (const change of changes) {
      const key = `${change.table}_${change.data.id}`;
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
  private getDependencyOrder(change: TableChange): number {
    // Define dependency order for different entity types
    const entityOrder: Record<string, number> = {
      'users': 1,
      'projects': 2,
      'tasks': 3,
      'comments': 4
    };

    return entityOrder[change.table] || 999;
  }
} 