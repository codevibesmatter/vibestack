import "reflect-metadata";
import serverDataSource from "../datasources/server.js";

async function dropSchema() {
  try {
    // Initialize the data source
    await serverDataSource.initialize();
    console.log("Server data source initialized");

    // Drop the schema using TypeORM's built-in functionality
    console.log("Dropping database schema...");
    await serverDataSource.dropDatabase();
    console.log("Database schema dropped successfully");
    
    // Close the connection
    await serverDataSource.destroy();
    console.log("Server data source closed");
    
  } catch (error) {
    console.error("Error dropping schema:", error);
    // Ensure the connection is closed even if there's an error
    if (serverDataSource.isInitialized) {
      await serverDataSource.destroy();
    }
    process.exit(1);
  }
}

// Run the function
dropSchema();
