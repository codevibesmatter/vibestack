import { MigrationInterface, QueryRunner } from "typeorm";

export class RemoveChangeHistoryTrigger1742067963373 implements MigrationInterface {
    name = 'RemoveChangeHistoryTrigger1742067963373'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Drop the trigger from change_history table
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS reset_client_id_trigger ON "change_history";
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // We don't want to recreate the trigger in down migration
        // since it was incorrectly added in the first place
    }
} 