import { useState, useEffect, useCallback } from 'react';
import { getDatabase, dbMessageBus } from '@/db/db';
import { 
  getDatabaseStats, 
  clearAllData, 
  clearAllDataKeepSchema, 
  dropAllTables 
} from '@/db/storage';
import { Skeleton } from "@/components/ui/skeleton";

// shadcn UI components
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// Schema inspection interfaces
interface TableRow {
  tablename: string;
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
}

interface ConstraintRow {
  constraint_name: string;
  constraint_definition: string;
  constraint_type: string;
}

interface IndexRow {
  index_name: string;
  index_definition: string;
}

// Added interface for enum types
interface EnumTypeRow {
  typname: string;
}

// Added interface for enum values
interface EnumValueRow {
  enumlabel: string;
}

interface EnumTypeSchema {
  name: string;
  values: string[];
}

interface TableSchema {
  tableName: string;
  rowCount: number;
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    default?: string;
    enumType?: string; // Reference to enum type if this column uses an enum
  }[];
  constraints: {
    name: string;
    type: string;
    definition: string;
  }[];
  indices?: {
    name: string;
    definition: string;
  }[];
  usedEnumTypes: string[]; // List of enum type names used by this table
}

/**
 * DbDebugPanel
 * 
 * A component for inspecting database schema and debugging operations.
 */
