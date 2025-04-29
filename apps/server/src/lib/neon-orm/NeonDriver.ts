import { 
  DataSource,
    EntityManager,
  ObjectLiteral,
    QueryRunner,
  ReplicationMode,
  DataSourceOptions,
    Driver,
    ColumnType,
    TableColumn,
    EntityMetadata as TypeOrmEntityMetadata,
  FindOperator,
    EntityTarget,
    Table, View, TableForeignKey
} from 'typeorm';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata.js';
import { NamingStrategyInterface } from 'typeorm/naming-strategy/NamingStrategyInterface.js';
import { DefaultNamingStrategy } from 'typeorm/naming-strategy/DefaultNamingStrategy.js';
import { Client } from '@neondatabase/serverless';
import { NeonQueryRunner } from './NeonQueryRunner';
import { getDBClient } from '../db';
import { addConnectTimeout } from '../db';
import { InstanceChecker } from 'typeorm/util/InstanceChecker.js';
import { EntitySubscriberInterface } from 'typeorm';

// Re-define internal types locally or import if absolutely necessary
// These should match the standard TypeORM definitions for Postgres where possible
type UpsertType = "on-conflict-do-update";
type OnDeleteType = "RESTRICT" | "CASCADE" | "SET NULL" | "DEFAULT" | "NO ACTION";
type OnUpdateType = "RESTRICT" | "CASCADE" | "SET NULL" | "DEFAULT" | "NO ACTION";

interface MappedColumnTypes {
    createDate: ColumnType;
    createDateDefault: string;
    updateDate: ColumnType;
    updateDateDefault: string;
    deleteDate: ColumnType;
    deleteDateDefault: string | null;
    deleteDateNullable: boolean;
    version: ColumnType;
    treeLevel: ColumnType;
    treePath: ColumnType;
    migrationId: ColumnType;
    migrationName: ColumnType;
    migrationTimestamp: ColumnType;
    cacheId: ColumnType;
    cacheIdentifier: ColumnType;
    cacheTime: ColumnType;
    cacheDuration: ColumnType;
    cacheQuery: ColumnType;
    cacheResult: ColumnType;
    metadataType: ColumnType;
    metadataDatabase: ColumnType;
    metadataSchema: ColumnType;
    metadataTable: ColumnType;
    metadataName: ColumnType;
    metadataValue: ColumnType;
}

interface DataTypeDefaults {
    [key: string]: { length?: number; width?: number; precision?: number; scale?: number };
}

interface CteCapabilities {
    enabled: boolean;
    requiresRecursiveHint?: boolean;
    materializedHint?: boolean;
}

/**
 * Options specific to the Neon Serverless Driver
 */
export interface NeonDriverOptions {
  url: string;
    type: 'postgres';
    database?: string;
    schema?: string;
    namingStrategy?: NamingStrategyInterface;
    logging?: DataSourceOptions['logging'];
    synchronize?: boolean;
}

/**
 * Error class specific to Neon Driver issues
 */
class NeonDriverError extends Error {
  constructor(message: string) {
    super(message);
        this.name = 'NeonDriverError';
  }
}

