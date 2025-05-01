import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCreatedAtToSystemEntities1746049029292 implements MigrationInterface {
    name = 'AddCreatedAtToSystemEntities1746049029292'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "accounts" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "change_history" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "client_migration" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "sessions" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "verifications" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "verifications" DROP COLUMN "created_at"`);
        await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "created_at"`);
        await queryRunner.query(`ALTER TABLE "client_migration" DROP COLUMN "created_at"`);
        await queryRunner.query(`ALTER TABLE "change_history" DROP COLUMN "created_at"`);
        await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "created_at"`);
    }

}
