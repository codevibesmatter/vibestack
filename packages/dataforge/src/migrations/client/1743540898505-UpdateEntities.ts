import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateEntities1743540898505 implements MigrationInterface {
    name = 'UpdateEntities1743540898505'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "FK_a8e7e6c3f9d9528ed35fe5bae33"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_9a16d2c86252529f622fa53f1e3"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_e08fca67ca8966e6b9914bf2956"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c2cbb0398524f475bbd65079df"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "ownerId"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "projectId"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "assigneeId"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "entityId"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "authorId"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "parentId"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "createdAt"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "updatedAt"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "entityType"`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "client_id" uuid`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "entity_type" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "entity_id" uuid NOT NULL`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "author_id" uuid NOT NULL`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "parent_id" uuid`);
        await queryRunner.query(`ALTER TABLE "local_changes" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`CREATE INDEX "IDX_comments_entity_type_entity_id" ON "comments" ("entity_type", "entity_id") `);
        await queryRunner.query(`ALTER TABLE "projects" ADD CONSTRAINT "FK_b1bd2fbf5d0ef67319c91acb5cf" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD CONSTRAINT "FK_9eecdb5b1ed8c7c2a1b392c28d4" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD CONSTRAINT "FK_855d484825b715c545349212c7f" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "comments" ADD CONSTRAINT "FK_e6d38899c31997c45d128a8973b" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "comments" ADD CONSTRAINT "FK_d6f93329801a93536da4241e386" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "comments" DROP CONSTRAINT "FK_d6f93329801a93536da4241e386"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP CONSTRAINT "FK_e6d38899c31997c45d128a8973b"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_855d484825b715c545349212c7f"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_9eecdb5b1ed8c7c2a1b392c28d4"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "FK_b1bd2fbf5d0ef67319c91acb5cf"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_comments_entity_type_entity_id"`);
        await queryRunner.query(`ALTER TABLE "local_changes" DROP COLUMN "created_at"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "parent_id"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "author_id"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "entity_id"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "entity_type"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "updated_at"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "created_at"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "client_id"`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "entityType" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "updatedAt" TIMESTAMP NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "createdAt" TIMESTAMP NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "parentId" uuid`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "authorId" uuid NOT NULL`);
        await queryRunner.query(`ALTER TABLE "comments" ADD "entityId" uuid NOT NULL`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD "assigneeId" uuid`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD "projectId" uuid`);
        await queryRunner.query(`ALTER TABLE "projects" ADD "ownerId" uuid`);
        await queryRunner.query(`CREATE INDEX "IDX_c2cbb0398524f475bbd65079df" ON "comments" ("entityType", "entityId") `);
        await queryRunner.query(`ALTER TABLE "tasks" ADD CONSTRAINT "FK_e08fca67ca8966e6b9914bf2956" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD CONSTRAINT "FK_9a16d2c86252529f622fa53f1e3" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "projects" ADD CONSTRAINT "FK_a8e7e6c3f9d9528ed35fe5bae33" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

}
