/**
 * Custom DataSource Factory for Neon TypeORM Integration
 */

import { 
    DataSource, 
    DataSourceOptions, 
    EntityManager, 
    EntityMetadata, 
    EntitySchema, 
    EntitySubscriberInterface, 
    EntityTarget, 
    Logger, 
    MixedList, 
    NamingStrategyInterface, 
    ObjectLiteral, 
    QueryRunner, 
    Repository, 
    ReplicationMode, 
    SelectQueryBuilder 
} from 'typeorm';
import { AdvancedConsoleLogger } from 'typeorm/logger/AdvancedConsoleLogger.js';
import { LoggerFactory } from 'typeorm/logger/LoggerFactory.js';
import { ConnectionMetadataBuilder } from 'typeorm/connection/ConnectionMetadataBuilder.js';
import { DefaultNamingStrategy } from 'typeorm/naming-strategy/DefaultNamingStrategy.js';
import { ObjectUtils } from 'typeorm/util/ObjectUtils.js';
import { NeonDriver, NeonDriverOptions } from './NeonDriver'; // Import Neon driver

/**
 * Configuration options for creating a Neon data source
 */
export interface NeonDataSourceOptions {
    url: string; // Make URL mandatory at this level
    entities: MixedList<Function | string | EntitySchema<any>>;
    synchronize?: boolean;
    // Match LoggerOptions type from TypeORM exactly
    logging?: boolean | "all" | ("query" | "error" | "schema" | "warn" | "info" | "log" | "migration")[] ;
    namingStrategy?: NamingStrategyInterface;
    subscribers?: MixedList<string | Function>;
    // Add other relevant options from DataSourceOptions if needed
    database?: string;
    schema?: string;
}

/**
 * Custom DataSource-like object implementing the necessary structure for Neon
 */
export interface NeonDataSource {
    "@instanceof": symbol; // For TypeORM internal checks if needed
    options: DataSourceOptions; // Store the derived TypeORM options structure
    driver: NeonDriver;
    manager: EntityManager;
    entityMetadatas: EntityMetadata[];
    isInitialized: boolean;
    namingStrategy: NamingStrategyInterface;
    logger: Logger;
    subscribers: EntitySubscriberInterface<any>[];
    
    // Keep methods similar to TypeORM DataSource
    initialize(): Promise<NeonDataSource>;
    destroy(): Promise<void>;
    buildMetadatas(): Promise<void>; // Keep explicit metadata build step
    createQueryRunner(mode?: ReplicationMode): QueryRunner;
    getMetadata(target: Function | EntitySchema<any> | string): EntityMetadata | undefined;
    hasMetadata(target: Function | EntitySchema<any> | string): boolean;
    getRepository<Entity extends ObjectLiteral>(target: EntityTarget<Entity>): Repository<Entity>;
    createQueryBuilder<Entity extends ObjectLiteral>(entityOrRunner?: EntityTarget<Entity> | QueryRunner, alias?: string, queryRunner?: QueryRunner): SelectQueryBuilder<Entity>;
    query(query: string, parameters?: any[]): Promise<any>;
    // Add other relevant methods if needed
}

/**
 * Creates a new TypeORM DataSource-like object configured with the custom Neon driver
 */
