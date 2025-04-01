import "reflect-metadata";
import serverDataSource from "../datasources/server.js";
import { RecreateClientIdResetTrigger1743542000000 } from "../migrations/server/1743542000000-RecreateClientIdResetTrigger.js";

async function applyTrigger() {
  try {
    // Initialize the server data source
    await serverDataSource.initialize();
    console.log("Server data source initialized");

    // Create an instance of the migration
    const migration = new RecreateClientIdResetTrigger1743542000000();
    
    // Get a query runner
    const queryRunner = serverDataSource.createQueryRunner();
    
    console.log(`Applying migration: ${migration.name}`);
    
    // Apply the migration
    await migration.up(queryRunner);
    
    console.log("Migration applied successfully");
    
    // Close the data source
    await serverDataSource.destroy();
    console.log("Server data source closed");
    
  } catch (error) {
    console.error("Error applying trigger migration:", error);
    // Ensure the data source is closed even if there's an error
    if (serverDataSource.isInitialized) {
      await serverDataSource.destroy();
    }
    process.exit(1);
  }
}

// Run the function
applyTrigger(); 