// Implement Driver directly
export class NeonDriver implements Driver {
    // --- Driver Properties --- 
    options: NeonDriverOptions;
    connection!: DataSource; // Assigned by DataSource factory
    manager!: EntityManager; // Assigned by DataSource factory
    isInitialized: boolean = false;
    subscribers: EntitySubscriberInterface<any>[] = [];
    database?: string;
    schema?: string;
    slaves: any[] = []; // Neon serverless doesn't have slaves
    isReplicated: boolean = false;
    treeSupport: boolean = true;
    transactionSupport: "nested" | "simple" | "none" = "nested";
    nativeInterface: any;
    useUTC: boolean = false; // Default postgres value
    type: 'postgres' = 'postgres'; // Explicitly set type
    supportedDataTypes: ColumnType[] = [ // Standard Postgres types
        "int", "int2", "int4", "int8", "smallint", "integer", "bigint", "decimal", "numeric", "real", "float", "float4", "float8", "double precision", "money", "character varying", "varchar", "character", "char", "text", "citext", "hstore", "bytea", "bit", "varbit", "bit varying", "timetz", "timestamptz", "timestamp", "timestamp without time zone", "timestamp with time zone", "date", "time", "time without time zone", "time with time zone", "interval", "bool", "boolean", "enum", "point", "line", "lseg", "box", "path", "polygon", "circle", "cidr", "inet", "macaddr", "tsvector", "tsquery", "uuid", "xml", "json", "jsonb", "int4range", "int8range", "numrange", "tsrange", "tstzrange", "daterange", "geometry", "geography", "cube", "ltree"
    ];
  spatialTypes: ColumnType[] = ["geometry", "geography"];
    withLengthColumnTypes: ColumnType[] = ["character varying", "varchar", "character", "char", "bit", "varbit", "bit varying"];
    withPrecisionColumnTypes: ColumnType[] = ["numeric", "decimal", "time", "time with time zone", "timestamp", "timestamp without time zone", "interval"];
    withScaleColumnTypes: ColumnType[] = ["numeric", "decimal"];
    unsignedColumnTypes: ColumnType[] = [];
    zerofillColumnTypes: ColumnType[] = [];
    supportedUpsertTypes: UpsertType[] = ["on-conflict-do-update"];
    supportedOnDeleteTypes: OnDeleteType[] = ["RESTRICT", "CASCADE", "SET NULL", "NO ACTION"];
    supportedOnUpdateTypes: OnUpdateType[] = ["RESTRICT", "CASCADE", "SET NULL", "NO ACTION"];
    dataTypeDefaults: DataTypeDefaults = { // Standard Postgres defaults
    "character varying": { length: 255 },
    "varchar": { length: 255 },
    "character": { length: 1 },
        "char": { length: 1 },
        "interval": { precision: 6 },
        "time without time zone": { precision: 6 },
        "time with time zone": { precision: 6 },
        "timestamp without time zone": { precision: 6 },
        "timestamp with time zone": { precision: 6 }
    };
    mappedDataTypes: MappedColumnTypes = { // Standard TypeORM mappings
        createDate: "timestamp with time zone", createDateDefault: "now()",
        updateDate: "timestamp with time zone", updateDateDefault: "now()",
        deleteDate: "timestamp with time zone", deleteDateDefault: null, deleteDateNullable: true,
    version: "int4",
    treeLevel: "int4",
        treePath: "varchar",
    migrationId: "int4",
    migrationName: "varchar",
    migrationTimestamp: "int8",
    cacheId: "int4",
    cacheIdentifier: "varchar",
    cacheTime: "int8",
    cacheDuration: "int4",
    cacheQuery: "text",
    cacheResult: "text",
    metadataType: "varchar",
    metadataDatabase: "varchar",
    metadataSchema: "varchar",
    metadataTable: "varchar",
    metadataName: "varchar",
    metadataValue: "text"
    };
    maxAliasLength: number = 63;
    cteCapabilities: CteCapabilities = { enabled: true, requiresRecursiveHint: true, materializedHint: true };
  parametersPrefix: string = "$";
    namingStrategy: NamingStrategyInterface;

  constructor(options: NeonDriverOptions) {
        if (!options.url) {
            throw new NeonDriverError("`url` option is required for NeonDriver.");
        }
        this.options = options;
        this.namingStrategy = options.namingStrategy || new DefaultNamingStrategy();
        this.database = options.database;
        this.schema = options.schema;
    }

    // --- Essential Methods --- 

    async connect(): Promise<void> {
        try {
            console.log('NeonDriver: connect() called (no client connection initiated here).');
            if (!this.options.url) throw new NeonDriverError("URL is missing in options during connect.");
            
            this.isInitialized = true;
            console.log('NeonDriver: connect() finished successfully.');
        } catch (error) {
            console.error('NeonDriver: Error during connect setup:', error);
            this.isInitialized = false;
            throw new NeonDriverError(`Failed driver setup: ${error}`);
        }
    }

    async afterConnect(): Promise<void> {
        console.log('NeonDriver: afterConnect() called.');
    }

    async disconnect(): Promise<void> {
        try {
            console.log('NeonDriver: disconnect() called (no client connection to terminate here).');
            this.isInitialized = false;
            console.log('NeonDriver: disconnect() finished successfully.');
        } catch (error) {
            console.error('NeonDriver: Error during disconnect cleanup:', error);
            throw new NeonDriverError(`Error during driver cleanup: ${error}`);
        }
    }

