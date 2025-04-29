import { MigrationInterface, QueryRunner } from "typeorm";
import { SERVER_DOMAIN_TABLES } from "../generated/server-entities.js";

/**
 * Template migration for adding client_id trigger to domain tables
 * To use:
 * 1. Copy to src/migrations/server/
 * 2. Update the timestamp in class name and name property
 * 3. Run migration
 */
export class AddDomainTableClientIdTriggers0 implements MigrationInterface {
    name = 'AddDomainTableClientIdTriggers0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // First create the trigger function if it doesn't exist
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION reset_client_id()
            RETURNS trigger AS $$
            BEGIN
                IF TG_OP = 'UPDATE' AND NEW.client_id IS NOT DISTINCT FROM OLD.client_id THEN
                    NEW.client_id = NULL;
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

        // Add trigger to each domain table
        for (const table of SERVER_DOMAIN_TABLES) {
            const tableNameString = table as string; // Assert type
            // Remove quotes from table name for trigger name
            const cleanTableName = tableNameString.replace(/"/g, ''); // Use asserted string
            await queryRunner.query(`
                CREATE TRIGGER reset_client_id_trigger_${cleanTableName}
                BEFORE UPDATE ON ${table}
                FOR EACH ROW
                EXECUTE FUNCTION reset_client_id();
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop triggers from all domain tables
        for (const table of SERVER_DOMAIN_TABLES) {
            const tableNameString = table as string; // Assert type
            const cleanTableName = tableNameString.replace(/"/g, ''); // Use asserted string
            await queryRunner.query(`
                DROP TRIGGER IF EXISTS reset_client_id_trigger_${cleanTableName} ON ${table};
            `);
        }

        // Note: We're keeping the function since it's shared
        // await queryRunner.query(`DROP FUNCTION IF EXISTS reset_client_id();`);
    }
} 