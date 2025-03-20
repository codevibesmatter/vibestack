import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropChangeHistory1742067963376 implements MigrationInterface {
  name = 'DropChangeHistory1742067963376';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes first
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_lsn"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_table_updated_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_updated_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_client_id"`);

    // Drop the table
    await queryRunner.query(`DROP TABLE IF EXISTS "change_history"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Recreate the table
    await queryRunner.query(`CREATE TABLE "change_history" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "lsn" text NOT NULL,
      "table_name" text NOT NULL,
      "operation" text NOT NULL,
      "data" jsonb NOT NULL,
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
      "client_id" uuid,
      CONSTRAINT "PK_change_history_id" PRIMARY KEY ("id")
    )`);

    // Recreate indexes
    await queryRunner.query(`CREATE INDEX "idx_lsn" ON "change_history" ("lsn")`);
    await queryRunner.query(`CREATE INDEX "idx_table_updated_at" ON "change_history" ("table_name", "updated_at")`);
    await queryRunner.query(`CREATE INDEX "idx_updated_at" ON "change_history" ("updated_at")`);
    await queryRunner.query(`CREATE INDEX "idx_client_id" ON "change_history" ("client_id")`);
  }
} 