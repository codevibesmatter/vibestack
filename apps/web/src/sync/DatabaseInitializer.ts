import { getNewPGliteDataSource, NewPGliteDataSource, NewPGliteDataSourceOptions } from '../db/newtypeorm/NewDataSource';
import { LocalChanges } from '@repo/dataforge/client-entities';
import { Repository } from 'typeorm';

export class DatabaseInitializer {
  private dataSource: NewPGliteDataSource | null = null;
  private localChangesRepository: Repository<LocalChanges> | null = null;
  private initializationPromise: Promise<void> | null = null;

  constructor(private readonly dataSourceOptions?: NewPGliteDataSourceOptions) {}

  public async initialize(): Promise<void> {
    if (this.isInitialized()) {
      return;
    }
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      try {
        console.log('[DatabaseInitializer] Initializing data source...');
        this.dataSource = await getNewPGliteDataSource(this.dataSourceOptions);
        if (!this.dataSource) {
          throw new Error('Failed to initialize data source: getNewPGliteDataSource returned null or undefined.');
        }
        console.log('[DatabaseInitializer] Data source initialized. Getting LocalChanges repository...');
        this.localChangesRepository = this.dataSource.getRepository(LocalChanges);
        if (!this.localChangesRepository) {
            throw new Error('Failed to get LocalChanges repository from data source.');
        }
        console.log('[DatabaseInitializer] LocalChanges repository obtained. Initialization complete.');
      } catch (error) {
        console.error('[DatabaseInitializer] Error during initialization:', error);
        // Resetting to allow for re-attempts if necessary, or handle error more gracefully
        this.dataSource = null;
        this.localChangesRepository = null;
        this.initializationPromise = null;
        throw error; // Re-throw the error to be caught by the caller
      }
    })();

    return this.initializationPromise;
  }

  public getLocalChangesRepository(): Repository<LocalChanges> {
    if (!this.localChangesRepository) {
      throw new Error('DatabaseInitializer not initialized or LocalChanges repository not available. Call initialize() first.');
    }
    return this.localChangesRepository;
  }

  public getDataSource(): NewPGliteDataSource {
    if (!this.dataSource) {
      throw new Error('DatabaseInitializer not initialized or data source not available. Call initialize() first.');
    }
    return this.dataSource;
  }

  public isInitialized(): boolean {
    return !!this.dataSource && !!this.localChangesRepository;
  }
}