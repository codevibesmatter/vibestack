/**
 * New DataSource Factory for PGLite TypeORM Integration
 * (Reverting to factory pattern)
 */

import { DataSource, DataSourceOptions, EntitySchema, EntityTarget, MixedList, ObjectLiteral, Repository, SelectQueryBuilder, EntityManager, EntityMetadata, QueryRunner, NamingStrategyInterface, DefaultNamingStrategy, ReplicationMode, Logger, EntitySubscriberInterface } from 'typeorm';
import { LoggerFactory } from 'typeorm/logger/LoggerFactory.js'; // Import LoggerFactory
// import { Broadcaster } from 'typeorm/subscriber/Broadcaster.js'; // REMOVED - Handled by QueryRunner
import { ObjectUtils } from 'typeorm/util/ObjectUtils.js'; // Import ObjectUtils
// WARNING: Using internal TypeORM API
import { ConnectionMetadataBuilder } from 'typeorm/connection/ConnectionMetadataBuilder.js';
import { NewPGliteDriver, NewPGliteDriverOptions } from './NewPGliteDriver';
import { NewPGliteQueryRunner } from './NewPGliteQueryRunner';
import { QueryBuilderFactory } from './QueryBuilderFactory';
import { PGliteDriver } from 'typeorm-pglite'; // Assuming the typeorm-pglite driver
// import { Task, User, Project, Comment, BaseDomainEntity } from '@repo/dataforge'; // Keep commented or remove if unused elsewhere
// Import the generated client entities array using the exported path
import { clientEntities } from '@repo/dataforge/client-entities'; // Use the defined export path

/**
 * Configuration options for creating a new PGLite data source
 */
export interface NewPGliteDataSourceOptions {
    database?: string;
    synchronize?: boolean;
    logging?: boolean;
    dataDir?: string;
    extensions?: Record<string, any>;
    entities?: MixedList<Function | string | EntitySchema<any>>;
    namingStrategy?: NamingStrategyInterface; // Added naming strategy option
    subscribers?: MixedList<EntitySubscriberInterface<any>>;
}

/**
 * Custom DataSource-like object implementing the DataSource interface structure
 */
export interface NewPGliteDataSource {
    "@instanceof": symbol;
    options: DataSourceOptions;
    driver: NewPGliteDriver;
    manager: EntityManager;
    entityMetadatas: EntityMetadata[];
    isInitialized: boolean;
    namingStrategy: NamingStrategyInterface; // Added naming strategy
    defaultReplicationModeForReads: () => ReplicationMode;
    logger: Logger;
    // broadcaster: Broadcaster; // REMOVED - Handled by QueryRunner
    subscribers: EntitySubscriberInterface<any>[];

    initialize(): Promise<NewPGliteDataSource>;
    destroy(): Promise<void>;
    buildMetadatas(): Promise<void>; // Explicit metadata build step
    createQueryRunner(mode?: "master" | "slave"): QueryRunner;
    getMetadata(target: Function | EntitySchema<any> | string): EntityMetadata | undefined;
    hasMetadata(target: Function | EntitySchema<any> | string): boolean;
    getRepository<Entity extends ObjectLiteral>(target: EntityTarget<Entity>): Repository<Entity>;
    createQueryBuilder<Entity extends ObjectLiteral>(entityTarget?: EntityTarget<Entity>, alias?: string, queryRunner?: QueryRunner): SelectQueryBuilder<Entity>;
    query(query: string, parameters?: any[]): Promise<any>;
}

/**
 * Creates a new TypeORM DataSource-like object configured with our custom PGLite driver
 */
