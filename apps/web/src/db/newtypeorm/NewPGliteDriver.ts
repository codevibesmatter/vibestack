/**
 * New PGLiteDriver implementation for TypeORM
 * 
 * This is a modified version of the PGLiteDriver implementation in typeorm/driver/pglite/PGLiteDriver.js
 * 
 * It is used to connect to a PGLite database and provide a TypeORM driver interface.
 * 
 * 
 **/

import {
    DataSource,
    Driver,
    ObjectLiteral,
    TableColumn,
    ColumnType,
    ReplicationMode,
    DataSourceOptions,
    DriverOptionNotSetError,
    QueryRunner,
    EntityMetadata as TypeOrmEntityMetadata,
    Table,
    View,
    TableForeignKey,
} from 'typeorm';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata.js';
import { NamingStrategyInterface } from 'typeorm/naming-strategy/NamingStrategyInterface.js';
import { DefaultNamingStrategy } from 'typeorm/naming-strategy/DefaultNamingStrategy.js';
import { PostgresConnectionCredentialsOptions } from "typeorm/driver/postgres/PostgresConnectionCredentialsOptions.js";

// Local/Project Imports
import { getDatabase } from '../db.ts';
import { NewPGliteQueryRunner } from './NewPGliteQueryRunner';

// Define types not commonly exported from 'typeorm' directly if needed
// Based on typeorm/driver/types/UpsertType.d.ts
type UpsertType = "on-conflict-do-update" | "on-duplicate-key-update" | "primary-key"

// --- Simple Pluralize (as StringUtils.js doesn't seem to export it) ---
function pluralize(word: string): string {
    if (word.endsWith('y') && !['a','e','i','o','u'].includes(word.charAt(word.length-2))) {
        return word.slice(0, -1) + 'ies';
    }
    if (word.endsWith('s') || word.endsWith('x') || word.endsWith('z') || word.endsWith('ch') || word.endsWith('sh')) {
        return word + 'es';
    }
    return word + 's';
}

// --- Driver Options --- 
export interface NewPGliteDriverOptions extends Omit<PostgresConnectionCredentialsOptions, 'type'> {
    readonly database: string;
    readonly dataDir?: string;
    readonly extensions?: Record<string, any>;
    readonly schema?: string;
    readonly namingStrategy?: NamingStrategyInterface; // Allow passing naming strategy
}

// --- Custom Error ---
class PGLiteDriverError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PGLiteDriverError';
    }
}

// --- Define internal types locally --- 

// Based on typeorm/driver/types/MappedColumnTypes.d.ts
// Remove '| string' as Driver expects strict ColumnType
interface MappedColumnTypes {
    createDate: ColumnType
    createDateDefault: string
    createDatePrecision?: number
    updateDate: ColumnType
    updateDateDefault: string
    updateDatePrecision?: number
    deleteDate: ColumnType
    deleteDateDefault?: string | null
    deleteDatePrecision?: number
    deleteDateNullable: boolean
    version: ColumnType
    treeLevel: ColumnType
    treePath: ColumnType
    migrationId: ColumnType
    migrationName: ColumnType
    migrationTimestamp: ColumnType
    cacheId: ColumnType
    cacheIdentifier: ColumnType
    cacheTime: ColumnType
    cacheDuration: ColumnType
    cacheQuery: ColumnType
    cacheResult: ColumnType
    metadataType: ColumnType
    metadataDatabase: ColumnType
    metadataSchema: ColumnType
    metadataTable: ColumnType
    metadataName: ColumnType
    metadataValue: ColumnType
}

// Based on typeorm/driver/types/DataTypeDefaults.d.ts
interface DataTypeDefaults {
    [key: string]: {
        length?: number
        width?: number
        precision?: number
        scale?: number
    }
}

// Based on typeorm/driver/types/CteCapabilities.d.ts
interface CteCapabilities {
    enabled: boolean
    requiresRecursiveHint?: boolean
    materializedHint?: boolean
}

// Based on typeorm/driver/types/IsolationLevel.d.ts
type IsolationLevel = "READ UNCOMMITTED" | "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

// --- Driver Implementation ---
export class NewPGliteDriver implements Driver {
    // -------------------------------------------------------------------------
    // Public Properties
    // -------------------------------------------------------------------------

    /** Driver connection options - satisfies Driver interface */
    options: DataSourceOptions;

    // Internal options with specific type
    private _options: NewPGliteDriverOptions & Partial<DataSourceOptions>;

    /** Underlying PGLite connection */
    pglite: any | null = null;

