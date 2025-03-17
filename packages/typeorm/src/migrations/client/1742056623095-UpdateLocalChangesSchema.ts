import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateLocalChangesSchema1742056623095 implements MigrationInterface {
    name = 'UpdateLocalChangesSchema1742056623095'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // First truncate the table since we're in dev and don't need to preserve data
        await queryRunner.query(`TRUNCATE TABLE "local_changes"`);
        
        await queryRunner.query(`ALTER TABLE "local_changes" DROP COLUMN "timestamp"`);
        await queryRunner.query(`ALTER TABLE "local_changes" DROP COLUMN "processed_local"`);
        await queryRunner.query(`ALTER TABLE "local_changes" DROP COLUMN "attempts"`);
        await queryRunner.query(`ALTER TABLE "local_changes" DROP COLUMN "from_server"`);
        await queryRunner.query(`ALTER TABLE "local_changes" DROP COLUMN "entity_type"`);
        await queryRunner.query(`ALTER TABLE "local_changes" DROP COLUMN "entity_id"`);
        await queryRunner.query(`ALTER TABLE "local_changes" DROP COLUMN "error"`);
        await queryRunner.query(`ALTER TABLE "local_changes" ADD "table" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "local_changes" ADD "lsn" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "local_changes" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL`);
        await queryRunner.query(`ALTER TABLE "users" ADD "password_hash" character varying(255)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "password_hash"`);
        await queryRunner.query(`ALTER TABLE "local_changes" DROP COLUMN "updated_at"`);
        await queryRunner.query(`ALTER TABLE "local_changes" DROP COLUMN "lsn"`);
        await queryRunner.query(`ALTER TABLE "local_changes" DROP COLUMN "table"`);
        await queryRunner.query(`ALTER TABLE "local_changes" ADD "error" text`);
        await queryRunner.query(`ALTER TABLE "local_changes" ADD "entity_id" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "local_changes" ADD "entity_type" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "local_changes" ADD "from_server" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "local_changes" ADD "attempts" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "local_changes" ADD "processed_local" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "local_changes" ADD "timestamp" bigint NOT NULL`);
    }

}
