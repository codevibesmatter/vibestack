import { MigrationInterface, QueryRunner } from "typeorm";

export class AddClientMigrationTable1741887868917 implements MigrationInterface {
    name = 'AddClientMigrationTable1741887868917'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "change_history" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "lsn" text NOT NULL, "table_name" text NOT NULL, "operation" text NOT NULL, "data" jsonb NOT NULL, "old_data" jsonb, "transaction_id" text NOT NULL, "schema_version" text NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "metadata" jsonb, "client_id" uuid, CONSTRAINT "PK_6e83e27c48283592150c85d6827" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_lsn" ON "change_history" ("lsn") `);
        await queryRunner.query(`CREATE INDEX "idx_table_timestamp" ON "change_history" ("table_name") `);
        await queryRunner.query(`CREATE INDEX "idx_transaction" ON "change_history" ("transaction_id") `);
        await queryRunner.query(`CREATE TYPE "public"."client_migration_migration_type_enum" AS ENUM('schema', 'data', 'mixed')`);
        await queryRunner.query(`CREATE TYPE "public"."client_migration_state_enum" AS ENUM('pending', 'available', 'deprecated', 'required')`);
        await queryRunner.query(`CREATE TABLE "client_migration" ("migration_name" text NOT NULL, "schema_version" text NOT NULL, "dependencies" text array NOT NULL DEFAULT '{}', "migration_type" "public"."client_migration_migration_type_enum" NOT NULL, "state" "public"."client_migration_state_enum" NOT NULL DEFAULT 'pending', "up_queries" text array NOT NULL, "down_queries" text array NOT NULL, "description" text, "timestamp" bigint NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_93d3cea8680434b8f7a689c9835" PRIMARY KEY ("migration_name"))`);
        await queryRunner.query(`CREATE INDEX "IDX_bfd1577edbebf606d654aca741" ON "client_migration" ("schema_version") `);
        await queryRunner.query(`CREATE TABLE "health_check_state" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "last_run_timestamp" TIMESTAMP NOT NULL, "status" text NOT NULL, "metrics" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_69d8800d4363d47260d511de2a9" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "health_check_state"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bfd1577edbebf606d654aca741"`);
        await queryRunner.query(`DROP TABLE "client_migration"`);
        await queryRunner.query(`DROP TYPE "public"."client_migration_state_enum"`);
        await queryRunner.query(`DROP TYPE "public"."client_migration_migration_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."idx_transaction"`);
        await queryRunner.query(`DROP INDEX "public"."idx_table_timestamp"`);
        await queryRunner.query(`DROP INDEX "public"."idx_lsn"`);
        await queryRunner.query(`DROP TABLE "change_history"`);
    }

}
