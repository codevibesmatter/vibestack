import { MigrationInterface, QueryRunner } from "typeorm";
import { SERVER_DOMAIN_TABLES } from "../../generated/server-entities.js";

export class AddCRDTTimestampTriggers1742855458458 implements MigrationInterface {
    name = 'AddCRDTTimestampTriggers1742855458458'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // First create the trigger function for CRDT timestamp conflict resolution
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION enforce_crdt_timestamp()
            RETURNS trigger AS $$
            BEGIN
                -- For inserts
                IF (TG_OP = 'INSERT') THEN
                    -- If this is an entirely new record, nothing to check
                    RETURN NEW;
                END IF;
                
                -- For updates
                IF (TG_OP = 'UPDATE') THEN
                    -- Only allow updates if the new timestamp is newer than or equal to the old one
                    -- This implements last-write-wins CRDT conflict resolution
                    IF (NEW.updated_at <= OLD.updated_at) THEN
                        -- Silently ignore the update by returning OLD
                        -- This preserves the existing record without changing it
                        RETURN OLD;
                    END IF;
                END IF;
                
                -- If we get here, the update is allowed
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

        // Add trigger to each domain table
        for (const table of SERVER_DOMAIN_TABLES) {
            await queryRunner.query(`
                CREATE TRIGGER enforce_crdt_timestamp_trigger
                BEFORE UPDATE ON ${table}
                FOR EACH ROW
                EXECUTE FUNCTION enforce_crdt_timestamp();
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop triggers from all domain tables
        for (const table of SERVER_DOMAIN_TABLES) {
            await queryRunner.query(`
                DROP TRIGGER IF EXISTS enforce_crdt_timestamp_trigger ON ${table};
            `);
        }

        // Keep the function since it might be shared
        // await queryRunner.query(`DROP FUNCTION IF EXISTS enforce_crdt_timestamp();`);
    }
} 