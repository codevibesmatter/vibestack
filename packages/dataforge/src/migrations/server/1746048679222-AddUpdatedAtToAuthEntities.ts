import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUpdatedAtToAuthEntities1746048679222 implements MigrationInterface {
    name = 'AddUpdatedAtToAuthEntities1746048679222'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "accounts" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "sessions" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "verifications" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "verifications" DROP COLUMN "updated_at"`);
        await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "updated_at"`);
        await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "updated_at"`);
    }

}
