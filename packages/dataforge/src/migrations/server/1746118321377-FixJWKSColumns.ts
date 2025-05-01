import { MigrationInterface, QueryRunner } from "typeorm";

export class FixJWKSColumns1746118321377 implements MigrationInterface {
    name = 'FixJWKSColumns1746118321377'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jwks" DROP COLUMN "privateKey"`);
        await queryRunner.query(`ALTER TABLE "jwks" DROP COLUMN "publicKey"`);
        await queryRunner.query(`ALTER TABLE "jwks" ADD "public_key" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "jwks" ADD "private_key" text NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jwks" DROP COLUMN "private_key"`);
        await queryRunner.query(`ALTER TABLE "jwks" DROP COLUMN "public_key"`);
        await queryRunner.query(`ALTER TABLE "jwks" ADD "publicKey" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "jwks" ADD "privateKey" text NOT NULL`);
    }

}
