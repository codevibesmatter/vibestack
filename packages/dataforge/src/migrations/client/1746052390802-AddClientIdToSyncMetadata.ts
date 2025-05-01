import { MigrationInterface, QueryRunner } from "typeorm";

export class AddClientIdToSyncMetadata1746052390802 implements MigrationInterface {
    name = 'AddClientIdToSyncMetadata1746052390802'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sync_metadata" ADD "client_id" text NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sync_metadata" DROP COLUMN "client_id"`);
    }

}
