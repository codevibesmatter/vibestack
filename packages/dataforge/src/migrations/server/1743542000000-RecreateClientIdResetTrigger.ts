import { MigrationInterface, QueryRunner } from "typeorm";
import { SERVER_DOMAIN_TABLES } from "../../generated/server-entities.js";

export class RecreateClientIdResetTrigger1743542000000 implements MigrationInterface {
    name = 'RecreateClientIdResetTrigger1743542000000'

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
            // Skip system tables and server-only tables
            if (table.includes('change_history') || table.includes('client_migration')) {
                continue;
            }
            
            await queryRunner.query(`
                DROP TRIGGER IF EXISTS reset_client_id_trigger ON ${table};
                
                CREATE TRIGGER reset_client_id_trigger
                BEFORE UPDATE ON ${table}
                FOR EACH ROW
                EXECUTE FUNCTION reset_client_id();
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop triggers from all domain tables
        for (const table of SERVER_DOMAIN_TABLES) {
            if (table.includes('change_history') || table.includes('client_migration')) {
                continue;
            }
            
            await queryRunner.query(`
                DROP TRIGGER IF EXISTS reset_client_id_trigger ON ${table};
            `);
        }

        // Drop the function
        await queryRunner.query(`DROP FUNCTION IF EXISTS reset_client_id();`);
    }
} 