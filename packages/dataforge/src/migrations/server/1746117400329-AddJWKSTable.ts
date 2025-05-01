import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJWKSTable1746117400329 implements MigrationInterface {
    name = 'AddJWKSTable1746117400329'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "project_members" DROP CONSTRAINT "FK_e89aae80e010c2faa72e6a49ce8"`);
        await queryRunner.query(`CREATE TABLE "sync_metadata" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "client_id" text NOT NULL, "current_lsn" text NOT NULL DEFAULT '0/0', "sync_state" text NOT NULL DEFAULT 'disconnected', "last_sync_time" TIMESTAMP WITH TIME ZONE, "pending_changes_count" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_fbdfc072a3e60cc5086d9d84b05" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "local_changes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "table" text NOT NULL, "operation" text NOT NULL, "data" jsonb NOT NULL, "lsn" text NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL, "processed_sync" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_183aaeba20c9012ea8d4f54a8bf" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "jwks" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "publicKey" text NOT NULL, "privateKey" text NOT NULL, CONSTRAINT "PK_147086b49bf8366682d1a7ca7c1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."client_migration_status_status_enum" AS ENUM('pending', 'in_progress', 'completed', 'failed', 'rolled_back')`);
        await queryRunner.query(`CREATE TABLE "client_migration_status" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "migration_name" text NOT NULL, "schema_version" text NOT NULL, "status" "public"."client_migration_status_status_enum" NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE, "completed_at" TIMESTAMP WITH TIME ZONE, "error_message" text, "attempts" integer NOT NULL DEFAULT '0', "timestamp" bigint NOT NULL, CONSTRAINT "PK_c36ad25534183aea155df9ca89d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f6a012ebab7ea3ff10fa8f3c58" ON "client_migration_status" ("schema_version") `);
        await queryRunner.query(`CREATE INDEX "IDX_97c51ed35fb20c52eb27af19c7" ON "change_history" ("lsn") `);
        await queryRunner.query(`CREATE INDEX "IDX_bfd1577edbebf606d654aca741" ON "client_migration" ("schema_version") `);
        await queryRunner.query(`ALTER TABLE "project_members" ADD CONSTRAINT "FK_e89aae80e010c2faa72e6a49ce8" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "project_members" DROP CONSTRAINT "FK_e89aae80e010c2faa72e6a49ce8"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bfd1577edbebf606d654aca741"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_97c51ed35fb20c52eb27af19c7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f6a012ebab7ea3ff10fa8f3c58"`);
        await queryRunner.query(`DROP TABLE "client_migration_status"`);
        await queryRunner.query(`DROP TYPE "public"."client_migration_status_status_enum"`);
        await queryRunner.query(`DROP TABLE "jwks"`);
        await queryRunner.query(`DROP TABLE "local_changes"`);
        await queryRunner.query(`DROP TABLE "sync_metadata"`);
        await queryRunner.query(`ALTER TABLE "project_members" ADD CONSTRAINT "FK_e89aae80e010c2faa72e6a49ce8" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
    }
} 