    createQueryRunner(mode: ReplicationMode): QueryRunner {
        if (!this.isInitialized) {
            throw new NeonDriverError("Cannot create query runner - driver is not initialized.");
        }
        if (!this.connection) {
            throw new NeonDriverError("DataSource connection is not available on the driver.");
        }
         if (!this.manager) {
            throw new NeonDriverError("EntityManager is not available on the driver.");
        }
        return new NeonQueryRunner(this.connection, this.manager);
    }

    normalizeType(column: { type?: ColumnType | string; length?: number | string; precision?: number | null; scale?: number; isArray?: boolean; }): string {
        // Basic implementation, similar to PostgresDriver
        if (!column.type) return "";
        let type = typeof column.type === 'string' ? column.type.toLowerCase() : column.type.toString().toLowerCase();
        
        if (type === "real" || type === "float4") return "real";
        if (type === "double precision" || type === "float8") return "double precision";
        if (type === "decimal" || type === "numeric") {
            if (column.precision === null || !column.precision) return "numeric";
            if (column.scale === null || !column.scale) return `numeric(${column.precision})`;
            return `numeric(${column.precision},${column.scale})`;
        }
        if (type === "character varying" || type === "varchar") {
            if (column.length) return `varchar(${column.length})`;
            return "varchar";
        }
        if (type === "character" || type === "char") {
             if (column.length) return `char(${column.length})`;
             return "char";
        }
        if (type === "bit varying" || type === "varbit") {
            if (column.length) return `varbit(${column.length})`;
            return "varbit";
        }
        if (type === "bit") {
             if (column.length) return `bit(${column.length})`;
             return "bit";
        }
        if (type === "timetz" || type === "time with time zone") return "time with time zone";
        if (type === "timestamptz" || type === "timestamp with time zone") return "timestamp with time zone";
        if (type === "timestamp" || type === "timestamp without time zone") return "timestamp without time zone";
        if (type === "time" || type === "time without time zone") return "time without time zone";
        if (type === "int" || type === "integer" || type === "int4") return "integer";
        if (type === "int2" || type === "smallint") return "smallint";
        if (type === "int8" || type === "bigint") return "bigint";
        if (type === "bool" || type === "boolean") return "boolean";

        // Use original type if no specific normalization rule applies
        if (typeof column.type === 'string') {
            if (column.length) return `${column.type}(${column.length})`;
            if (column.precision !== null && column.precision !== undefined && column.scale !== null && column.scale !== undefined) return `${column.type}(${column.precision},${column.scale})`;
            if (column.precision !== null && column.precision !== undefined) return `${column.type}(${column.precision})`;
            return column.type;
        }
        
        return type; // Fallback
    }

    preparePersistentValue(value: any, columnMetadata: ColumnMetadata): any {
        if (value === null || value === undefined) return undefined;
        return value;
    }

    prepareHydratedValue(value: any, columnMetadata: ColumnMetadata): any {
        if (value === null || value === undefined) return undefined;
        // Type checking for hydration
        const type = columnMetadata.type;
        if (type === "numeric" || type === "decimal" || type === "bigint" || type === "int8") {
             if (typeof value === 'string') return Number(value); // Use Number cautiously
        } else if (type === "int" || type === "integer" || type === "int4" || type === "smallint" || type === "int2") {
             if (typeof value === 'string') return parseInt(value, 10);
        } else if (type === "date") {
            if (typeof value === 'string') return new Date(value); // Basic date parsing
        } else if (type === "timestamp" || type === "timestamp with time zone" || type === "timestamp without time zone") {
            if (typeof value === 'string') return new Date(value); // Basic timestamp parsing
        }
        return value;
    }

    escape(name: string): string {
        // Revert: Add quotes back, as TypeORM relies on this for columns/aliases
        return `"${name}"`; // Standard Postgres escape
        // return name;
    }

    createParameter(parameterName: string, index: number): string {
        return `$${index + 1}`; // Standard Postgres parameter format
    }
    