export function createNewPGliteDataSource(options: NewPGliteDataSourceOptions): NewPGliteDataSource {
    const namingStrategy = options.namingStrategy || new DefaultNamingStrategy();

    // Create driver options FIRST
    const driverOptions: NewPGliteDriverOptions = {
        database: options.database || 'pglite_db',
        dataDir: options.dataDir,
        extensions: options.extensions,
        namingStrategy: namingStrategy,
    };
    const driver = new NewPGliteDriver(driverOptions);

    // Create the full options object required by DataSource interface
    const dataSourceOptions: DataSourceOptions = {
        type: 'postgres', // Use compatible type for options structure, driver overrides behavior
        database: driverOptions.database,
        entities: options.entities || [],
        synchronize: options.synchronize ?? false,
        logging: options.logging ?? true,
        namingStrategy: namingStrategy,
        // Do NOT pass driver instance here, managed internally by our object
    };

    const logger = new LoggerFactory().create(options.logging ? "advanced-console" : undefined, options.logging); // Use standard logger types

    // // REMOVED - Broadcaster handled by QueryRunner
    // const tempDataSourceShell = { logger: logger, options: dataSourceOptions }; 
    // const broadcaster = new Broadcaster(tempDataSourceShell as any);

    const dataSource: NewPGliteDataSource = {
        "@instanceof": Symbol.for("DataSource"), // Add symbol for InstanceChecker
        options: dataSourceOptions,
        driver: driver,
        isInitialized: false,
        manager: null as any, // Initialize manager as null
        entityMetadatas: [], // Initialize entityMetadatas
        namingStrategy: namingStrategy,
        logger: logger, // Assign the created logger
        // broadcaster: null as any, // REMOVED - Handled by QueryRunner
        subscribers: [], // Initialize subscribers array
        defaultReplicationModeForReads: (): ReplicationMode => {
            // PGLite does not support replication, always use master
            return "master";
        },

        async initialize(): Promise<NewPGliteDataSource> {
            if (this.isInitialized) return this;
            try {
                console.log("Initializing driver...");
                await this.driver.connect();
                this.driver.connection = this as any; // Assign connection reference AFTER connect
                await this.driver.afterConnect();
                console.log("Driver connected.");

                console.log("Building metadata...");
                await this.buildMetadatas(); // Call separate metadata build
                console.log(`Metadata built. Found ${this.entityMetadatas.length} entities.`);

                // // REMOVED - Broadcaster handled by QueryRunner
                // console.log("Creating Broadcaster...");
                // this.broadcaster = new Broadcaster(this as any); 
                // console.log("Broadcaster created.");

                console.log("Creating EntityManager...");
                this.manager = new EntityManager(this as any); // Create manager AFTER metadata is ready
                console.log("EntityManager created.");

                this.isInitialized = true;
                console.log("NewPGliteDataSource initialized successfully.");
                return this;
            } catch (error) {
                console.error('Failed to initialize NewPGliteDataSource:', error);
                // Attempt to clean up driver connection if initialization failed partially
                if (this.driver && this.driver.isInitialized) {
                     await this.driver.disconnect().catch(e => console.error("Error during cleanup disconnect:", e));
                }
                this.isInitialized = false; // Ensure state reflects failure
                throw error;
            }
        },

        async buildMetadatas(): Promise<void> {
            // Create a minimal connection-like object for the builder
            const mockConnectionForBuilder = {
                driver: this.driver,
                options: this.options,
                entityMetadatas: this.entityMetadatas, 
                namingStrategy: this.namingStrategy,
                logger: { // Basic logger mock
                    logQuery: () => {}, logQueryError: () => {}, logQuerySlow: () => {},
                    logSchemaBuild: (message: string) => { console.log("SchemaBuilder:", message); },
                    logMigration: (message: string) => { console.log("Migration:", message); },
                    log: (level: "log" | "info" | "warn", message: any) => { console.log(`Log [${level}]:`, message); }
                },
                subscribers: this.subscribers // Add the subscribers array
            };

            const metadataBuilder = new ConnectionMetadataBuilder(mockConnectionForBuilder as any);
            const entitiesArray = Array.isArray(this.options.entities) ? this.options.entities : [];
            // Build and assign metadata directly to the property
            this.entityMetadatas = await metadataBuilder.buildEntityMetadatas(entitiesArray as any[]);
            
            // Build subscribers if they are in options
            if (this.options.subscribers) {
                const flattenedSubscribers = ObjectUtils.mixedListToArray(this.options.subscribers);
                if (flattenedSubscribers.length > 0) {
                    this.subscribers = await metadataBuilder.buildSubscribers(flattenedSubscribers);
                    console.log(`Built ${this.subscribers.length} subscribers.`);
                }
            }
        },

        async destroy(): Promise<void> {
            if (this.driver) {
                await this.driver.disconnect();
            }
            this.isInitialized = false;
            this.entityMetadatas = [];
            this.manager = null as any;
        },

        createQueryRunner(mode: "master" | "slave" = "master"): QueryRunner {
            // Create the query runner using the driver
            const runner = this.driver.createQueryRunner(mode);
            // Manually assign manager and connection if runner needs them (TypeORM base does this)
            // runner.connection = this as any; // Let driver handle this
            // runner.manager = this.manager; // Let driver handle this
            return runner;
        },

        getMetadata(target: Function | EntitySchema<any> | string): EntityMetadata | undefined {
            // Comment out verbose logging
            // console.log(`[DataSource] getMetadata called for target:`, target);
            if (!this.isInitialized) {
                throw new Error("DataSource is not initialized.");
            }
            // Find metadata in the built array
            const metadata = this.entityMetadatas.find((metadata) => {
                 if (metadata.target === target) return true;
                 if (typeof target === "function" && typeof metadata.target === "function" && metadata.target.name === target.name) return true;
                 if (typeof target === "string" && metadata.tableName === target) return true;
                 if (target instanceof EntitySchema) return metadata.name === target.options.name;
                 return false;
             });
            // Comment out verbose logging
            // console.log(`[DataSource] getMetadata found:`, metadata ? `Metadata for ${metadata.name}` : 'Not Found');
            // Optional: Log details if found
            // if (metadata) {
            //     console.log(`   -> Primary Columns:`, metadata.primaryColumns.map(c => c.propertyName));
            //     console.log(`   -> Generated Columns:`, metadata.generatedColumns.map(c => c.propertyName));
            // }
            return metadata;
        },

        hasMetadata(target: Function | EntitySchema<any> | string): boolean {
            // Simply check if getMetadata returns a valid object
            return !!this.getMetadata(target);
        },

        getRepository<Entity extends ObjectLiteral>(target: EntityTarget<Entity>): Repository<Entity> {
            if (!this.manager) {
                throw new Error("DataSource is not initialized or EntityManager is not available.");
            }
            return this.manager.getRepository(target);
        },

        createQueryBuilder<Entity extends ObjectLiteral>(
            entityTarget?: EntityTarget<Entity>,
            alias?: string,
            queryRunner?: QueryRunner
        ): SelectQueryBuilder<Entity> {
            
            if (!this.isInitialized) {
                throw new Error("DataSource is not initialized.");
            }
            
            let effectiveAlias: string | undefined = alias;
            
            // Only determine/validate alias if an entityTarget is actually provided
            if (entityTarget) {
                effectiveAlias = alias || (typeof entityTarget === 'function' ? entityTarget.name : typeof entityTarget === 'string' ? entityTarget : undefined);
                if (!effectiveAlias) {
                     // If target is given, alias IS required by the factory for select/from
                     throw new Error("Could not determine alias for createQueryBuilder when entityTarget is provided.");
                }
            }
            // If no entityTarget, effectiveAlias remains potentially undefined, which is fine for internal calls.

            return QueryBuilderFactory.createSelectQueryBuilder(
                this as any, 
                entityTarget, // Pass potentially undefined entityTarget
                effectiveAlias || '_', // Pass determined alias or a placeholder if needed
                queryRunner
            );
        },
        
        async query(query: string, parameters?: any[]): Promise<any> {
            if (!this.isInitialized) {
                await this.initialize(); // Ensure initialized before direct query
            }
             // Get a temporary runner for the query
             const queryRunner = this.createQueryRunner();
             try {
                 return await queryRunner.query(query, parameters);
             } finally {
                 await queryRunner.release();
             }
        },
    };

    return dataSource;
}

