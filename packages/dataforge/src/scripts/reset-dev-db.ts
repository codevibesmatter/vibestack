import "reflect-metadata";
import serverDataSource from "../datasources/server.js";
import clientDataSource from "../datasources/client.js";

async function resetDatabase() {
  try {
    // Initialize the data sources
    await serverDataSource.initialize();
    console.log("Server data source initialized");

    // Get a query runner
    const queryRunner = serverDataSource.createQueryRunner();
    
    // Drop all tables in the public schema, including migrations tables
    console.log("Dropping all tables and types...");
    
    // First drop all tables with CASCADE
    await queryRunner.query(`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS "' || r.tablename || '" CASCADE';
        END LOOP;
      END $$;
    `);
    
    // Then drop all types
    await queryRunner.query(`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT t.typname as type_name
                  FROM pg_type t
                  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'public'
                  AND t.typtype = 'e') LOOP
          EXECUTE 'DROP TYPE IF EXISTS "' || r.type_name || '" CASCADE';
        END LOOP;
      END $$;
    `);
    
    console.log("All tables and types dropped successfully");
    
    // Recreate migration tables with no migrations
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "migrations_server" (
        "id" SERIAL NOT NULL, 
        "timestamp" bigint NOT NULL, 
        "name" character varying NOT NULL, 
        CONSTRAINT "PK_migrations_server" PRIMARY KEY ("id")
      );
    `);
    
    console.log("Created clean migrations_server table");
    
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "migrations_client" (
        "id" SERIAL NOT NULL, 
        "timestamp" bigint NOT NULL, 
        "name" character varying NOT NULL, 
        CONSTRAINT "PK_migrations_client" PRIMARY KEY ("id")
      );
    `);
    
    console.log("Created clean migrations_client table");
    
    // Synchronize entities with database
    console.log("Synchronizing server database schema with entities...");
    await serverDataSource.synchronize();
    
    console.log("Server database synchronized successfully");
    
    // Close the connection
    await serverDataSource.destroy();
    console.log("Server data source closed");
    
    // Handle client database
    await clientDataSource.initialize();
    console.log("Client data source initialized");

    // Get a query runner for client
    const clientQueryRunner = clientDataSource.createQueryRunner();
    
    // Drop all tables in the client database
    console.log("Dropping all tables and types in client database...");
    
    // First drop all tables with CASCADE
    await clientQueryRunner.query(`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS "' || r.tablename || '" CASCADE';
        END LOOP;
      END $$;
    `);
    
    // Then drop all types
    await clientQueryRunner.query(`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT t.typname as type_name
                  FROM pg_type t
                  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'public'
                  AND t.typtype = 'e') LOOP
          EXECUTE 'DROP TYPE IF EXISTS "' || r.type_name || '" CASCADE';
        END LOOP;
      END $$;
    `);
    
    console.log("All tables and types dropped from client database");

    // Synchronize client entities with database
    console.log("Synchronizing client database schema with entities...");
    await clientDataSource.synchronize();
    
    console.log("Client database synchronized successfully");
    
    // Close the client connection
    await clientDataSource.destroy();
    console.log("Client data source closed");

    console.log("Database reset complete for both server and client.");
    
  } catch (error) {
    console.error("Error resetting database:", error);
    // Ensure connections are closed even if there's an error
    if (serverDataSource.isInitialized) {
      await serverDataSource.destroy();
    }
    if (clientDataSource.isInitialized) {
      await clientDataSource.destroy();
    }
    process.exit(1);
  }
}

// Run the function
resetDatabase(); 