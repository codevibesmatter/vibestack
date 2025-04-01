import { MigrationInterface, QueryRunner } from "typeorm";

export class CamelToSnakeCommentMigration1743536670146 implements MigrationInterface {
    name = 'CamelToSnakeCommentMigration1743536670146'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_a3cf15deec04b032ff6333923b"`);
        await queryRunner.query(`CREATE INDEX "IDX_comments_entity_type_entity_id" ON "comments" ("entity_type", "entity_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_comments_entity_type_entity_id"`);
        await queryRunner.query(`CREATE INDEX "IDX_a3cf15deec04b032ff6333923b" ON "comments" ("entity_id", "entity_type") `);
    }

}