// --- Singleton --- 

let dataSource: NewPGliteDataSource | null = null;

export async function getNewPGliteDataSource(
    config?: NewPGliteDataSourceOptions
): Promise<NewPGliteDataSource> {
    if (dataSource && dataSource.isInitialized) {
        return dataSource;
    }
    if (dataSource && !dataSource.isInitialized) {
        await dataSource.destroy().catch(err => console.error("Error destroying previous uninitialized DataSource:", err));
        dataSource = null;
    }

    try {
        console.log("Creating new NewPGliteDataSource object...");
        
        // Merge provided config with the imported clientEntities
        const effectiveConfig: NewPGliteDataSourceOptions = {
            ...(config || {}), // Spread provided config first
            // Use the imported clientEntities directly
            entities: clientEntities, 
        };
        
        const ds = createNewPGliteDataSource(effectiveConfig);
        
        console.log("Initializing NewPGliteDataSource object...");
        await ds.initialize(); 
        console.log("NewPGliteDataSource object initialized successfully.");
        
        dataSource = ds;
        return dataSource;
    } catch (error) {
        console.error('Failed to initialize TypeORM DataSource (factory):', error);
        if (dataSource) {
            await dataSource.destroy().catch(err => console.error("Error destroying failed DataSource (factory):", err));
            dataSource = null;
        }
        throw error;
    }
} 