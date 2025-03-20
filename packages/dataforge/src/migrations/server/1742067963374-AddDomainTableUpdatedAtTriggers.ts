import { MigrationInterface, QueryRunner } from "typeorm";
import { SERVER_DOMAIN_TABLES } from "../../generated/server-entities.js";

export class AddDomainTableUpdatedAtTriggers1742067963374 implements MigrationInterface {
    name = 'AddDomainTableUpdatedAtTriggers1742067963374'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // First create the trigger function if it doesn't exist
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION update_updated_at()
            RETURNS trigger AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

        // Add trigger to each domain table
        for (const table of SERVER_DOMAIN_TABLES) {
            await queryRunner.query(`
                CREATE TRIGGER update_updated_at_trigger
                BEFORE UPDATE ON ${table}
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at();
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop triggers from all domain tables
        for (const table of SERVER_DOMAIN_TABLES) {
            await queryRunner.query(`
                DROP TRIGGER IF EXISTS update_updated_at_trigger ON ${table};
            `);
        }

        // Note: We're keeping the function since it's shared
        // await queryRunner.query(`DROP FUNCTION IF EXISTS update_updated_at();`);
    }
} 