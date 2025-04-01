import { MigrationInterface, QueryRunner } from "typeorm";
import { SERVER_DOMAIN_TABLES } from "../../generated/server-entities.js";

export class RemoveUpdatedAtTriggers1742067963375 implements MigrationInterface {
    name = 'RemoveUpdatedAtTriggers1742067963375'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Drop triggers from all domain tables
        for (const table of SERVER_DOMAIN_TABLES) {
            await queryRunner.query(`
                DROP TRIGGER IF EXISTS update_updated_at_trigger ON ${table};
            `);
        }
        
        // Comment this out if you want to keep the function for other uses
        await queryRunner.query(`DROP FUNCTION IF EXISTS update_updated_at();`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Recreate the function if we dropped it
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION update_updated_at()
            RETURNS trigger AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

        // Recreate triggers on all domain tables
        for (const table of SERVER_DOMAIN_TABLES) {
            await queryRunner.query(`
                CREATE TRIGGER update_updated_at_trigger
                BEFORE UPDATE ON ${table}
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at();
            `);
        }
    }
} 