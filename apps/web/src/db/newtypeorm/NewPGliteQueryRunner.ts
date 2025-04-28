/**
 * New PGLiteQueryRunner implementation for TypeORM
 * Interacts with NewPGliteDriver to execute queries against PGLite.
 */

import {
    ObjectLiteral,
    QueryRunner,
    QueryRunnerAlreadyReleasedError,
    ReplicationMode,
    TransactionAlreadyStartedError,
    TransactionNotStartedError,
    QueryFailedError,
    Table,
    View,
    TableCheck,
    TableColumn,
    TableExclusion,
    TableForeignKey,
    TableIndex,
    TableUnique,
    SelectQueryBuilder,
    EntityTarget,
    DataSource,
    QueryResult
} from "typeorm";
import { BaseQueryRunner } from "typeorm/query-runner/BaseQueryRunner.js"; // Internal import
import { SqlInMemory } from "typeorm/driver/SqlInMemory.js";
import { Broadcaster } from "typeorm/subscriber/Broadcaster.js"; // Import Broadcaster
import { BroadcasterResult } from "typeorm/subscriber/BroadcasterResult.js"; // Import BroadcasterResult
import type { NewPGliteDriver } from "./NewPGliteDriver"; // Use type import for driver
import { QueryBuilderFactory } from "./QueryBuilderFactory";

/**
 * Extended Broadcaster that's more resilient to missing properties
 */
class SafeBroadcaster extends Broadcaster {
    // Store our own reference to the query runner
    private safeQueryRunner: QueryRunner;

    constructor(queryRunner: QueryRunner) {
        super(queryRunner);
        this.safeQueryRunner = queryRunner;
    }

    /**
     * Override the broadcastLoadEvent method to be completely defensive - don't call super if we detect issues
     */
    broadcastLoadEvent(result: BroadcasterResult, metadata: any, entities: any[]): void {
        try {
            // Check if we have all required properties for safe execution
            if (!this.safeQueryRunner?.connection?.subscribers) {
                console.warn("Missing subscribers array on connection - skipping broadcastLoadEvent");
                return; // Exit early without calling super
            }
            
            // Only call super if we have all required properties
            super.broadcastLoadEvent(result, metadata, entities);
        } catch (err) {
            // Log but don't fail if there's an error during broadcast
            console.error("Error in broadcastLoadEvent (safely caught):", err);
        }
    }
}

export class NewPGliteQueryRunner extends BaseQueryRunner implements QueryRunner {

    /**
     * Database driver used by connection.
     */
    driver: NewPGliteDriver;

    /**
     * Broadcaster used on this query runner to broadcast entity events.
     */
    broadcaster: Broadcaster; // Ensure broadcaster property is declared

    /**
     * Indicates if query runner is already released.
     * Once released, query runner cannot run queries anymore.
     */
    // isReleased = false; // Inherited from BaseQueryRunner

    /**
     * Indicates if transaction is in progress.
     */
    // isTransactionActive = false; // Inherited from BaseQueryRunner

    /**
     * Stores temporarily user data.
     * Useful for sharing data with subscribers.
     */
    // data = {}; // Inherited from BaseQueryRunner

    /**
     * All queries run by this query runner.
     */
    // protected queries: string[] = []; // Inherited from BaseQueryRunner

    /**
     * Ensure connection property is properly typed if inherited or assigned
     */
    connection: DataSource;

