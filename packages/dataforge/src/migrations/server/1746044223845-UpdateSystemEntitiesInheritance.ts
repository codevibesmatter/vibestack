import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateSystemEntitiesInheritance1746044223845 implements MigrationInterface {
    name = 'UpdateSystemEntitiesInheritance1746044223845'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "client_migration" RENAME COLUMN "created_at" TO "id"`);
        await queryRunner.query(`ALTER TABLE "change_history" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4()`);
        await queryRunner.query(`ALTER TABLE "client_migration" DROP COLUMN "id"`);
        await queryRunner.query(`ALTER TABLE "client_migration" ADD "id" uuid NOT NULL DEFAULT uuid_generate_v4()`);
        await queryRunner.query(`ALTER TABLE "client_migration" DROP CONSTRAINT "PK_93d3cea8680434b8f7a689c9835"`);
        await queryRunner.query(`ALTER TABLE "client_migration" ADD CONSTRAINT "PK_9ca1759c281e3be4a18a46aab4b" PRIMARY KEY ("migration_name", "id")`);
        await queryRunner.query(`ALTER TABLE "client_migration" DROP CONSTRAINT "PK_9ca1759c281e3be4a18a46aab4b"`);
        await queryRunner.query(`ALTER TABLE "client_migration" ADD CONSTRAINT "PK_3722f14cd336d56c1d65d7c3778" PRIMARY KEY ("id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "client_migration" DROP CONSTRAINT "PK_3722f14cd336d56c1d65d7c3778"`);
        await queryRunner.query(`ALTER TABLE "client_migration" ADD CONSTRAINT "PK_9ca1759c281e3be4a18a46aab4b" PRIMARY KEY ("migration_name", "id")`);
        await queryRunner.query(`ALTER TABLE "client_migration" DROP CONSTRAINT "PK_9ca1759c281e3be4a18a46aab4b"`);
        await queryRunner.query(`ALTER TABLE "client_migration" ADD CONSTRAINT "PK_93d3cea8680434b8f7a689c9835" PRIMARY KEY ("migration_name")`);
        await queryRunner.query(`ALTER TABLE "client_migration" DROP COLUMN "id"`);
        await queryRunner.query(`ALTER TABLE "client_migration" ADD "id" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "change_history" ALTER COLUMN "id" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "client_migration" RENAME COLUMN "id" TO "created_at"`);
    }

}