export function createNeonDataSource(options: NeonDataSourceOptions): NeonDataSource {
    const namingStrategy = options.namingStrategy || new DefaultNamingStrategy();
    
    // Manually create the logger instance, bypassing LoggerFactory
    let logger: Logger | undefined;
    if (options.logging) { // Check if logging is enabled (true, 'all', or array)
        // Always use AdvancedConsoleLogger in this custom setup if logging is requested
        logger = new AdvancedConsoleLogger(options.logging === true ? "all" : options.logging);
    } else {
        // Optionally, you could create a NoopLogger or similar if TypeORM requires a logger instance
        logger = undefined; // Or assign a logger that does nothing
    }
    
    // Fallback if logger creation failed (shouldn't happen with AdvancedConsoleLogger)
    if (!logger) {
        // Use LoggerFactory as a fallback ONLY if manual creation fails/is not desired
        // const loggerOptions = options.logging === false ? undefined : options.logging;
        // logger = new LoggerFactory().create(undefined, loggerOptions);
        
        // Or, provide a minimal default logger to avoid errors
        logger = {
             logQuery: () => {}, logQueryError: () => {}, logQuerySlow: () => {},
             logSchemaBuild: () => {}, logMigration: () => {},
             log: () => {}
         }
    }

    // 1. Create NeonDriver options
    const driverOptions: NeonDriverOptions = {
        type: 'postgres', // Still needed for the driver options interface
        url: options.url,
        database: options.database,
        schema: options.schema,
        namingStrategy: namingStrategy,
        logging: options.logging,
        synchronize: options.synchronize,
    };
    const driver = new NeonDriver(driverOptions);

    // 2. Create the full TypeORM DataSourceOptions structure needed internally
    // This is used by metadata builder, entity manager, etc., even if we don't use `new DataSource()`
    const dataSourceOptions: DataSourceOptions = {
        type: 'postgres', // Use 'postgres' as the base type compatibility
        url: options.url, // Keep url here too if needed by internal components
        entities: options.entities || [],
        synchronize: options.synchronize ?? false,
        logging: options.logging,
        namingStrategy: namingStrategy,
        subscribers: options.subscribers || [],
        // Pass other compatible options from NeonDataSourceOptions if necessary
        database: options.database,
        schema: options.schema,
        // Explicitly set config/env related options to undefined/empty
        // to potentially prevent ConnectionOptionsReader usage.
        // config: undefined, // REMOVE - Invalid property
        // configFile: undefined, // REMOVE - Invalid property
        extra: undefined, // No extra options
        cache: undefined, // No caching options
        replication: undefined, // No replication options
        // IMPORTANT: DO NOT pass the driver instance here. We manage it directly.
        // driver: driver, // NO!
    };

    // 3. Create the custom NeonDataSource object
    const dataSource: NeonDataSource = {
        "@instanceof": Symbol.for("DataSource"), // Helps with TypeORM's InstanceChecker
        options: dataSourceOptions, // Store the structured options
        driver: driver, // Store our driver instance
        isInitialized: false,
        manager: null as any, // Initialize manager as null
        entityMetadatas: [], // Initialize entityMetadatas
        namingStrategy: namingStrategy,
        logger: logger, // Assign the manually created logger
        subscribers: [] as EntitySubscriberInterface<any>[], // Explicitly type the empty array

        async initialize(): Promise<NeonDataSource> {
            if (this.isInitialized) return this;
            try {
                this.logger.log("log", "Initializing Neon driver...");
                await this.driver.connect();
                // Assign the connection reference *after* connect and *before* metadata/manager creation
                // This mimics what TypeORM's DataSource does internally
                this.driver.connection = this as any; 
                
                await this.driver.afterConnect();
                this.logger.log("log", "Neon driver connected.");

                this.logger.log("log", "Building metadata...");
                await this.buildMetadatas(); // Call separate metadata build
                this.logger.log("log", `Metadata built. Found ${this.entityMetadatas.length} entities.`);

                // Assign subscribers to the driver *after* they are built
                this.driver.subscribers = this.subscribers;

                // Assign manager to the driver *after* it's created
                // This might be needed by QueryRunner or other internal parts
                // We create the manager *before* assigning it to the driver
                this.logger.log("log", "Creating EntityManager...");
                // Create manager AFTER metadata and subscribers are ready
                this.manager = new EntityManager(this as any); 
                this.driver.manager = this.manager; // Now assign manager to driver
                this.logger.log("log", "EntityManager created.");


                this.isInitialized = true;
                this.logger.log("log", "NeonDataSource initialized successfully.");
                return this;
            } catch (error) {
                this.logger.log("warn", `Failed to initialize NeonDataSource: ${error}`); 
                // Attempt to clean up driver connection if initialization failed partially
                if (this.driver && this.driver.isInitialized) {
                     await this.driver.disconnect().catch(e => this.logger.log("warn", "Error during cleanup disconnect:", e));
                }
                this.isInitialized = false; // Ensure state reflects failure
                this.driver.connection = null as any; // Clear potentially partial assignment
                this.driver.manager = null as any;
                throw error;
            }
        },

        async buildMetadatas(): Promise<void> {
            // Create a minimal connection-like object specifically for the builder
            // to prevent potential fallbacks to ConnectionOptionsReader
            const mockConnectionForBuilder = {
                options: this.options, // Pass the structured DataSourceOptions
                driver: this.driver,
                logger: this.logger,
                namingStrategy: this.namingStrategy,
                entityMetadatas: [], // Provide empty arrays to be populated by the builder
                subscribers: [], // Provide empty arrays to be populated by the builder
                // REMOVE these potentially problematic self-referential stubs
                /*
                getMetadata: (target: any): EntityMetadata | undefined => {
                     return this.entityMetadatas.find(m => m.target === target || m.name === target || m.tableName === target); // Simplified lookup
                },
                hasMetadata: (target: any): boolean => {
                    return this.entityMetadatas.some(m => m.target === target || m.name === target || m.tableName === target);
                },
                */
            };

            const metadataBuilder = new ConnectionMetadataBuilder(mockConnectionForBuilder as any);

            const entitiesArray = ObjectUtils.mixedListToArray(this.options.entities || []);
            const subscribersArray = ObjectUtils.mixedListToArray(this.options.subscribers || []);

            // Build metadata and subscribers using the arrays
            // Assign results back to the main NeonDataSource instance
            this.entityMetadatas = await metadataBuilder.buildEntityMetadatas(entitiesArray);
            this.subscribers = await metadataBuilder.buildSubscribers(subscribersArray);
        },

        async destroy(): Promise<void> {
            if (this.driver && this.driver.isInitialized) {
                await this.driver.disconnect();
            }
            this.isInitialized = false;
            this.entityMetadatas = [];
            this.subscribers = [];
            this.manager = null as any;
            this.driver.connection = null as any; // Clear driver refs
            this.driver.manager = null as any; 
        },

        createQueryRunner(mode: ReplicationMode = "master"): QueryRunner {
            // Use the driver's method to create the query runner
            // The driver's createQueryRunner should be set up to use the connected client
            // and have access to the connection/manager instance via `this.driver`
            if (!this.isInitialized || !this.driver) {
                 throw new Error("DataSource is not initialized, cannot create QueryRunner.");
            }
            const runner = this.driver.createQueryRunner(mode);
            // Ensure the runner has a reference to the manager if needed (TypeORM often does this)
            // The driver's createQueryRunner method should ideally handle setting runner.connection and runner.manager
            // runner.manager = this.manager; // Check if NeonQueryRunner constructor needs/sets this
            return runner;
        },

        getMetadata(target: Function | EntitySchema<any> | string): EntityMetadata | undefined {
            if (!this.isInitialized) throw new Error("DataSource is not initialized.");
            // Find metadata in the built array (similar to NewPGliteDataSource)
            return this.entityMetadatas.find((metadata) => {
                 if (metadata.target === target) return true;
                 // Refined type checking
                 const targetName = typeof target === "function" ? target.name : target instanceof EntitySchema ? target.options.name : typeof target === "string" ? target : undefined;
                 const metadataName = typeof metadata.target === "function" ? metadata.target.name : typeof metadata.target === "string" ? metadata.target : undefined; // Check function name or string target
                 
                 if (targetName && metadata.name === targetName) return true;
                 // Add check for entity schema name if target is EntitySchema
                 if (target instanceof EntitySchema && metadata.name === target.options.name) return true;
                 if (typeof target === "string" && metadata.tableName === target) return true; // Check table name too

                 return false;
             });
        },

        hasMetadata(target: Function | EntitySchema<any> | string): boolean {
            return !!this.getMetadata(target);
        },

        getRepository<Entity extends ObjectLiteral>(target: EntityTarget<Entity>): Repository<Entity> {
            if (!this.manager) throw new Error("DataSource is not initialized or EntityManager is not available.");
            return this.manager.getRepository(target);
        },

        createQueryBuilder<Entity extends ObjectLiteral>(
            entityOrRunner?: EntityTarget<Entity> | QueryRunner,
            alias?: string,
            queryRunner?: QueryRunner,
        ): SelectQueryBuilder<Entity> {
            if (!this.isInitialized) {
                throw new Error(
                    "Cannot create query builder - data source is not initialized",
                )
            }

            // Check if the first argument is a QueryRunner by looking for expected methods
            const isFirstArgQueryRunner = 
                typeof entityOrRunner === 'object' && 
                entityOrRunner !== null && 
                'query' in entityOrRunner && 
                'connect' in entityOrRunner && 
                'release' in entityOrRunner;

            const actualQueryRunner = isFirstArgQueryRunner
                ? (entityOrRunner as QueryRunner)
                : queryRunner ?? this.createQueryRunner();

            const actualEntityTarget = isFirstArgQueryRunner
                ? undefined
                : (entityOrRunner as EntityTarget<Entity> | undefined);

            const actualAlias = actualEntityTarget
                ? alias || (typeof actualEntityTarget === "function" ? actualEntityTarget.name : typeof actualEntityTarget === "string" ? actualEntityTarget : undefined)
                : undefined

            const qb = new SelectQueryBuilder<Entity>(this as any, actualQueryRunner);

            // Attach the QueryRunner to the QueryBuilder if it was created by the factory
            // This helps with logging and other query runner specific features
            if (!queryRunner && actualQueryRunner) {
                qb.setQueryRunner(actualQueryRunner);
            }

            if (actualAlias && actualEntityTarget) {
                qb.select(actualAlias);
                qb.from(actualEntityTarget, actualAlias);
            }

            return qb;
        },
        
        async query(query: string, parameters?: any[]): Promise<any> {
            if (!this.manager) throw new Error("DataSource is not initialized or EntityManager is not available.");
            return this.manager.query(query, parameters);
        }
    };

    return dataSource;
} 