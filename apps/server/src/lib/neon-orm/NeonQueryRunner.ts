import { QueryRunner, QueryResult, Table, View, TableColumn, TableIndex, TableForeignKey, TableUnique, TableCheck, TableExclusion, ReplicationMode, DataSource, EntityManager, ObjectLiteral } from "typeorm"
import { Broadcaster } from "typeorm/subscriber/Broadcaster.js"
import { SqlInMemory } from "typeorm/driver/SqlInMemory.js"
import { Query } from "typeorm/driver/Query.js"
import { Client } from "@neondatabase/serverless"
import { BroadcasterResult } from "typeorm/subscriber/BroadcasterResult.js"
import { QueryFailedError } from "typeorm"
import { NeonDataSourceOptions } from "./NeonDataSource"

// Copy SafeBroadcaster from NewPGliteQueryRunner
class SafeBroadcaster extends Broadcaster {
    private safeQueryRunner: QueryRunner
    constructor(queryRunner: QueryRunner) {
        super(queryRunner)
        this.safeQueryRunner = queryRunner
    }
    broadcastLoadEvent(result: BroadcasterResult, metadata: any, entities: any[]): void {
        try {
            // Skip entirely in Cloudflare environment to avoid I/O issues
            if (typeof (globalThis as any).navigator !== 'undefined' && (globalThis as any).navigator.userAgent?.includes('Cloudflare-Workers')) {
                console.warn("Running in Cloudflare Workers - skipping broadcastLoadEvent for compatibility");
                return;
            }
            
            if (!this.safeQueryRunner?.connection?.subscribers) {
                console.warn("Missing subscribers array on connection - skipping broadcastLoadEvent");
                return;
            }
            
            // Ensure subscribers is an array before calling filter
            if (!Array.isArray(this.safeQueryRunner.connection.subscribers)) {
                console.warn("Connection subscribers is not an array - skipping broadcastLoadEvent");
                return;
            }
            
            super.broadcastLoadEvent(result, metadata, entities);
        } catch (err) {
            console.error("Error in broadcastLoadEvent (safely caught):", err);
        }
    }
}

export class NeonQueryRunner implements QueryRunner {
    readonly connection: DataSource
    readonly broadcaster: Broadcaster
    readonly manager: EntityManager
    readonly isReleased: boolean = false
    readonly isTransactionActive: boolean = false
    data: ObjectLiteral = {}
    loadedTables: Table[] = []
    loadedViews: View[] = []
    private sqlMemoryMode: boolean = false
    private sqlInMemory: SqlInMemory = new SqlInMemory()

    constructor(
        connection: DataSource,
        manager: EntityManager
    ) {
        this.connection = connection
        this.manager = manager
        this.broadcaster = new SafeBroadcaster(this)
    }

    async connect(): Promise<any> {
        // No persistent client to return
        return Promise.resolve();
    }

    async beforeMigration(): Promise<void> {
        // No-op for now
    }

    async afterMigration(): Promise<void> {
        // No-op for now
    }

    async release(): Promise<void> {
        // No-op for now
    }

    async clearDatabase(database?: string): Promise<void> {
        // No-op for now
    }

    async startTransaction(): Promise<void> {
        // No-op for now
    }

    async commitTransaction(): Promise<void> {
        // No-op for now
    }

    async rollbackTransaction(): Promise<void> {
        // No-op for now
    }

