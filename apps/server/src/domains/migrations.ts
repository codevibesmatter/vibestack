import { Client } from '@neondatabase/serverless';
import { ClientMigration } from "@repo/typeorm/server-entities";

// Type definitions
type ClientMigrationType = typeof ClientMigration;
type ClientMigrationInstance = InstanceType<ClientMigrationType>;

// Database operations
export const migrationQueries = {
  findAll: async (client: Client) => {
    const result = await client.query<ClientMigrationInstance>(
      `SELECT "migration_name", "timestamp", "up_queries", "down_queries", "created_at" 
       FROM client_migration 
       ORDER BY timestamp ASC`
    );
    return result.rows;
  },

  findByName: async (client: Client, migrationName: string) => {
    const result = await client.query<ClientMigrationInstance>(
      `SELECT "migration_name", "timestamp", "up_queries", "down_queries", "created_at"
       FROM client_migration 
       WHERE "migration_name" = $1`,
      [migrationName]
    );
    return result.rows[0] || null;
  }
}; 