    /** Master connection used by query runner. */
    master: any | null = null;

    /** Database name used by this driver instance. */
    database?: string;

    /** Schema name used by this driver instance. */
    schema?: string;

    /** Connection used by driver. */
    connection!: DataSource;

    /** Indicates if replication is enabled. (Not applicable for PGLite) */
    isReplicated: boolean = false;

    /** Indicates if tree tables are supported by this driver. */
    treeSupport: boolean = true;

    /** Represent transaction support by this driver */
    transactionSupport: "nested" | "simple" | "none" = "nested";

    /** Supported upsert types - using Postgres capabilities */
    supportedUpsertTypes: UpsertType[] = ["on-conflict-do-update"];

    /** Gets list of supported column data types by a driver. */
    supportedDataTypes: ColumnType[] = [
        "int", "int2", "int4", "int8", "smallint", "integer", "bigint",
        "decimal", "numeric", "real", "float", "float4", "float8",
        "double precision", "money", "character varying", "varchar",
        "character", "char", "text", "citext", "hstore", "bytea", "bit",
        "varbit", "bit varying", "timetz", "timestamptz", "timestamp",
        "timestamp without time zone", "timestamp with time zone", "date",
        "time", "time without time zone", "time with time zone", "interval",
        "bool", "boolean", "enum", "point", "line", "lseg", "box", "path",
        "polygon", "circle", "cidr", "inet", "macaddr", "tsvector", "tsquery",
        "uuid", "xml", "json", "jsonb"
    ];

    /** Gets list of spatial column data types. */
    spatialTypes: ColumnType[] = [];

    /** Gets list of column data types that support length by a driver. */
    withLengthColumnTypes: ColumnType[] = [
        "character varying",
        "varchar",
        "character",
        "char",
        "bit",
        "varbit",
        "bit varying"
    ];

    /** Gets list of column data types that support precision by a driver. */
    withPrecisionColumnTypes: ColumnType[] = [
        "numeric",
        "decimal",
        "time",
        "time with time zone",
        "timestamp",
        "timestamp with time zone",
        "interval"
    ];

    /** Gets list of column data types that support scale by a driver. */
    withScaleColumnTypes: ColumnType[] = ["numeric", "decimal"];

    /** Gets list of column data types that support UNSIGNED by a driver. */
    unsignedColumnTypes: ColumnType[] = [];

    /** Gets list of column data types that support ZEROFILL by a driver. */
    zerofillColumnTypes: ColumnType[] = [];