    async query(query: string, parameters?: any[], useStructuredResult: boolean = false): Promise<any> {
        const queryId = `query-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        console.log(`[${queryId}] NeonQueryRunner.query: START. Query: ${query}`, parameters);

        this.connection.logger.logQuery(query, parameters, this);
        
        const queryStartTime = +new Date();
        
        // Assert connection options type to access url
        const neonOptions = this.connection.options as NeonDataSourceOptions;
        if (!neonOptions.url) {
            throw new Error("Database connection URL is missing in DataSource options.");
        }
        const client = new Client(neonOptions.url); // Use asserted options
        let raw: any;

        try {
            console.log(`[${queryId}] NeonQueryRunner.query: Connecting new client...`);
            await client.connect();
            console.log(`[${queryId}] NeonQueryRunner.query: Client connected. Executing query...`);
            
            raw = await client.query(query, parameters);
            console.log(`[${queryId}] NeonQueryRunner.query: Query executed. Raw result command: ${raw?.command}`);
            
            const queryEndTime = +new Date();
            const queryExecutionTime = queryEndTime - queryStartTime;
            console.log(`[${queryId}] NeonQueryRunner.query: Execution time: ${queryExecutionTime}ms`);

            if (this.connection.options?.maxQueryExecutionTime && queryExecutionTime > this.connection.options.maxQueryExecutionTime) {
                this.connection.logger.logQuerySlow(queryExecutionTime, query, parameters, this);
            }
            
            const result = new QueryResult();
            
            if (raw) {
                const safeRaw = {
                    command: raw.command,
                    rowCount: raw.rowCount,
                    rows: raw.rows
                };
                result.raw = safeRaw;
                
                if (raw.hasOwnProperty("rows")) {
                    // Store raw rows directly; TypeORM hydrator should handle mapping
                    result.records = raw.rows;
                }
                
                if (raw.hasOwnProperty("rowCount")) {
                    result.affected = raw.rowCount;
                }
                
                switch (raw.command) {
                    case "DELETE":
                    case "UPDATE":
                        result.raw = [safeRaw.rows, safeRaw.rowCount];
                        break;
                    default:
                        result.raw = safeRaw.rows;
                }
                
                if (!useStructuredResult) {
                     console.log(`[${queryId}] NeonQueryRunner.query: END (returning raw result)`);
                    // Return only the raw rows/data when not using structured result
                    return result.raw;
                }
            }
            
            // When useStructuredResult is true, return the full QueryResult object
            console.log(`[${queryId}] NeonQueryRunner.query: END (returning structured QueryResult)`);
            return result; // Return the standard QueryResult object
            
        } catch (err: any) {
            console.error(`[${queryId}] NeonQueryRunner.query: CATCH block. Error:`, err);
            this.connection.logger.logQueryError(err, query, parameters, this);
            const error = err instanceof Error ? err : new Error(String(err));
            throw new QueryFailedError(query, parameters, error);
        } finally {
            console.log(`[${queryId}] NeonQueryRunner.query: FINALLY block. Ending client connection...`);
            await client.end();
            console.log(`[${queryId}] NeonQueryRunner.query: Client connection ended.`);
        }
    }

    async stream(query: string, parameters?: any[], onEnd?: Function, onError?: Function): Promise<any> {
        throw new Error("Stream not implemented.");
    }

    async getDatabases(): Promise<string[]> {
        return [];
    }

    async getSchemas(database?: string): Promise<string[]> {
        return [];
    }

    async getTable(tablePath: string): Promise<Table | undefined> {
        return undefined;
    }

    async getTables(tablePaths?: string[]): Promise<Table[]> {
        return [];
    }

    async getView(viewPath: string): Promise<View | undefined> {
        return undefined;
    }

    async getViews(viewPaths?: string[]): Promise<View[]> {
        return [];
    }

    getReplicationMode(): ReplicationMode {
        return "master";
    }

    async hasDatabase(database: string): Promise<boolean> {
        return false;
    }

    async getCurrentDatabase(): Promise<string | undefined> {
        return undefined;
    }

    async hasSchema(schema: string): Promise<boolean> {
        return false;
    }

    async getCurrentSchema(): Promise<string | undefined> {
        return undefined;
    }

    async hasTable(table: Table | string): Promise<boolean> {
        return false;
    }

    async hasColumn(table: Table | string, columnName: string): Promise<boolean> {
        return false;
    }

    async createDatabase(database: string, ifNotExist?: boolean): Promise<void> {
        // No-op for now
    }

    async dropDatabase(database: string, ifExist?: boolean): Promise<void> {
        // No-op for now
    }

    async createSchema(schemaPath: string, ifNotExist?: boolean): Promise<void> {
        // No-op for now
    }

    async dropSchema(schemaPath: string, ifExist?: boolean, isCascade?: boolean): Promise<void> {
        // No-op for now
    }

    async createTable(table: Table, ifNotExist?: boolean, createForeignKeys?: boolean, createIndices?: boolean): Promise<void> {
        // No-op for now
    }

    async dropTable(table: Table | string, ifExist?: boolean, dropForeignKeys?: boolean, dropIndices?: boolean): Promise<void> {
        // No-op for now
    }

    async createView(view: View, syncWithMetadata?: boolean, oldView?: View): Promise<void> {
        // No-op for now
    }

    async dropView(view: View | string): Promise<void> {
        // No-op for now
    }

    async renameTable(oldTableOrName: Table | string, newTableName: string): Promise<void> {
        // No-op for now
    }

    async changeTableComment(tableOrName: Table | string, comment?: string): Promise<void> {
        // No-op for now
    }

    async addColumn(table: Table | string, column: TableColumn): Promise<void> {
        // No-op for now
    }

    async addColumns(table: Table | string, columns: TableColumn[]): Promise<void> {
        // No-op for now
    }

    async renameColumn(table: Table | string, oldColumnOrName: TableColumn | string, newColumnOrName: TableColumn | string): Promise<void> {
        // No-op for now
    }

    async changeColumn(table: Table | string, oldColumn: TableColumn | string, newColumn: TableColumn): Promise<void> {
        // No-op for now
    }

    async changeColumns(table: Table | string, changedColumns: { oldColumn: TableColumn; newColumn: TableColumn }[]): Promise<void> {
        // No-op for now
    }

    async dropColumn(table: Table | string, column: TableColumn | string): Promise<void> {
        // No-op for now
    }

    async dropColumns(table: Table | string, columns: TableColumn[] | string[]): Promise<void> {
        // No-op for now
    }

    async createPrimaryKey(table: Table | string, columnNames: string[], constraintName?: string): Promise<void> {
        // No-op for now
    }

    async updatePrimaryKeys(table: Table | string, columns: TableColumn[]): Promise<void> {
        // No-op for now
    }

    async dropPrimaryKey(table: Table | string, constraintName?: string): Promise<void> {
        // No-op for now
    }

    async createUniqueConstraint(table: Table | string, uniqueConstraint: TableUnique): Promise<void> {
        // No-op for now
    }

    async createUniqueConstraints(table: Table | string, uniqueConstraints: TableUnique[]): Promise<void> {
        // No-op for now
    }

    async dropUniqueConstraint(table: Table | string, uniqueOrName: TableUnique | string): Promise<void> {
        // No-op for now
    }

    async dropUniqueConstraints(table: Table | string, uniqueConstraints: TableUnique[]): Promise<void> {
        // No-op for now
    }

    async createCheckConstraint(table: Table | string, checkConstraint: TableCheck): Promise<void> {
        // No-op for now
    }

    async createCheckConstraints(table: Table | string, checkConstraints: TableCheck[]): Promise<void> {
        // No-op for now
    }

    async dropCheckConstraint(table: Table | string, checkOrName: TableCheck | string): Promise<void> {
        // No-op for now
    }

    async dropCheckConstraints(table: Table | string, checkConstraints: TableCheck[]): Promise<void> {
        // No-op for now
    }

    async createExclusionConstraint(table: Table | string, exclusionConstraint: TableExclusion): Promise<void> {
        // No-op for now
    }

    async createExclusionConstraints(table: Table | string, exclusionConstraints: TableExclusion[]): Promise<void> {
        // No-op for now
    }

    async dropExclusionConstraint(table: Table | string, exclusionOrName: TableExclusion | string): Promise<void> {
        // No-op for now
    }

    async dropExclusionConstraints(table: Table | string, exclusionConstraints: TableExclusion[]): Promise<void> {
        // No-op for now
    }

    async createForeignKey(table: Table | string, foreignKey: TableForeignKey): Promise<void> {
        // No-op for now
    }

    async createForeignKeys(table: Table | string, foreignKeys: TableForeignKey[]): Promise<void> {
        // No-op for now
    }

    async dropForeignKey(table: Table | string, foreignKeyOrName: TableForeignKey | string): Promise<void> {
        // No-op for now
    }

    async dropForeignKeys(table: Table | string, foreignKeys: TableForeignKey[]): Promise<void> {
        // No-op for now
    }

    async createIndex(table: Table | string, index: TableIndex): Promise<void> {
        // No-op for now
    }

    async createIndices(table: Table | string, indices: TableIndex[]): Promise<void> {
        // No-op for now
    }

    async dropIndex(table: Table | string, index: TableIndex | string): Promise<void> {
        // No-op for now
    }

    async dropIndices(table: Table | string, indices: TableIndex[]): Promise<void> {
        // No-op for now
    }

    async clearTable(tableName: string): Promise<void> {
        // No-op for now
    }

    enableSqlMemory(): void {
        this.sqlMemoryMode = true
        this.sqlInMemory = new SqlInMemory()
    }

    disableSqlMemory(): void {
        this.sqlMemoryMode = false
        this.sqlInMemory = new SqlInMemory()
    }

    clearSqlMemory(): void {
        this.sqlInMemory = new SqlInMemory()
    }

    getMemorySql(): SqlInMemory {
        return this.sqlInMemory
    }

    async executeMemoryUpSql(): Promise<void> {
        for (const query of this.sqlInMemory.upQueries) {
            await this.query(query.query, query.parameters)
        }
    }

    async executeMemoryDownSql(): Promise<void> {
        for (const query of this.sqlInMemory.downQueries.reverse()) {
            await this.query(query.query, query.parameters)
        }
    }
} 