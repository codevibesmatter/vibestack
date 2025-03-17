import "reflect-metadata";
import { config } from "dotenv";
import { DataSource } from "typeorm";
import path from "path";
import { fileURLToPath } from 'url';
import { isServerEntity } from '../utils/context.js';

// Define __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import server entities dynamically for ESM
// This will be fixed after building the entities
import { serverEntities } from "../generated/server-entities.js";

// Load environment variables from .env file
config();

// Create server datasource
const serverDataSource = new DataSource({
  type: "postgres",
  // Use DATABASE_URL if available, otherwise use default connection settings
  url: process.env.DATABASE_URL,
  // If no URL is provided, use these settings
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  username: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "vibestack",
  ssl: process.env.DB_SSL === "true",
  // Use the pre-filtered server entities
  entities: serverEntities,
  migrations: ["src/migrations/server/*.ts"],
  migrationsTableName: "migrations_server",
  // Set default schema for all entities
  schema: "public",
  logging: true,
  // Use TypeORM's built-in filtering
  entitySkipConstructor: true,
  synchronize: false,
});

// For debug purposes
if (process.env.DEBUG) {
  console.log("Server entities:", serverEntities.map((e: any) => e.name));
}

export default serverDataSource; 