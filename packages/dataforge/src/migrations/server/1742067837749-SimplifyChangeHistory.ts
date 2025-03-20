import { MigrationInterface, QueryRunner } from "typeorm";

export class SimplifyChangeHistory1742067837749 implements MigrationInterface {
    name = 'SimplifyChangeHistory1742067837749'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_transaction"`);
        await queryRunner.query(`ALTER TABLE "change_history" DROP COLUMN "old_data"`);
        await queryRunner.query(`ALTER TABLE "change_history" DROP COLUMN "transaction_id"`);
        await queryRunner.query(`ALTER TABLE "change_history" DROP COLUMN "schema_version"`);
        await queryRunner.query(`ALTER TABLE "change_history" DROP COLUMN "metadata"`);
        await queryRunner.query(`ALTER TABLE "change_history" DROP COLUMN "created_at"`);
        await queryRunner.query(`CREATE INDEX "idx_client_id" ON "change_history" ("client_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_client_id"`);
        await queryRunner.query(`ALTER TABLE "change_history" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "change_history" ADD "metadata" jsonb`);
        await queryRunner.query(`ALTER TABLE "change_history" ADD "schema_version" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "change_history" ADD "transaction_id" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "change_history" ADD "old_data" jsonb`);
        await queryRunner.query(`CREATE INDEX "idx_transaction" ON "change_history" ("transaction_id") `);
    }

}