    formatQueryWithParameters(sql: string, parameters: ObjectLiteral, nativeParameters: ObjectLiteral): string {
        // This is a simplified version. A robust implementation might be needed if complex parameters are used.
        const escapedParameters = parameters instanceof Array ? parameters : Object.values(parameters);
        let i = 0;
        return sql.replace(/\?/g, () => {
            const param = escapedParameters[i];
            i++;
            if (param === null || param === undefined) return 'NULL';
            if (typeof param === 'number') return String(param);
            if (typeof param === 'boolean') return String(param);
            // Basic string escaping - THIS IS NOT SQL INJECTION SAFE for general use
            // TypeORM handles actual parameterization; this is more for logging/debugging.
            return "'" + String(param).replace(/'/g, "''") + "'";
        });
    }

    // Add required escapeQueryWithParameters method
  escapeQueryWithParameters(
    sql: string,
    parameters: ObjectLiteral, // Original parameters from .where etc.
    nativeParameters: ObjectLiteral // Parameters generated by TypeORM like { orm_param_0: value }
  ): [string, any[]] {
        console.log("NeonDriver.escapeQueryWithParameters: CALLED. SQL:", sql, "Params:", parameters, "Native Params:", nativeParameters);
        const driver = this;
        
        let paramsToUse: ObjectLiteral = nativeParameters; // Prioritize nativeParameters
        let sourceUsed: string = "nativeParameters";

        // Check if nativeParameters are effectively empty
        if (!nativeParameters || Object.keys(nativeParameters).length === 0) {
            // If nativeParameters is empty, check the other 'parameters' argument
            if (parameters && Object.keys(parameters).length > 0) {
                // This is where the "ERROR" log happens
                // console.error(`[${requestId}] NeonDriver.escapeQueryWithParameters: Native parameters empty, falling back to using 'parameters' argument.`);
                // Need to extract values from the 'parameters' object.
                // CRITICAL: The order might not match the SQL parameter placeholders ($1, $2)
                // This fallback is potentially unsafe if the order isn't guaranteed.
                paramsToUse = parameters;
                sourceUsed = "parameters";
            } else {
                 // If both are empty, return original SQL
                 console.log("NeonDriver.escapeQueryWithParameters: Both native and regular parameters empty, returning original SQL.");
                 return [sql, []];
            }
        }
        
        console.log(`NeonDriver.escapeQueryWithParameters: Using parameters from: ${sourceUsed}`);

        // Extract parameter values in the correct order based on the keys of the chosen source
        const orderedParams: any[] = [];
        // Sort keys numerically based on the index suffix (assuming orm_param_N format if native, or simple order if fallback)
        const paramKeys = Object.keys(paramsToUse).sort((a, b) => {
            // Adjust sorting logic slightly depending on source
            if (sourceUsed === "nativeParameters") {
                const idxA = parseInt(a.substring(a.lastIndexOf('_') + 1), 10);
                const idxB = parseInt(b.substring(b.lastIndexOf('_') + 1), 10);
                if (isNaN(idxA) || isNaN(idxB)) {
                    console.warn(`Could not parse indices for native parameters: ${a}, ${b}`);
                    return 0; 
                }
                return idxA - idxB;
            } else {
                 // For fallback 'parameters', assume simple keys or rely on insertion order (less reliable)
                 // A more robust fallback might need specific key mapping if keys aren't just 0, 1, 2...
                 // For now, let's try basic numeric sort if keys are numbers, otherwise default sort.
                 const numA = Number(a);
                 const numB = Number(b);
                 if (!isNaN(numA) && !isNaN(numB)) {
                     return numA - numB;
                 }
                 return a.localeCompare(b); // Default string sort for non-numeric keys
            }
        });

        paramKeys.forEach(key => {
            orderedParams.push(paramsToUse[key]);
        });

        // Replace named parameters (:orm_param_N) with positional parameters ($N+1)
        let paramIndex = 0;
        const transformedSql = sql.replace(/:orm_param_\d+/g, () => {
            paramIndex++;
            return driver.createParameter("", paramIndex - 1); 
        });

        // Basic validation
        if (paramKeys.length !== paramIndex) {
            console.error(`Parameter count mismatch in escapeQueryWithParameters: Expected ${paramKeys.length} from ${sourceUsed}, replaced ${paramIndex}. SQL: ${sql}`, paramsToUse);
        }
        
        console.log("NeonDriver.escapeQueryWithParameters: FINISHED. Transformed SQL:", transformedSql, "Ordered Params:", orderedParams);
        return [transformedSql, orderedParams];
    }

    // --- Stubbed Methods --- 

    createSchemaBuilder(): any {
        throw new NeonDriverError("Schema builder not implemented for NeonDriver.");
    }

    buildTableName(tableName: string, schema?: string, database?: string): string {
        // Modified: Escape schema if present, but return tableName unescaped
        // Assuming the caller (e.g., SelectQueryBuilder) will escape the final table path/name.
        return schema ? `${this.escape(schema)}.${tableName}` : tableName;
        // return schema ? `${this.escape(schema)}.${this.escape(tableName)}` : this.escape(tableName);
    }

    parseTableName(target: string | TypeOrmEntityMetadata | Table | View | TableForeignKey): { database?: string; schema?: string; tableName: string } {
        const driverDatabase = this.database;
        const driverSchema = this.schema;

        if (InstanceChecker.isEntityMetadata(target)) {
      return {
                database: target.database || driverDatabase,
                schema: target.schema || driverSchema,
                tableName: target.tableName,
            }
        }

        if (InstanceChecker.isTable(target) || InstanceChecker.isView(target)) {
            const { database, schema, name } = target;
            return {
                database: database || driverDatabase,
                schema: schema || driverSchema,
                tableName: name,
            }
        }
        
        if(InstanceChecker.isTableForeignKey(target)) {
            const { referencedDatabase, referencedSchema, referencedTableName } = target;
             return {
                database: referencedDatabase || driverDatabase,
                schema: referencedSchema || driverSchema,
                tableName: referencedTableName,
            }
        }

        // Handle string target (e.g., "schema.table" or "table")
        const parts = target.split(".");
        return {
            database: parts.length === 3 ? parts[0] : driverDatabase,
            schema: parts.length >= 2 ? parts[parts.length - 2] : driverSchema,
            tableName: parts[parts.length - 1],
        }
    }
    
    normalizeDefault(columnMetadata: ColumnMetadata): string | undefined {
         if (typeof columnMetadata.default === 'function') return undefined; // Functions not handled here
         if (columnMetadata.default === undefined || columnMetadata.default === null) return undefined;
         if (typeof columnMetadata.default === 'string') return "'" + columnMetadata.default + "'";
         return String(columnMetadata.default);
  }

  normalizeIsUnique(column: ColumnMetadata): boolean {
        // Check the uniques defined on the entity metadata
        return column.entityMetadata.uniques.some(uq => 
            uq.columns.length === 1 && uq.columns[0] === column
    );
  }

  getColumnLength(column: ColumnMetadata): string {
        return column.length ? String(column.length) : "";
  }

  createFullType(column: TableColumn): string {
        // Basic implementation
        let type = this.normalizeType(column);
        if (column.length) type += `(${column.length})`;
        else if (column.precision !== null && column.precision !== undefined && column.scale !== null && column.scale !== undefined) type += `(${column.precision},${column.scale})`;
        else if (column.precision !== null && column.precision !== undefined) type += `(${column.precision})`;
        if (column.isArray) type += "[]";
        return type;
    }

    async obtainMasterConnection(): Promise<any> {
        // throw new NeonDriverError("obtainMasterConnection is not applicable for this connectionless driver.");
         // Return a placeholder or handle as needed if called unexpectedly
         console.warn("obtainMasterConnection called on connectionless NeonDriver, returning null.");
         return null;
    }

    async obtainSlaveConnection(): Promise<any> {
        // throw new NeonDriverError("obtainSlaveConnection is not applicable for this connectionless driver.");
         console.warn("obtainSlaveConnection called on connectionless NeonDriver, returning null.");
         return null;
    }

    createGeneratedMap(metadata: TypeOrmEntityMetadata, insertResult: any, entityIndex?: number, entityNum?: number) {
        // insertResult here is the raw row object returned by RETURNING *
        if (!insertResult) return undefined;

        // Just return the raw row object directly. TypeORM's PlainObjectToDatabaseEntityTransformer
        // used later in the process will handle mapping these raw values to the entity.
        return insertResult; 
    }

    findChangedColumns(tableColumns: TableColumn[], columnMetadatas: ColumnMetadata[]): ColumnMetadata[] {
        // Stub - schema sync should handle this if used
        return [];
    }

    isReturningSqlSupported(): boolean { return true; }
    isUUIDGenerationSupported(): boolean { return true; } // Postgres supports uuid-ossp
    isFullTextColumnTypeSupported(): boolean { return true; }
    
    // ... other potential Driver methods can be stubbed ...
} 