    /** ORM has special columns and relations types. */
    mappedDataTypes: MappedColumnTypes = {
        createDate: "timestamp", createDateDefault: "now()",
        updateDate: "timestamp", updateDateDefault: "now()",
        deleteDate: "timestamp", deleteDateNullable: true, // Default null is handled by TypeORM
        version: "int4",
        treeLevel: "int4",
        treePath: "varchar", // Assuming varchar, adjust if needed
        migrationId: "int4",
        migrationName: "varchar",
        migrationTimestamp: "int8", // Use bigint for timestamp
        cacheId: "int4",
        cacheIdentifier: "varchar",
        cacheTime: "int8", // Use bigint for timestamp
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

    /** Default values of length, precision and scale */
    dataTypeDefaults: DataTypeDefaults = {
        "character": { length: 1 },
        "bit": { length: 1 },
        "interval": { precision: 6 },
        "time without time zone": { precision: 6 },
        "time with time zone": { precision: 6 },
        "timestamp without time zone": { precision: 6 },
        "timestamp with time zone": { precision: 6 }
    };

    /** Max length allowed by Postgres for aliases. */
    maxAliasLength = 63;

    /** PGLite uses Postgres CTE capabilities */
    cteCapabilities: CteCapabilities = {
        enabled: true,
        requiresRecursiveHint: true,
        materializedHint: true
    };

    /** Parameter prefix - using Postgres style */
    parametersPrefix = "$";

    /** Indicates if driver is initialized */
    isInitialized = false;

    /** Naming strategy */
    namingStrategy: NamingStrategyInterface;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(options: NewPGliteDriverOptions & Partial<DataSourceOptions>) {
        // Store the complete options for the base DataSource
        this.options = options as DataSourceOptions; 
        // Store the driver-specific options for internal use
        this._options = options; 

        if (!this._options.database) {
            throw new DriverOptionNotSetError("database");
        }

        this.database = this._options.database;
        this.schema = this._options.schema;
        // Use provided naming strategy or default Postgres-like one
        this.namingStrategy = options.namingStrategy || new DefaultNamingStrategy(); 

        console.log(`NewPGliteDriver constructor called for database: ${this.database}`);
        this.isInitialized = false;
    }

    // -------------------------------------------------------------------------
    // Public Methods Required by Driver Interface
    // -------------------------------------------------------------------------

    async connect(): Promise<void> {
        if (this.pglite) {
            console.warn("NewPGliteDriver: Already connected.");
            return;
        }
        try {
            console.log(`NewPGliteDriver: Connecting to PGLite (dataDir: ${this._options.dataDir})...`);
            this.pglite = await getDatabase(); 
            this.master = this.pglite;
            this.isInitialized = true;
            console.log("NewPGliteDriver: PGLite instance acquired.");
        } catch (error) {
            console.error("NewPGliteDriver: PGLite connection error", error);
            this.isInitialized = false;
            throw new PGLiteDriverError(`Failed to connect to PGLite: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async disconnect(): Promise<void> {
        if (!this.pglite) {
            console.warn("NewPGliteDriver: Already disconnected.");
            return;
        }
        // Add PGLite close logic if available
        // await this.pglite.close(); 
        console.log("NewPGliteDriver: Disconnecting");
        this.pglite = null;
        this.master = null;
        this.isInitialized = false;
    }
    
    async afterConnect(): Promise<void> {
        // Placeholder: run setup queries if needed
        console.log("NewPGliteDriver: afterConnect hook executed.");
    }

    createSchemaBuilder(): any { // Return type should be SchemaBuilder
        console.warn("NewPGliteDriver: createSchemaBuilder returning basic object. Schema operations might not work fully yet.");
        // Consider importing and using PostgresSchemaBuilder if compatible
        // import { PostgresSchemaBuilder } from "typeorm/driver/postgres/PostgresSchemaBuilder.js";
        // return new PostgresSchemaBuilder(this.connection);
        return { log: () => {}, build: () => {} }; // Minimal stub
    }

    createQueryRunner(mode: ReplicationMode = "master"): QueryRunner { 
        if (!this.master)
            throw new PGLiteDriverError("Driver not connected. Call connect() first.");
        const runner = new NewPGliteQueryRunner(this);
        // The runner should get the DataSource connection reference from the driver
        runner.connection = this.connection; // Assign the DataSource instance (NewPGliteDataSource)
        runner.manager = this.connection.manager; // Assign the EntityManager from the DataSource
        return runner;
    }

    /**
     * Performs the actual database query. Should generally not be used directly.
     */
    async query(query: string, parameters?: any[]): Promise<any> {
        if (!this.isInitialized || !this.pglite) {
            throw new PGLiteDriverError("Driver is not connected. Cannot execute query.");
        }
        console.warn("NewPGliteDriver.query called directly. Use QueryRunner for transactions and proper management.");
        try {
            return await this.pglite.query(query, parameters);
        } catch (error) {
            console.error(`Error executing query: ${query}`, parameters, error);
            throw error; // Re-throw the original error for better stack trace
        }
    }

    // --- Re-added missing Driver methods --- 

    /**
     * Replaces parameters in the given sql with special escaping character
     * and an array of parameter names to be passed to a query.
     * (Copied logic from PostgresDriver)
     */
    escapeQueryWithParameters(
        sql: string,
        parameters: ObjectLiteral,
        nativeParameters: ObjectLiteral,
    ): [string, any[]] {
        const escapedParameters: any[] = Object.keys(nativeParameters).map(
            (key) => nativeParameters[key],
        );

        if (!parameters || !Object.keys(parameters).length)
            return [sql, escapedParameters];

        sql = sql.replace(
            /:(\.{3})?([A-Za-z0-9_.]+)/g,
            (match, isSpread: string, key: string): string => {
                 // Found parameter
                let parameterValue:
                    | ObjectLiteral
                    | Map<any, any>
                    | any[]
                    | any

                if (parameters[key] !== undefined) {
                    parameterValue = parameters[key]
                } else if (nativeParameters[key] !== undefined) {
                    parameterValue = nativeParameters[key]
                } else {
                    return match
                }

                if (isSpread) {
                    if (!Array.isArray(parameterValue)) {
                         throw new PGLiteDriverError(
                            `Unsupported spread parameter type given for (${key}). Supported only "any[]" type.`, 
                         )
                    }

                    if (parameterValue.length === 0)
                        return match

                    // Create multiple placeholders: $1, $2, $3...
                    return parameterValue
                        .map((value) => {
                            escapedParameters.push(value); 
                            return this.createParameter(key, escapedParameters.length - 1);
                        })
                        .join(", ");
                } else {
                    escapedParameters.push(parameterValue);
                    return this.createParameter(key, escapedParameters.length - 1);
                }
            },
        );

        return [sql, escapedParameters];
    }

    /**
     * Escapes a column name.
     * (Copied logic from PostgresDriver)
     */
    escape(name: string): string {
        // Avoid double escaping
        if (name.startsWith("\"") && name.endsWith("\""))
            return name;
        return `"${name}"`;
    }

    /**
     * Build full table name with schema name and table name.
     * (Copied logic from PostgresDriver)
     */
    buildTableName(
        tableName: string,
        schema?: string,
        database?: string,
    ): string {
        let tablePath = tableName;
        // Use this.schema (from constructor options) or passed schema
        const driverSchema = this.schema; 
        const usedSchema = schema || driverSchema; // Prioritize explicit schema

        if (usedSchema) {
             // Add schema prefix if usedSchema is defined
             tablePath = `${usedSchema}.${tableName}`;
        }
       
        // Handle database prefixing (less common for PGLite, but follows PG logic)
        // Database prefix only applies if schema is not explicitly part of tablePath already
        if (database && !tablePath.includes('.')) { 
            tablePath = `${database}.${tablePath}`;
        } else if (database && usedSchema && database !== usedSchema && !tablePath.startsWith(database + '.')) {
             // This case handles database.schema.table when db and schema differ
             tablePath = `${database}.${usedSchema}.${tableName}`;
        } else if (database && usedSchema && database === usedSchema && !tablePath.startsWith(database + '.')) {
            // Handles case where db and schema are same, ensure db prefix isn't duplicated
             tablePath = `${database}.${tableName}`;
        }

        // Always quote identifiers in the final path
        return tablePath.split(".").map(part => this.escape(part)).join(".");
    }

    /**
     * Parses the given table name and returns table name, schema name and database name.
     * (Copied logic from PostgresDriver)
     */
    parseTableName(target: TypeOrmEntityMetadata | Table | View | TableForeignKey | string): {
        database?: string
        schema?: string
        tableName: string
    } {
        let tablePathString: string | undefined;

        if (typeof target === "string") {
            tablePathString = target;
        } else if (target instanceof Table || target instanceof View) {
            tablePathString = target.name;
        } else if (target instanceof TypeOrmEntityMetadata) {
            tablePathString = target.tablePath;
        } else if (target instanceof TableForeignKey) {
            // Corrected property name
            tablePathString = target.referencedTableName; 
        }

        if (!tablePathString) {
            // Handle cases where name/path might be missing
            // Maybe derive from target.constructor.name if it's a class?
            console.error("Could not determine table path for target:", target);
            return { tableName: "" }; 
        }
        
        // Safely use string methods now
        const parts = tablePathString.includes(".") ? tablePathString.split(".") : [tablePathString];
        let database: string | undefined = undefined;
        let schema: string | undefined = undefined;
        let tableName: string;

        if (parts.length === 3) {
            database = parts[0];
            schema = parts[1];
            tableName = parts[2];
        } else if (parts.length === 2) {
            schema = parts[0];
            tableName = parts[1];
            database = this.database; // Assign driver db if schema is specified
        } else {
            tableName = parts[0];
            schema = this.schema; // Assign driver schema if only table is specified
            database = this.database; // Assign driver db if only table is specified
        }

        return {
            database: database,
            schema: schema,
            tableName: tableName,
        }
    }
    
    // --- End Re-added missing Driver methods --- 

    /**
     * Prepares given value to be inserted into the database.
     * (Adapting PostgresDriver logic)
     */
    preparePersistentValue(value: any, columnMetadata: ColumnMetadata): any { 
        if (columnMetadata.isGenerated && value === undefined)
            return undefined;
        if (value === null || value === undefined)
             return value;

        if (columnMetadata.transformer) {
            value = Array.isArray(columnMetadata.transformer) ? 
                    columnMetadata.transformer.reduce((v, t) => t.to(v), value) :
                    columnMetadata.transformer.to(value);
        }

        switch (columnMetadata.type) {
            case "json":
            case "jsonb": // Treat jsonb same as json for stringify
                return JSON.stringify(value);
            case "timetz":
            case "timestamptz":
            case Date:
            case "timestamp":
            case "timestamp without time zone":
            case "timestamp with time zone":
                return (value instanceof Date) ? value.toISOString() : value;
            case "time":
            case "time without time zone":
            case "time with time zone":
                 return (value instanceof Date) ? value.toTimeString().split(' ')[0] : value;
            case "date":
                // Format date as YYYY-MM-DD
                if (value instanceof Date) {
                    return `${value.getFullYear()}-${("0" + (value.getMonth() + 1)).slice(-2)}-${("0" + value.getDate()).slice(-2)}`;
                }
                return value;
            case "bool":
            case "boolean":
                return value ? 1 : 0;
            case "bytea":
                 if (typeof value === "string") {
                    // If it's a hex string from PGLite, convert it back
                    if (value.startsWith('\\x')) {
                        return Buffer.from(value.substring(2), 'hex');
                    }
                    return Buffer.from(value); // Assume regular string needs buffer conversion
                }
                if (Buffer.isBuffer(value)) {
                    return value;
                }
                return value; // Pass other types (like Uint8Array?) as is
            case "uuid":
                 // Ensure UUIDs are strings
                return String(value);
            // Handle numeric types that might be large
            case "int8": // bigint
            case "bigint":
                // Ensure BigInts are stringified if PGLite expects strings
                return typeof value === 'bigint' ? value.toString() : value;
            case "numeric":
            case "decimal":
                 // Ensure numbers are strings if needed by PGLite
                 return String(value);
        }
        return value;
    }

    /**
     * Prepares given value retrieved from the database.
     * (Adapting PostgresDriver logic)
     */
    prepareHydratedValue(value: any, columnMetadata: ColumnMetadata): any { 
         if (value === null || value === undefined) return value;

         const originalValue = value;
         // console.log(`[Driver] prepareHydratedValue - START - Col: ${columnMetadata.propertyName}, DB Type: ${columnMetadata.type}, Raw Value:`, originalValue);

         // Apply transformers first
         if (columnMetadata.transformer) {
             try {
                 value = Array.isArray(columnMetadata.transformer) ? 
                         columnMetadata.transformer.reduceRight((v, t) => t.from(v), value) :
                         columnMetadata.transformer.from(value);
                 // console.log(`[Driver] prepareHydratedValue - AFTER TRANSFORMER - Col: ${columnMetadata.propertyName}, Transformed Value:`, value);
             } catch (e) {
                 console.error(`[Driver] Error applying transformer for ${columnMetadata.propertyName}:`, e);
                 // Decide how to handle transformer errors - maybe return original value or throw?
                 // return originalValue; 
                 throw e; // Re-throwing might be better to surface the error
             }
         }

         let hydratedValue = value; // Assign transformed value initially

         switch (columnMetadata.type) {
             case "json":
             case "jsonb":
                 hydratedValue = (typeof value === "string") ? JSON.parse(value) : value;
                 break;
             case Date:
             case "date":
                 // Convert YYYY-MM-DD string back to Date (adjust time if needed)
                 hydratedValue = (typeof value === "string") ? new Date(value + 'T00:00:00Z') : value;
                 break;
             case "timestamp":
             case "timestamp with time zone":
             case "timestamp without time zone":
                 // Standard ISO string to Date
                 hydratedValue = (typeof value === "string") ? new Date(value) : value;
                 break;
            case "timetz": // Time with timezone - return as string for simplicity
            case "timestamptz": // Timestamp with timezone - should already be Date from above
                 hydratedValue = value;
                 break;
            case "time":
            case "time without time zone":
            case "time with time zone":
                 // Return time string as is
                 hydratedValue = value;
                 break;
             case "bool":
             case "boolean":
                 // Handle 1/0 or t/f from DB
                 if (typeof value === 'boolean') hydratedValue = value;
                 else if (value === 't' || value === '1') hydratedValue = true;
                 else if (value === 'f' || value === '0') hydratedValue = false;
                 else hydratedValue = Boolean(value);
                 break;
             case "bytea":
                 // If PGLite returns hex string (e.g., \x...), convert to Buffer
                 if (typeof value === 'string' && value.startsWith('\\x')) { // Double backslash needed for literal comparison
                     hydratedValue = Buffer.from(value.substring(2), 'hex');
                 } else if (value instanceof Uint8Array) { // If it returns Uint8Array, convert to Buffer
                    hydratedValue = Buffer.from(value);
                 }
                 // Otherwise assume it's Buffer or correct type
                 break;
            case "int8":
            case "bigint":
                 // Convert string representations of bigint back to BigInt
                 if (value === null) hydratedValue = null;
                 else hydratedValue = typeof value === 'string' ? BigInt(value) : value;
                 break;
            case "numeric":
            case "decimal":
                 // Convert string representations back to number (or use a decimal library)
                 if (value === null) hydratedValue = null;
                 else hydratedValue = typeof value === 'string' ? parseFloat(value) : value;
                 break;
            case "uuid":
                 // Return as string
                 hydratedValue = value;
                 break;
            // Add handling for array types if needed
            default:
                 if (columnMetadata.isArray && typeof value === 'string') {
                     // Basic PG array parsing (needs refinement for complex types/quoting)
                     if (value.startsWith('{') && value.endsWith('}')) {
                        const arrayString = value.substring(1, value.length - 1);
                        // Handle empty array string '{}'
                        if (arrayString === '') {
                            hydratedValue = [];
                        } else {
                             // Split by comma, trim whitespace. Needs more robust parsing for quoted elements etc.
                             hydratedValue = arrayString.split(',').map(item => item.trim()); 
                             // TODO: Add further type conversion based on columnMetadata.type if elements are not strings
                        }
                     } else {
                         // Log if it doesn't look like a PG array string
                         console.warn(`[Driver] Expected array string for ${columnMetadata.propertyName} but got:`, value);
                     }
                 }
                 // Keep original value if no specific conversion applied
                 break;
         }

         // console.log(`[Driver] prepareHydratedValue - END - Col: ${columnMetadata.propertyName}, Final Value:`, hydratedValue);
         return hydratedValue;
    }

    /**
     * Creates composite column type for given column metadata.
     * (Adapting PostgresDriver logic)
     */
    normalizeType(column: {
        type?: ColumnType | string;
        length?: number | string;
        precision?: number | null;
        scale?: number;
        isArray?: boolean;
    }): string {
         if (column.type) {
            const type = column.type.toString().toLowerCase();
            let normalizedType = type;

            if (type === "int" || type === "integer") {
                normalizedType = "integer";
            } else if (type === "float") {
                normalizedType = "real";
            } else if (type === "datetime" || type === "datetime2") {
                normalizedType = "timestamp";
            } else if (type === "dec" || type === "fixed") {
                normalizedType = "decimal";
            } else if (type === "string" || type === "nvarchar" || type === "national varying character") {
                normalizedType = "varchar";
            } else if (type === "ntext" || type === "national text") {
                normalizedType = "text";
            } else if (type === "blob" || type === "clob") {
                normalizedType = "bytea";
            } else if (type === "boolean" || type === "bool") {
                normalizedType = "boolean";
            }

            // Handle types with precision/scale or length
            if ((normalizedType === "numeric" || normalizedType === "decimal") && column.precision !== undefined && column.precision !== null && column.scale !== undefined) {
                normalizedType += `(${column.precision},${column.scale})`;
            } else if ((normalizedType === "numeric" || normalizedType === "decimal") && column.precision !== undefined && column.precision !== null) {
                 normalizedType += `(${column.precision})`;
            } else if ((normalizedType === "character varying" || normalizedType === "varchar" || normalizedType === "character" || normalizedType === "char") && column.length) {
                normalizedType += `(${column.length})`;
            } else if ((normalizedType === "time" || normalizedType === "time without time zone" || normalizedType === "time with time zone" ||
                       normalizedType === "timestamp" || normalizedType === "timestamp without time zone" || normalizedType === "timestamp with time zone") && column.precision !== null && column.precision !== undefined) {
                 normalizedType += `(${column.precision})`;
            }
            
            // Handle array type
            if (column.isArray) {
                normalizedType += "[]";
            }

            return normalizedType;
        }
        return "";
    }
    
    /**
     * Normalizes "default" value of the column.
     * (Adapting PostgresDriver logic)
     */
    normalizeDefault(columnMetadata: ColumnMetadata): string | undefined { 
        const defaultValue = columnMetadata.default;
        if (defaultValue === null) {
            return undefined; // TypeORM handles null default during schema sync
        }

        if (typeof defaultValue === "string" || typeof defaultValue === "number" || typeof defaultValue === "boolean") {
             // Check for PostgreSQL keywords/functions
             const upperDefault = String(defaultValue).toUpperCase();
             if (upperDefault === "CURRENT_TIMESTAMP" || upperDefault === "NOW()" || upperDefault === "NULL" || 
                 upperDefault.startsWith("NEXTVAL(") || upperDefault.includes("()")) 
             {
                 return String(defaultValue); // Pass keywords/functions as is
             }
             // Otherwise, quote string literals
             if (typeof defaultValue === "string") {
                  return `'${defaultValue.replace(/'/g, "''")}'`;
             }
             // Numbers and booleans can be returned as strings
             return String(defaultValue);
        }
        
