import { MigrationInterface, QueryRunner } from "typeorm";
import { SERVER_DOMAIN_TABLES } from "../../generated/server-entities.js";

/**
 * Migration for adding client_id reset trigger to domain tables.
 * This trigger resets client_id to NULL when it's unchanged during updates,
 * which ensures proper sync behavior by not tracking unchanged fields.
 */
export class AddClientIdResetTrigger1746120000000 implements MigrationInterface {
    name = 'AddClientIdResetTrigger1746120000000'

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

        // Add trigger to each domain table from SERVER_DOMAIN_TABLES
        for (const table of SERVER_DOMAIN_TABLES) {
            const tableNameString = table as string; // Cast to string
            const cleanTableName = tableNameString.replace(/"/g, ''); // Remove quotes for trigger name
            
            // Create trigger for client_id reset
            await queryRunner.query(`
                DROP TRIGGER IF EXISTS reset_client_id_trigger ON ${table};
                
                CREATE TRIGGER reset_client_id_trigger
                BEFORE UPDATE ON ${table}
                FOR EACH ROW
                EXECUTE FUNCTION reset_client_id();
            `);
            
            console.log(`Created reset_client_id_trigger on table ${table}`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop triggers from all domain tables
        for (const table of SERVER_DOMAIN_TABLES) {
            await queryRunner.query(`
                DROP TRIGGER IF EXISTS reset_client_id_trigger ON ${table};
            `);
            
            console.log(`Dropped reset_client_id_trigger from table ${table}`);
        }

        // Note: We're keeping the function since it might be shared
        // await queryRunner.query(`DROP FUNCTION IF EXISTS reset_client_id();`);
    }
} 