export function DbDebugPanel() {
  // Basic states
  const [operationResult, setOperationResult] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [dbStatistics, setDbStatistics] = useState<{[key: string]: number}>({});
  const [dbInitialized, setDbInitialized] = useState<boolean>(false);
  
  // Schema inspection states
  const [schema, setSchema] = useState<TableSchema[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  
  // State for enum types
  const [enumTypes, setEnumTypes] = useState<EnumTypeSchema[]>([]);
  
  // Add state for loading states of operations
  const [isClearingData, setIsClearingData] = useState(false);
  const [isDroppingTables, setIsDroppingTables] = useState(false);
  
  // Reset operation messages
  const resetOperation = () => {
    setOperationResult(null);
    setOperationError(null);
  };
  
  // Get database status via event bus
  useEffect(() => {
    // const status = getDatabaseStatus(); // REMOVE: No longer needed
    // console.log('[DbDebugPanel] Database status:', status); // REMOVE
    // setDbInitialized(status.initialized); // REMOVE
    
    // Add event listener for database initialization
    const unsubscribe = dbMessageBus.subscribe('initialized', () => {
      console.log('[DbDebugPanel] Received database initialized event');
      setDbInitialized(true); // Set state when event is received
      
      // Fetch schema when database is initialized
      setTimeout(() => {
        console.log('[DbDebugPanel] Fetching schema after initialization event');
        fetchSchema();
      }, 100); // Small delay to ensure database is fully ready
    });
    
    // Also check if DB might already be initialized when the component mounts
    // (in case the event was missed)
    getDatabase().then(() => {
        // Check the instance directly - assumes getDatabase resolves only when ready
        // This might need adjustment based on getDatabase implementation details
        setDbInitialized(true);
        // Potentially call fetchSchema here too if not already loading
        if (!schemaLoading) {
             // console.log('[DbDebugPanel] Fetching schema on mount as DB seems ready.');
             // fetchSchema(); // Decided against auto-fetching here to rely on event
        }
    }).catch(() => {
        // DB not ready on mount, wait for the event
        setDbInitialized(false);
    });
    
    
    return () => {
      unsubscribe(); // Clean up subscription
    };
  }, []); // Empty dependency array is correct here
  
  // Get database statistics for tables inspector
  useEffect(() => {
    const updateStats = async () => {
      try {
        console.log('[DbDebugPanel] Fetching database stats...');
        const stats = await getDatabaseStats();
        console.log('[DbDebugPanel] Got database stats:', stats);
        setDbStatistics(stats);
      } catch (error) {
        console.error('[DbDebugPanel] Error fetching database stats:', error);
      }
    };
    updateStats();
  }, []);
  
  // Fetch schema information
  const fetchSchema = async () => {
    setSchemaLoading(true);
    try {
      console.log('[DbDebugPanel] Starting to fetch database schema...');
      
      // Force database initialization regardless of status
      const db = await getDatabase();
      console.log('[DbDebugPanel] Got database connection');
      
      // First fetch all enum types
      console.log('[DbDebugPanel] Fetching enum types...');
      const enumTypesResult = await db.query<EnumTypeRow>(`
        SELECT typname
        FROM pg_type 
        JOIN pg_catalog.pg_namespace ON pg_namespace.oid = pg_type.typnamespace
        WHERE typtype = 'e' AND nspname = 'public'
        ORDER BY typname;
      `);
      
      console.log('[DbDebugPanel] Found enum types:', enumTypesResult.rows);
      
      const enumTypeSchemas: EnumTypeSchema[] = [];
      
      for (const { typname } of enumTypesResult.rows) {
        // Get enum values for this type
        const enumValuesResult = await db.query<EnumValueRow>(`
          SELECT enumlabel
          FROM pg_enum
          JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
          WHERE pg_type.typname = $1
          ORDER BY enumsortorder;
        `, [typname]);
        
        enumTypeSchemas.push({
          name: typname,
          values: enumValuesResult.rows.map((row: EnumValueRow) => row.enumlabel)
        });
      }
      
      setEnumTypes(enumTypeSchemas);
      
      // Get all user tables
      console.log('[DbDebugPanel] Fetching tables...');
      const tablesResult = await db.query<TableRow>(`
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public'
        ORDER BY tablename;
      `);
      
      console.log('[DbDebugPanel] Found tables (raw result):', tablesResult);
      console.log('[DbDebugPanel] Found tables (rows):', tablesResult.rows);

      const tables: TableSchema[] = [];

      for (const { tablename } of tablesResult.rows) {
        console.log(`[DbDebugPanel] Processing table: ${tablename}`);
        // Get row count for this table
        const countResult = await db.query<{ count: number }>(`
          SELECT COUNT(*) as count FROM "${tablename}";
        `);
        const rowCount = countResult.rows[0]?.count || 0;
        console.log(`[DbDebugPanel] Table ${tablename} has ${rowCount} rows`);
        
        // Get columns for this table
        const columnsResult = await db.query<ColumnRow>(`
          SELECT 
            column_name,
            data_type,
            udt_name,
            is_nullable,
            column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
          ORDER BY ordinal_position;
        `, [tablename]);

        console.log(`[DbDebugPanel] Table ${tablename} columns:`, columnsResult.rows);

        // Get constraints for this table
        const constraintsResult = await db.query<ConstraintRow>(`
          SELECT
            conname as constraint_name,
            pg_get_constraintdef(c.oid) as constraint_definition,
            CASE contype
              WHEN 'p' THEN 'PRIMARY KEY'
              WHEN 'f' THEN 'FOREIGN KEY'
              WHEN 'u' THEN 'UNIQUE'
              WHEN 'c' THEN 'CHECK'
              ELSE contype::text
            END as constraint_type
          FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE conrelid = $1::regclass
          ORDER BY contype;
        `, [`public.${tablename}`]);
        
        // Get indices for this table
        const indicesResult = await db.query<IndexRow>(`
          SELECT
            indexname as index_name,
            indexdef as index_definition
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = $1;
        `, [tablename]);

        // Process columns and check for enum types
        const usedEnumTypes: string[] = [];
        const columns = columnsResult.rows.map((col: ColumnRow) => {
          // Check if this column uses an enum type
          let enumType = null;
          if (col.data_type === 'USER-DEFINED') {
            // Find matching enum type
            const matchingEnum = enumTypeSchemas.find(e => e.name === col.udt_name);
            if (matchingEnum) {
              enumType = matchingEnum.name;
              if (!usedEnumTypes.includes(matchingEnum.name)) {
                usedEnumTypes.push(matchingEnum.name);
              }
            }
          }
          
          return {
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === 'YES',
            default: col.column_default ?? undefined,
            enumType: enumType
          };
        });

        tables.push({
          tableName: tablename,
          rowCount: rowCount,
          columns: columns,
          constraints: constraintsResult.rows.map((con: ConstraintRow) => ({
            name: con.constraint_name,
            type: con.constraint_type,
            definition: con.constraint_definition
          })),
          indices: indicesResult.rows.map((idx: IndexRow) => ({
            name: idx.index_name,
            definition: idx.index_definition
          })),
          usedEnumTypes: usedEnumTypes
        });
      }

      console.log('[DbDebugPanel] Final processed tables:', tables);
      setSchema(tables);
      
      // Select the first table by default if we have tables and nothing is selected
      if (tables.length > 0 && !selectedTable) {
        console.log('[DbDebugPanel] Setting selected table to:', tables[0].tableName);
        setSelectedTable(tables[0].tableName);
      } else {
        console.log('[DbDebugPanel] No tables found or selection already exists. tables.length =', tables.length, 'selectedTable =', selectedTable);
      }
    } catch (error) {
      console.error('[DbDebugPanel] Error fetching schema:', error);
      setOperationError(error instanceof Error ? error.message : 'Failed to fetch schema');
    } finally {
      setSchemaLoading(false);
    }
  };

  // Load schema when component mounts or when database becomes initialized
  useEffect(() => {
    console.log('[DbDebugPanel] useEffect for schema loading - dbInitialized:', dbInitialized, 'schema.length:', schema.length);
    if (dbInitialized && schema.length === 0) {
      console.log('[DbDebugPanel] Calling fetchSchema from useEffect');
      fetchSchema();
    }
  }, [dbInitialized, schema.length]);
  
  // Helper to get enum values for a type name
  const getEnumValues = (typeName: string): string[] => {
    return enumTypes.find(e => e.name === typeName)?.values || [];
  };
  
  // Render the list of tables
  const renderTableList = () => {
    console.log('[DbDebugPanel] Rendering table list. schemaLoading:', schemaLoading, 'schema.length:', schema.length);
    
    if (schemaLoading) {
      return (
        <div className="space-y-4">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      );
    }
    
    return (
      <div className="space-y-2">
        {schema.length === 0 ? (
          <div className="p-4 border rounded bg-muted">
            <p className="text-muted-foreground">No tables found in the database</p>
            <p className="text-sm text-muted-foreground mt-1">This could be because:</p>
            <ul className="text-sm text-muted-foreground mt-1 list-disc list-inside">
              <li>The database has not been initialized</li>
              <li>No migrations have been applied</li>
              <li>The schema query failed (check console)</li>
            </ul>
          </div>
        ) : (
          schema.map(table => (
            <div 
              key={table.tableName}
              className={`p-2 border rounded cursor-pointer hover:bg-accent ${selectedTable === table.tableName ? 'bg-accent' : ''}`}
              onClick={() => setSelectedTable(table.tableName)}
            >
              <div className="flex justify-between items-center">
                <span className="font-medium">{table.tableName}</span>
                <div className="flex gap-1">
                  {table.usedEnumTypes.length > 0 && (
                    <Badge variant="secondary" className="mr-1">Enums: {table.usedEnumTypes.length}</Badge>
                  )}
                  <Badge variant="outline">{table.rowCount}</Badge>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    );
  };

  // Render table schema details
  const renderTableDetails = () => {
    if (!selectedTable || schemaLoading) {
      return (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground">
              {schemaLoading ? 'Loading schema...' : 'Select a table to view details'}
            </p>
          </CardContent>
        </Card>
      );
    }
    
    const tableSchema = schema.find(t => t.tableName === selectedTable);
    if (!tableSchema) {
      return (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground">Table schema not found</p>
          </CardContent>
        </Card>
      );
    }
    
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex justify-between">
            <span>{tableSchema.tableName}</span>
            <Badge>{tableSchema.rowCount} rows</Badge>
          </CardTitle>
          <CardDescription>Database table schema</CardDescription>
        </CardHeader>
        <CardContent>
          <Accordion type="multiple" defaultValue={["columns", "enums"]}>
            <AccordionItem value="columns">
              <AccordionTrigger>Columns</AccordionTrigger>
              <AccordionContent>
                <ScrollArea className="h-[300px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Nullable</TableHead>
                        <TableHead>Default</TableHead>
                        <TableHead>Enum Type</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tableSchema.columns.map(column => (
                        <TableRow key={column.name}>
                          <TableCell className="font-medium">{column.name}</TableCell>
                          <TableCell>{column.type}</TableCell>
                          <TableCell>{column.nullable ? 'YES' : 'NO'}</TableCell>
                          <TableCell>{column.default || '-'}</TableCell>
                          <TableCell>
                            {column.enumType ? (
                              <Badge variant="secondary">{column.enumType}</Badge>
                            ) : '-'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </AccordionContent>
            </AccordionItem>
            
            {tableSchema.usedEnumTypes.length > 0 && (
              <AccordionItem value="enums">
                <AccordionTrigger>Enum Types ({tableSchema.usedEnumTypes.length})</AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-6">
                    {tableSchema.usedEnumTypes.map(enumTypeName => {
                      const enumValues = getEnumValues(enumTypeName);
                      return (
                        <div key={enumTypeName} className="border rounded-md p-4">
                          <h3 className="text-lg font-medium mb-2 flex justify-between">
                            <span>{enumTypeName}</span>
                            <Badge>{enumValues.length} values</Badge>
                          </h3>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Value</TableHead>
                                <TableHead>Index</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {enumValues.map((value, index) => (
                                <TableRow key={value}>
                                  <TableCell className="font-medium">{value}</TableCell>
                                  <TableCell>{index}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      );
                    })}
                  </div>
                </AccordionContent>
              </AccordionItem>
            )}
            
            <AccordionItem value="constraints">
              <AccordionTrigger>Constraints</AccordionTrigger>
              <AccordionContent>
                <ScrollArea className="h-[300px]">
                  {tableSchema.constraints.length === 0 ? (
                    <p className="text-muted-foreground">No constraints defined</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Definition</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {tableSchema.constraints.map(constraint => (
                          <TableRow key={constraint.name}>
                            <TableCell className="font-medium">{constraint.name}</TableCell>
                            <TableCell>
                              <Badge variant="outline">{constraint.type}</Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {constraint.definition}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </ScrollArea>
              </AccordionContent>
            </AccordionItem>
            
            <AccordionItem value="indices">
              <AccordionTrigger>Indices</AccordionTrigger>
              <AccordionContent>
                <ScrollArea className="h-[300px]">
                  {!tableSchema.indices || tableSchema.indices.length === 0 ? (
                    <p className="text-muted-foreground">No indices defined</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Definition</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {tableSchema.indices.map(index => (
                          <TableRow key={index.name}>
                            <TableCell className="font-medium">{index.name}</TableCell>
                            <TableCell className="font-mono text-xs">
                              {index.definition}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </ScrollArea>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>
    );
  };

  // Handle reload schema button
  const handleReloadSchema = async () => {
    resetOperation();
    try {
      console.log('[DbDebugPanel] Manual reload schema requested');
      await fetchSchema();
      setOperationResult('Schema reloaded successfully');
    } catch (error) {
      console.error('[DbDebugPanel] Error in handleReloadSchema:', error);
      setOperationError('Failed to reload schema');
    }
  };

  // Handle clear all data button
  const handleClearAllData = async () => {
    resetOperation();
    setIsClearingData(true);
    try {
      // This now uses the complete reset approach (more reliable after sleep)
      const success = await clearAllData();
      if (success) {
        setOperationResult('All data cleared successfully using complete reset');
        // Fetch schema and stats after a short delay to allow for database reinitialization
        setTimeout(async () => {
          await fetchSchema();
          const stats = await getDatabaseStats();
          setDbStatistics(stats);
        }, 500);
      } else {
        setOperationError('Failed to clear data');
      }
    } catch (error) {
      setOperationError(`Error clearing data: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsClearingData(false);
    }
  };

  // Alternative clear data method that keeps schema intact
  const handleClearAllDataKeepSchema = async () => {
    resetOperation();
    setIsClearingData(true);
    try {
      // Uses the alternative approach that only deletes rows
      const success = await clearAllDataKeepSchema();
      if (success) {
        setOperationResult('All data cleared successfully (schema preserved)');
        // Refresh schema and stats
        await fetchSchema();
        const stats = await getDatabaseStats();
        setDbStatistics(stats);
      } else {
        setOperationError('Failed to clear data');
      }
    } catch (error) {
      setOperationError(`Error clearing data: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsClearingData(false);
    }
  };

  // Handle drop all tables button
  const handleDropAllTables = async () => {
    resetOperation();
    setIsDroppingTables(true);
    try {
      const success = await dropAllTables();
      if (success) {
        setOperationResult('All tables and types dropped successfully');
        // Refresh schema and stats
        await fetchSchema();
        const stats = await getDatabaseStats();
        setDbStatistics(stats);
      } else {
        setOperationError('Failed to drop tables');
      }
    } catch (error) {
      setOperationError(`Error dropping tables: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsDroppingTables(false);
    }
  };

  // Render operations panel
  const renderOperations = () => (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Database Operations</CardTitle>
        <CardDescription>
          Manage database schema and data - be careful with these operations
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col space-y-4">
          {/* Operation result display */}
          {operationResult && (
            <Alert className="bg-green-50">
              <AlertTitle>Operation Successful</AlertTitle>
              <AlertDescription>
                {operationResult}
              </AlertDescription>
            </Alert>
          )}
          {operationError && (
            <Alert variant="destructive">
              <AlertTitle>Operation Failed</AlertTitle>
              <AlertDescription>
                {operationError}
              </AlertDescription>
            </Alert>
          )}
          
          {/* Schema reload button */}
          <div className="flex flex-row justify-end">
            <Button 
              onClick={handleReloadSchema} 
              variant="outline" 
              disabled={schemaLoading}
              className="text-xs"
            >
              {schemaLoading ? "Loading..." : "Reload Schema"}
            </Button>
          </div>
          
          {/* Clear All Data Operation */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="w-full">
                Clear All Data (Complete Reset)
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear All Data</AlertDialogTitle>
                <AlertDialogDescription>
                  This will completely reset the database by deleting the entire IndexedDB storage and reconnecting.
                  This is the most reliable method that prevents stale data issues after PC sleep.
                  All data will be permanently deleted. This is not reversible.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleClearAllData}>
                  Clear All Data
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          
          {/* Clear All Data (Keep Schema) Operation */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="w-full opacity-80">
                Clear All Data (Keep Schema)
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear Data (Preserve Schema)</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete all rows from all tables but keep the database structure intact.
                  This is faster but may have issues with stale data after PC sleep.
                  All data will be permanently deleted. This is not reversible.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleClearAllDataKeepSchema}>
                  Clear Data Only
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          
          {/* Drop All Tables Operation */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="w-full">
                Drop All Tables & Types
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Drop All Tables</AlertDialogTitle>
                <AlertDialogDescription>
                  This will drop all tables and custom types in the database.
                  All data and schema will be permanently deleted. This is not reversible.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDropAllTables}>
                  Drop Everything
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
  
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle>Database Tables</CardTitle>
              <CardDescription>
                {schemaLoading ? 'Loading...' : 
                 schema.length > 0 ? `${schema.length} tables found` : 'No tables found'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {renderTableList()}
            </CardContent>
          </Card>
        </div>
        
        <div className="md:col-span-2 space-y-6">
          {renderTableDetails()}
          {renderOperations()}
        </div>
      </div>
    </div>
  );
}