        // JSON/Object defaults need special handling if supported by PGLite
        if (typeof defaultValue === 'object' && defaultValue !== null) {
             return `'${JSON.stringify(defaultValue).replace(/'/g, "''")}'`;
        }

        return undefined;
    }

    /**
     * Normalizes "isUnique" value of the column.
     * (Copied from PostgresDriver)
     */
    normalizeIsUnique(column: ColumnMetadata): boolean {
        // Check if the column is part of a unique constraint applied only to this column
        return column.entityMetadata.uniques.some(
            (uq) => uq.columns.length === 1 && uq.columns[0] === column,
        )
    }

    /**
     * Returns column length from given column metadata.
     * (Adapting PostgresDriver logic)
     */
    getColumnLength(column: ColumnMetadata): string { 
        // Handle specific types that might use 'length' differently in Postgres
        if (column.type === "uuid" || column.type === "text" || column.type === "bytea" || 
            column.type.toString().includes("timestamp") || column.type.toString().includes("date") || 
            column.type.toString().includes("time") || column.type === "json" || column.type === "jsonb") {
            return ""; // These types don't typically have a user-defined length in PG
        }
        return column.length ? String(column.length) : "";
    }

    /**
     * Creates column type definition including length, precision and scale
     * (Adapting PostgresDriver logic)
     */
    createFullType(column: TableColumn): string {
        let type = column.type;
        if (column.length) {
            type += `(${column.length})`;
        } else if (column.precision !== null && column.precision !== undefined && column.scale !== null && column.scale !== undefined) {
            type += `(${column.precision},${column.scale})`;
        } else if (column.precision !== null && column.precision !== undefined) {
            // For time/timestamp types, precision means fractional seconds
             if (type === "time" || type === "timestamp" || type === "timestamptz" || type === "timetz") {
                  type += `(${column.precision})`;
            } else {
                 type += `(${column.precision})`; // For numeric/decimal
            }
        }

        if (column.isArray) {
            type += "[]";
        }

        return type;
    }

    /**
     * Obtains a new database connection to a master server.
     */
    obtainMasterConnection(): Promise<any> {
        if (!this.master) return Promise.reject(new PGLiteDriverError("Master connection not available."));
        return Promise.resolve(this.master);
    }

    /**
     * Obtains a new database connection to a slave server.
     */
    obtainSlaveConnection(): Promise<any> {
        // PGLite is single instance, return master
        return this.obtainMasterConnection();
    }

    /**
     * Creates generated map of values generated or returned by database after INSERT/UPDATE query.
     * Adapts standard TypeORM logic for handling RETURNING clauses.
     */
    createGeneratedMap(metadata: TypeOrmEntityMetadata, insertResult: any, entityIndex: number = 0) { 
        if (!insertResult) return undefined;

        // Handle different potential result formats from the query runner
        let resultRow: any;
        console.log(">>> [createGeneratedMap] Received raw result:", JSON.stringify(insertResult, null, 2));

        // Standard TypeORM result structure (QueryResult)
        if (insertResult.records && Array.isArray(insertResult.records) && insertResult.records.length > 0) {
            resultRow = insertResult.records[entityIndex] || insertResult.records[0];
        // Direct rows array (common)
        } else if (insertResult.rows && Array.isArray(insertResult.rows) && insertResult.rows.length > 0) {
            resultRow = insertResult.rows[entityIndex] || insertResult.rows[0];
        // Direct array of results
        } else if (Array.isArray(insertResult) && insertResult.length > 0) {
            resultRow = insertResult[entityIndex] || insertResult[0];
        // Single object result (e.g., single RETURNING column)
        } else if (typeof insertResult === 'object' && !Array.isArray(insertResult) && Object.keys(insertResult).length > 0) {
            resultRow = insertResult;
        }

        if (!resultRow || typeof resultRow !== 'object') {
            console.log(">>> [createGeneratedMap] Could not extract a valid result row.");
            return undefined;
        }

        console.log(">>> [createGeneratedMap] Processing resultRow:", JSON.stringify(resultRow));

        const generatedMap = {} as ObjectLiteral;

        // Iterate over the columns *returned by the database* in the resultRow
        for (const dbColumnName in resultRow) {
            if (Object.prototype.hasOwnProperty.call(resultRow, dbColumnName)) {
                // Find the corresponding ColumnMetadata in the entity
                // Check against databaseName first, then propertyName as fallback
                const columnMetadata = metadata.columns.find(col => 
                    col.databaseName === dbColumnName || col.propertyName === dbColumnName
                );

                if (columnMetadata) {
                    const value = resultRow[dbColumnName];
                    console.log(`>>> [createGeneratedMap] Found match for DB col '${dbColumnName}' -> Entity prop '${columnMetadata.propertyName}'. Raw Value:`, value);
                    if (value !== undefined && value !== null) {
                        // Use prepareHydratedValue to convert DB value back to JS value
                        try {
                            generatedMap[columnMetadata.propertyName] = this.prepareHydratedValue(value, columnMetadata);
                            console.log(`>>> [createGeneratedMap]   Hydrated Value for ${columnMetadata.propertyName}:`, generatedMap[columnMetadata.propertyName]);
                        } catch (e) {
                             console.error(`>>> [createGeneratedMap] Error hydrating value for ${columnMetadata.propertyName}:`, e);
                             // Decide if we should assign raw value or skip
                             // generatedMap[columnMetadata.propertyName] = value; // Assign raw on error?
                        }
                    } else {
                         console.log(`>>> [createGeneratedMap]   Value for ${dbColumnName} is undefined or null, skipping hydration.`);
                         // Assign null if that's the intended value and the property allows it
                         if (value === null && columnMetadata.isNullable) {
                             generatedMap[columnMetadata.propertyName] = null;
                         }
                    }
                } else {
                    console.warn(`>>> [createGeneratedMap] Could not find entity property metadata for returned DB column: ${dbColumnName}`);
                }
            }
        }

        console.log(">>> [createGeneratedMap] Final generatedMap:", JSON.stringify(generatedMap));
        return generatedMap;
    }

    /**
     * Differentiate columns of this table and columns from the given column metadatas columns
     * and returns only changed.
     * (Placeholder - needs full implementation for schema sync)
     */
    findChangedColumns(
        tableColumns: TableColumn[],
        columnMetadatas: ColumnMetadata[],
    ): ColumnMetadata[] { 
         console.warn("findChangedColumns is a placeholder and may not detect all changes.");
        // Basic check: find columns in metadata that are not in tableColumns (by name)
        // or columns where key properties (type, nullability, default) differ.
        return columnMetadatas.filter(metadataColumn => {
            const tableColumn = tableColumns.find(c => c.name === metadataColumn.databaseName);
            if (!tableColumn) {
                 return true; // Column is new
            } 
            // Add more detailed comparison logic here if schema sync is needed
            // e.g., compare normalizedType, isNullable, default value, etc.
            // const typeChanged = this.normalizeType(metadataColumn) !== tableColumn.type;
            // const nullabilityChanged = metadataColumn.isNullable !== tableColumn.isNullable;
            // ... etc
            return false; // Assume no changes for now
        });
    }

    /**
     * Returns true if driver supports RETURNING / OUTPUT statement.
     */
    isReturningSqlSupported(operation?: "insert" | "update" | "delete"): boolean { 
        // Always return true for all operations since PGlite supports RETURNING for all operations
        console.log(`>>> [isReturningSqlSupported] Called for operation: ${operation || 'unknown'}`);
        return true;
    }

    /**
     * Returns true if driver supports UUID generation strategy.
     */
    isUUIDGenerationSupported(): boolean { 
        return true; // Assume PGLite supports standard PG UUID functions
    }

    /**
     * Returns true if driver supports fulltext indices.
     */
    isFullTextColumnTypeSupported(): boolean { 
        return true; // Assume PGLite supports standard PG fulltext types
    }

    /**
     * Creates a database type for a given column metadata.
     */
    normalizeDatabaseType(columnMetadata: ColumnMetadata): string { 
        // `normalizeType` already handles the conversion based on PG conventions
        return this.normalizeType(columnMetadata);
    }

    // --- Schema manipulation stubs --- (Need implementation for schema sync)
    createTableSql(table: Table, createForeignKeys?: boolean): string {
        console.warn("NewPGliteDriver: createTableSql is a stub.");
        return "";
    }
    dropTableSql(tableOrName: Table | string, ifExist?: boolean): string {
        console.warn("NewPGliteDriver: dropTableSql is a stub.");
        return "";
    }
    createViewSql(view: View): string {
        console.warn("NewPGliteDriver: createViewSql is a stub.");
        return "";
    }
    dropViewSql(viewOrName: View | string): string {
         console.warn("NewPGliteDriver: dropViewSql is a stub.");
         return "";
    }
    
    // --- Helper / Internal --- 

    /**
     * Creates parameter placeholder ($1, $2, etc).
     */
    createParameter(parameterName: string, index: number): string {
        // Postgres uses 1-based positional parameters
        return "$" + (index + 1);
    }
} 