import "reflect-metadata";
import { config } from "dotenv";
import { DataSource } from "typeorm";
import path from "path";
import { fileURLToPath } from 'url';

// Define __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import client entities dynamically for ESM
import { clientEntities } from "../generated/client-entities.js";

// Import PGlite driver and uuid_ossp extension
import { PGliteDriver } from "typeorm-pglite";
// @ts-ignore - TypeScript doesn't know about this import
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

// Load environment variables from .env file
config();

// Create client datasource
// For client-side, we use PGlite instead of regular Postgres
const clientDataSource = new DataSource({
  type: "postgres", // Use postgres type for TypeORM compatibility
  database: "vibestack_client",
  
  // Entities - use pre-generated client entities
  entities: clientEntities,
  
  // Migration settings
  migrations: ["src/migrations/client/*.ts"],
  migrationsTableName: "migrations",
  
  // Use migrations instead of synchronize
  synchronize: false,
  logging: true,
  
  // Use PGlite driver with uuid_ossp extension
  // @ts-ignore - TypeScript doesn't know about PGlite options
  driver: new PGliteDriver({
    extensions: { uuid_ossp },
    dataDir: './pgdata/client' // Add filesystem persistence
  }).driver
});

/**
 * Get the underlying PGlite instance from the client datasource
 * This can be useful for direct operations with PGlite
 */
export async function getClientPGliteInstance() {
  if (!clientDataSource.isInitialized) {
    await clientDataSource.initialize();
  }
  
  const driver = clientDataSource.driver as any;
  if (driver && driver.pglite) {
    return driver.pglite;
  }
  
  throw new Error('PGlite instance not available');
}

// For debug purposes
if (process.env.DEBUG) {
  console.log("Client entities:", clientEntities.map((e: any) => e.name));
  console.log("Client datasource initialized");
}

export default clientDataSource; 