    constructor(driver: NewPGliteDriver, mode: ReplicationMode = "master") {
        super();
        this.driver = driver;
        this.mode = mode; // Inherited mode property
        // Assign connection from the driver (driver gets it assigned in DataSource factory)
        this.connection = driver.connection; 
        // Use the safe broadcaster instead of the standard one
        this.broadcaster = new SafeBroadcaster(this); 
        
        if (!this.connection) {
            // This should ideally not happen if DataSource factory assigns it
            console.warn("QueryRunner created without a connection reference from the driver.");
        }
        console.log(`NewPGliteQueryRunner initialized in mode: ${this.mode}`);
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Executes a given SQL query.
     */
    async query(query: string, parameters?: any[], useStructuredResult = false): Promise<any> {
        if (this.isReleased) {
            throw new QueryRunnerAlreadyReleasedError();
        }

        const pglite = this.driver.pglite;
        if (!pglite) {
            throw new Error("PGlite connection is not available in the driver.");
        }

        const databaseConnection = await this.connect(); // Ensure connection from driver

        // Using 'any' cast for logger temporarily
        this.driver.connection.logger.logQuery(query, parameters, this as any);
        // Comment out redundant manual query logging
        // console.log(`[QueryRunner] Full SQL Query: ${query}`); 

        try {
            const queryStartTime = +new Date();

            const sanitizedParams = parameters;

            // --- Log SQL Directly ---
            console.log(">>> [QueryRunner EXEC] SQL:", query);
            console.log(">>> [QueryRunner EXEC] Params:", JSON.stringify(sanitizedParams));
            // --- End Log SQL Directly ---
            const result = await databaseConnection.query(query, sanitizedParams);
            // console.log('[QueryRunner] Raw result from PGLite:', JSON.stringify(result)); // REMOVED: Log the raw result

            const queryEndTime = +new Date();
            const queryExecutionTime = queryEndTime - queryStartTime;

            if (this.driver.connection.options?.maxQueryExecutionTime && queryExecutionTime > this.driver.connection.options.maxQueryExecutionTime) {
                 // Using 'any' cast for logger temporarily
                this.driver.connection.logger.logQuerySlow(queryExecutionTime, query, parameters, this as any);
            }

            // Create a QueryResult instance
            const queryResult = new QueryResult();
            if (result) {
                const rows = result.rows || (Array.isArray(result) ? result : []);
                // Ensure records is always an array
                queryResult.records = Array.isArray(rows) ? rows : (rows ? [rows] : []); 
                queryResult.affected = result.affectedRows ?? (queryResult.records ? queryResult.records.length : undefined);
                // Set raw to the records array, as expected by parts of TypeORM like ReturningResultsEntityUpdator
                queryResult.raw = queryResult.records; 
            }

            // Return based on useStructuredResult
            if (useStructuredResult) {
                // Return the standard QueryResult object
                return queryResult; 
            } else {
                // Return just the raw rows array (which is also in queryResult.raw)
                return queryResult.raw; 
            }
        } catch (err: any) {
             // Using 'any' cast for logger temporarily
            this.driver.connection.logger.logQueryError(err, query, parameters, this as any);
            const error = err instanceof Error ? err : new Error(String(err));
            throw new QueryFailedError(query, parameters, error);
        }
    }

    // -------------------------------------------------------------------------
    // Transaction Methods (Initial Implementation)
    // -------------------------------------------------------------------------

    /**
     * Starts transaction.
     */
    async startTransaction(isolationLevel?: any): Promise<void> {
        if (this.isTransactionActive) {
            throw new TransactionAlreadyStartedError();
        }
        this.isTransactionActive = true;
        try {
            await this.query("BEGIN");
        } catch (e) {
            this.isTransactionActive = false;
            throw e;
        }
    }

    /**
     * Commits transaction.
     */
    async commitTransaction(): Promise<void> {
        if (!this.isTransactionActive) {
            throw new TransactionNotStartedError();
        }
        try {
            await this.query("COMMIT");
            this.isTransactionActive = false;
        } catch (e) {
            throw e;
        }
    }

    /**
     * Rollbacks transaction.
     */
    async rollbackTransaction(): Promise<void> {
        if (!this.isTransactionActive) {
            throw new TransactionNotStartedError();
        }
        try {
            await this.query("ROLLBACK");
            this.isTransactionActive = false;
        } catch (e) {
            throw e;
        }
    }

    // -------------------------------------------------------------------------
    // Other Required Methods (Stubs for now)
    // -------------------------------------------------------------------------

    /**
     * Connects to the database. Needed by BaseQueryRunner.
     * Make public to satisfy QueryRunner interface.
     */
    async connect(): Promise<any> {
        if (!this.driver.pglite) {
            await this.driver.connect();
            if (!this.driver.pglite) {
                throw new Error("Failed to establish PGLite connection via driver.");
            }
        }
        return this.driver.pglite;
    }

    /**
     * Releases connection. Needed by BaseQueryRunner.
     */
    async release(): Promise<void> {
        this.isReleased = true;
        return Promise.resolve();
    }

    // Stubs for methods required by BaseQueryRunner or QueryRunner interface
    async loadTables(tableNames?: string[]): Promise<Table[]> { /* Stub */ return []; }
    async loadViews(viewNames?: string[]): Promise<View[]> { /* Stub */ return []; }

    // Stubs for other QueryRunner methods
    getDatabases(): Promise<string[]> { throw new Error("Method not implemented."); }
    getSchemas(database?: string): Promise<string[]> { throw new Error("Method not implemented."); }
    hasDatabase(database: string): Promise<boolean> { throw new Error("Method not implemented."); }
    getCurrentDatabase(): Promise<string | undefined> { throw new Error("Method not implemented."); }
    hasSchema(schema: string): Promise<boolean> { throw new Error("Method not implemented."); }
    getCurrentSchema(): Promise<string | undefined> { throw new Error("Method not implemented."); }
    hasTable(tableOrName: Table | string): Promise<boolean> { throw new Error("Method not implemented."); }
    hasColumn(tableOrName: Table | string, columnName: string): Promise<boolean> { throw new Error("Method not implemented."); }
    createDatabase(database: string, ifNotExist?: boolean): Promise<void> { throw new Error("Method not implemented."); }
    dropDatabase(database: string, ifExist?: boolean): Promise<void> { throw new Error("Method not implemented."); }
    createSchema(schemaPath: string, ifNotExist?: boolean): Promise<void> { throw new Error("Method not implemented."); }
    dropSchema(schemaPath: string, ifExist?: boolean, isCascade?: boolean): Promise<void> { throw new Error("Method not implemented."); }
    createTable(table: Table, ifNotExist?: boolean, createForeignKeys?: boolean, createIndices?: boolean): Promise<void> { throw new Error("Method not implemented."); }
    dropTable(tableOrName: Table | string, ifExist?: boolean, dropForeignKeys?: boolean, dropIndices?: boolean): Promise<void> { throw new Error("Method not implemented."); }
    createView(view: View, ifNotExist?: boolean,): Promise<void> { throw new Error("Method not implemented."); }
    dropView(viewOrPath: View | string): Promise<void> { throw new Error("Method not implemented."); }
    renameTable(oldTableOrName: Table | string, newTableName: string): Promise<void> { throw new Error("Method not implemented."); }
    changeTableComment(tableOrName: Table | string, comment?: string): Promise<void> { throw new Error("Method not implemented."); }
    addColumn(tableOrName: Table | string, column: TableColumn): Promise<void> { throw new Error("Method not implemented."); }
    addColumns(tableOrName: Table | string, columns: TableColumn[]): Promise<void> { throw new Error("Method not implemented."); }
    renameColumn(tableOrName: Table | string, oldColumnOrName: TableColumn | string, newColumnOrName: TableColumn | string,): Promise<void> { throw new Error("Method not implemented."); }
    changeColumn(tableOrName: Table | string, oldColumnOrName: TableColumn | string, newColumn: TableColumn,): Promise<void> { throw new Error("Method not implemented."); }
    changeColumns(tableOrName: Table | string, changedColumns: { oldColumn: TableColumn; newColumn: TableColumn }[],): Promise<void> { throw new Error("Method not implemented."); }
    dropColumn(tableOrName: Table | string, columnOrName: TableColumn | string): Promise<void> { throw new Error("Method not implemented."); }
    dropColumns(tableOrName: Table | string, columns: TableColumn[]): Promise<void> { throw new Error("Method not implemented."); }
    createPrimaryKey(tableOrName: Table | string, columnNames: string[], constraintName?: string): Promise<void> { throw new Error("Method not implemented."); }
    updatePrimaryKeys(tableOrName: Table | string, columns: TableColumn[]): Promise<void> { throw new Error("Method not implemented."); }
    dropPrimaryKey(tableOrName: Table | string, constraintName?: string): Promise<void> { throw new Error("Method not implemented."); }
    createUniqueConstraint(tableOrName: Table | string, uniqueConstraint: TableUnique): Promise<void> { throw new Error("Method not implemented."); }
    createUniqueConstraints(tableOrName: Table | string, uniqueConstraints: TableUnique[]): Promise<void> { throw new Error("Method not implemented."); }
    dropUniqueConstraint(tableOrName: Table | string, uniqueOrName: TableUnique | string): Promise<void> { throw new Error("Method not implemented."); }
    dropUniqueConstraints(tableOrName: Table | string, uniqueConstraints: TableUnique[]): Promise<void> { throw new Error("Method not implemented."); }
    createCheckConstraint(tableOrName: Table | string, checkConstraint: TableCheck): Promise<void> { throw new Error("Method not implemented."); }
    createCheckConstraints(tableOrName: Table | string, checkConstraints: TableCheck[]): Promise<void> { throw new Error("Method not implemented."); }
    dropCheckConstraint(tableOrName: Table | string, checkOrName: TableCheck | string): Promise<void> { throw new Error("Method not implemented."); }
    dropCheckConstraints(tableOrName: Table | string, checkConstraints: TableCheck[]): Promise<void> { throw new Error("Method not implemented."); }
    createExclusionConstraint(tableOrName: Table | string, exclusionConstraint: TableExclusion): Promise<void> { throw new Error("Method not implemented."); }
    createExclusionConstraints(tableOrName: Table | string, exclusionConstraints: TableExclusion[]): Promise<void> { throw new Error("Method not implemented."); }
    dropExclusionConstraint(tableOrName: Table | string, exclusionOrName: TableExclusion | string): Promise<void> { throw new Error("Method not implemented."); }
    dropExclusionConstraints(tableOrName: Table | string, exclusionConstraints: TableExclusion[]): Promise<void> { throw new Error("Method not implemented."); }
    createForeignKey(tableOrName: Table | string, foreignKey: TableForeignKey): Promise<void> { throw new Error("Method not implemented."); }
    createForeignKeys(tableOrName: Table | string, foreignKeys: TableForeignKey[]): Promise<void> { throw new Error("Method not implemented."); }
    dropForeignKey(tableOrName: Table | string, foreignKeyOrName: TableForeignKey | string): Promise<void> { throw new Error("Method not implemented."); }
    dropForeignKeys(tableOrName: Table | string, foreignKeys: TableForeignKey[]): Promise<void> { throw new Error("Method not implemented."); }
    createIndex(tableOrName: Table | string, index: TableIndex): Promise<void> { throw new Error("Method not implemented."); }
    createIndices(tableOrName: Table | string, indices: TableIndex[]): Promise<void> { throw new Error("Method not implemented."); }
    dropIndex(tableOrName: Table | string, indexOrName: TableIndex | string): Promise<void> { throw new Error("Method not implemented."); }
    dropIndices(tableOrName: Table | string, indices: TableIndex[]): Promise<void> { throw new Error("Method not implemented."); }
    clearTable(tableName: string): Promise<void> { throw new Error("Method not implemented."); }
    clearDatabase(database?: string): Promise<void> { throw new Error("Method not implemented."); }
    enableSqlMemory(): Promise<void> { throw new Error("Method not implemented."); }
    disableSqlMemory(): Promise<void> { throw new Error("Method not implemented."); }
    clearSqlMemory(): Promise<void> { throw new Error("Method not implemented."); }
    loadSqlMemory(): Promise<string[]> { throw new Error("Method not implemented."); }
    getMemorySql(): SqlInMemory { 
        // Mark as not implemented for now, as internal Query type is problematic
        throw new Error("getMemorySql not implemented for PGLite driver."); 
    }
    // Add stream stub back to satisfy interface, even if not used
    stream(query: string, parameters?: any[], onEnd?: Function, onError?: Function): Promise<any> { 
        throw new Error("Streaming queries are not directly supported by this PGLite driver implementation."); 
    }
    // Deprecated methods
    // getTable(tableName: string): Promise<Table | undefined> { throw new Error("Method not implemented."); }
    // getView(viewName: string): Promise<View | undefined> { throw new Error("Method not implemented."); }
    // getReplicationMode(): ReplicationMode { return this.mode; }

    /**
     * Override createQueryBuilder to prevent recursion.
     * Uses QueryBuilderFactory to create a SelectQueryBuilder directly without circular reference.
     */
    createQueryBuilder<Entity extends ObjectLiteral>(
        entityTarget?: EntityTarget<Entity>,
        alias?: string
    ): SelectQueryBuilder<Entity> {
        if (!this.connection) {
            throw new Error("QueryRunner does not have a valid connection.");
        }
        
        if (!entityTarget) {
            throw new Error("Entity target is required for QueryRunner's createQueryBuilder");
        }
        
        if (!alias) {
            alias = typeof entityTarget === 'function' ? entityTarget.name : 
                   typeof entityTarget === 'string' ? entityTarget : 'unnamedEntity';
        }
        
        // Use the factory to create the query builder directly
        return QueryBuilderFactory.createSelectQueryBuilder(
            this.connection,
            entityTarget,
            alias,
            this // Pass this query runner
        );
    }
} 