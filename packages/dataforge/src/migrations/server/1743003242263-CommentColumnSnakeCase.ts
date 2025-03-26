import { MigrationInterface, QueryRunner } from "typeorm";

export class CommentColumnSnakeCase1743003242263 implements MigrationInterface {
    name = 'CommentColumnSnakeCase1743003242263'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_c2cbb0398524f475bbd65079df"`);
        await queryRunner.query(`ALTER TABLE "comments" RENAME COLUMN "entityType" TO "entity_type"`);
        await queryRunner.query(`ALTER TABLE "comments" RENAME COLUMN "entityId" TO "entity_id"`);
        await queryRunner.query(`ALTER TABLE "comments" RENAME COLUMN "authorId" TO "author_id"`);
        await queryRunner.query(`ALTER TABLE "comments" RENAME COLUMN "parentId" TO "parent_id"`);
        await queryRunner.query(`ALTER TABLE "comments" RENAME COLUMN "createdAt" TO "created_at"`);
        await queryRunner.query(`ALTER TABLE "comments" RENAME COLUMN "updatedAt" TO "updated_at"`);
        await queryRunner.query(`CREATE INDEX "IDX_a3cf15deec04b032ff6333923b" ON "comments" ("entity_type", "entity_id") `);
        await queryRunner.query(`ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "FK_4548cc4a409b8651ec75f70e280"`);
        await queryRunner.query(`ALTER TABLE "comments" ADD CONSTRAINT "FK_7e8d7c49f218ebb14314fdb3749" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "FK_e3aebe2bd1c53467a07109be596"`);
        await queryRunner.query(`ALTER TABLE "comments" ADD CONSTRAINT "FK_e3aebe2bd1c53467a07109be596" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "FK_7e8d7c49f218ebb14314fdb3749"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "FK_e3aebe2bd1c53467a07109be596"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a3cf15deec04b032ff6333923b"`);
        await queryRunner.query(`ALTER TABLE "comments" RENAME COLUMN "entity_type" TO "entityType"`);
        await queryRunner.query(`ALTER TABLE "comments" RENAME COLUMN "entity_id" TO "entityId"`);
        await queryRunner.query(`ALTER TABLE "comments" RENAME COLUMN "author_id" TO "authorId"`);
        await queryRunner.query(`ALTER TABLE "comments" RENAME COLUMN "parent_id" TO "parentId"`);
        await queryRunner.query(`ALTER TABLE "comments" RENAME COLUMN "created_at" TO "createdAt"`);
        await queryRunner.query(`ALTER TABLE "comments" RENAME COLUMN "updated_at" TO "updatedAt"`);
        await queryRunner.query(`CREATE INDEX "IDX_c2cbb0398524f475bbd65079df" ON "comments" ("entityType", "entityId") `);
        await queryRunner.query(`ALTER TABLE "comments" ADD CONSTRAINT "FK_4548cc4a409b8651ec75f70e280" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "comments" ADD CONSTRAINT "FK_e3aebe2bd1c53467a07109be596" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

}
