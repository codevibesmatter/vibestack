import "reflect-metadata";
import serverDataSource from "../datasources/server.js";

async function dropAllTables() {
  try {
    // Initialize the data source
    await serverDataSource.initialize();
    console.log("Server data source initialized");

    // Get a query runner
    const queryRunner = serverDataSource.createQueryRunner();
    
    // Drop all tables in the public schema
    console.log("Dropping all tables in the public schema...");
    
    // Get all tables in the public schema
    const tablesResult = await queryRunner.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public'
      AND tablename != 'migrations_server'
      AND tablename != 'migrations_client';
    `);
    
    // First drop tables with foreign key constraints
    console.log("First pass: Dropping tables with foreign key dependencies...");
    for (const { tablename } of tablesResult) {
      try {
        console.log(`Attempting to drop table: ${tablename}`);
        await queryRunner.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE;`);
      } catch (err) {
        console.log(`Could not drop ${tablename} yet, will try again later: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    // Drop all types (enums)
    const typesResult = await queryRunner.query(`
      SELECT t.typname as type_name
      FROM pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      AND t.typtype = 'e';
    `);
    
    // Drop each type
    for (const { type_name } of typesResult) {
      try {
        console.log(`Dropping type: ${type_name}`);
        await queryRunner.query(`DROP TYPE IF EXISTS "${type_name}" CASCADE;`);
      } catch (err) {
        console.log(`Could not drop type ${type_name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    console.log("All tables and types dropped successfully");
    
    // Close the connection
    await serverDataSource.destroy();
    console.log("Server data source closed");
    
  } catch (error) {
    console.error("Error dropping tables:", error);
    // Ensure the connection is closed even if there's an error
    if (serverDataSource.isInitialized) {
      await serverDataSource.destroy();
    }
    process.exit(1);
  }
}

// Run the function
dropAllTables();
