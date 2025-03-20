import { MigrationInterface, QueryRunner } from "typeorm";

export class RenameChangeHistoryTimestamp1742054204419 implements MigrationInterface {
    name = 'RenameChangeHistoryTimestamp1742054204419'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_table_timestamp"`);
        await queryRunner.query(`ALTER TABLE "change_history" ADD "updated_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "change_history" ADD "created_at" TIMESTAMP WITH TIME ZONE DEFAULT now()`);
        await queryRunner.query(`UPDATE "change_history" SET "updated_at" = "timestamp", "created_at" = "timestamp"`);
        await queryRunner.query(`ALTER TABLE "change_history" ALTER COLUMN "updated_at" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "change_history" ALTER COLUMN "created_at" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "change_history" DROP COLUMN "timestamp"`);
        await queryRunner.query(`CREATE INDEX "idx_updated_at" ON "change_history" ("updated_at") `);
        await queryRunner.query(`CREATE INDEX "idx_table_updated_at" ON "change_history" ("table_name", "updated_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_table_updated_at"`);
        await queryRunner.query(`DROP INDEX "public"."idx_updated_at"`);
        await queryRunner.query(`ALTER TABLE "change_history" ADD "timestamp" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`UPDATE "change_history" SET "timestamp" = "updated_at"`);
        await queryRunner.query(`ALTER TABLE "change_history" ALTER COLUMN "timestamp" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "change_history" DROP COLUMN "created_at"`);
        await queryRunner.query(`ALTER TABLE "change_history" DROP COLUMN "updated_at"`);
        await queryRunner.query(`CREATE INDEX "idx_table_timestamp" ON "change_history" ("table_name") `);
    }

}
