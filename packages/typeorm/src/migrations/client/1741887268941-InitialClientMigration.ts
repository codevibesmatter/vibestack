import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialClientMigration1741887268941 implements MigrationInterface {
    name = 'InitialClientMigration1741887268941'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."client_migration_status_status_enum" AS ENUM('pending', 'in_progress', 'completed', 'failed', 'rolled_back')`);
        await queryRunner.query(`CREATE TABLE "client_migration_status" ("migration_name" text NOT NULL, "schema_version" text NOT NULL, "status" "public"."client_migration_status_status_enum" NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE, "completed_at" TIMESTAMP WITH TIME ZONE, "error_message" text, "attempts" integer NOT NULL DEFAULT '0', "timestamp" bigint NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0d89b2a45a1a40c35fe3fb81aae" PRIMARY KEY ("migration_name"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f6a012ebab7ea3ff10fa8f3c58" ON "client_migration_status" ("schema_version") `);
        await queryRunner.query(`CREATE TABLE "comments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "content" text NOT NULL, "entityType" character varying NOT NULL, "entityId" uuid NOT NULL, "authorId" uuid NOT NULL, "parentId" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8bf68bc960f2b69e818bdb90dcb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c2cbb0398524f475bbd65079df" ON "comments" ("entityType", "entityId") `);
        await queryRunner.query(`CREATE TABLE "local_changes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "entity_type" text NOT NULL, "entity_id" text NOT NULL, "operation" text NOT NULL, "data" jsonb NOT NULL, "timestamp" bigint NOT NULL, "processed_local" boolean NOT NULL DEFAULT false, "processed_sync" boolean NOT NULL DEFAULT false, "error" text, "attempts" integer NOT NULL DEFAULT '0', "from_server" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_183aaeba20c9012ea8d4f54a8bf" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."tasks_status_enum" AS ENUM('open', 'in_progress', 'completed')`);
        await queryRunner.query(`CREATE TYPE "public"."tasks_priority_enum" AS ENUM('low', 'medium', 'high')`);
        await queryRunner.query(`CREATE TABLE "tasks" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "title" character varying(100) NOT NULL, "description" text, "status" "public"."tasks_status_enum" NOT NULL, "priority" "public"."tasks_priority_enum" NOT NULL DEFAULT 'medium', "due_date" TIMESTAMP WITH TIME ZONE, "completed_at" TIMESTAMP WITH TIME ZONE, "time_range" tsrange, "estimated_duration" interval, "tags" text array NOT NULL DEFAULT '{}', "project_id" uuid NOT NULL, "assignee_id" uuid, "client_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "projectId" uuid, "assigneeId" uuid, CONSTRAINT "PK_8d12ff38fcc62aaba2cab748772" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."users_role_enum" AS ENUM('admin', 'member', 'viewer')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "email" character varying(255) NOT NULL, "avatar_url" character varying(255), "role" "public"."users_role_enum" NOT NULL DEFAULT 'member', "client_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."projects_status_enum" AS ENUM('active', 'in_progress', 'completed', 'on_hold')`);
        await queryRunner.query(`CREATE TABLE "projects" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "description" text, "status" "public"."projects_status_enum" NOT NULL DEFAULT 'active', "owner_id" uuid NOT NULL, "client_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "ownerId" uuid, CONSTRAINT "PK_6271df0a7aed1d6c0691ce6ac50" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "task_dependencies" ("dependent_task_id" uuid NOT NULL, "dependency_task_id" uuid NOT NULL, CONSTRAINT "PK_71b0636f4fd9b1536100fc28e16" PRIMARY KEY ("dependent_task_id", "dependency_task_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_edffc2045be39cc292fe4abedd" ON "task_dependencies" ("dependent_task_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ba14d140f4b3a79b3b1f475de5" ON "task_dependencies" ("dependency_task_id") `);
        await queryRunner.query(`CREATE TABLE "project_members" ("project_id" uuid NOT NULL, "user_id" uuid NOT NULL, CONSTRAINT "PK_b3f491d3a3f986106d281d8eb4b" PRIMARY KEY ("project_id", "user_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b5729113570c20c7e214cf3f58" ON "project_members" ("project_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_e89aae80e010c2faa72e6a49ce" ON "project_members" ("user_id") `);
        await queryRunner.query(`ALTER TABLE "tasks" ADD CONSTRAINT "FK_e08fca67ca8966e6b9914bf2956" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD CONSTRAINT "FK_9a16d2c86252529f622fa53f1e3" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "projects" ADD CONSTRAINT "FK_a8e7e6c3f9d9528ed35fe5bae33" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "task_dependencies" ADD CONSTRAINT "FK_edffc2045be39cc292fe4abedde" FOREIGN KEY ("dependent_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "task_dependencies" ADD CONSTRAINT "FK_ba14d140f4b3a79b3b1f475de57" FOREIGN KEY ("dependency_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "project_members" ADD CONSTRAINT "FK_b5729113570c20c7e214cf3f58d" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "project_members" ADD CONSTRAINT "FK_e89aae80e010c2faa72e6a49ce8" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "project_members" DROP CONSTRAINT "FK_e89aae80e010c2faa72e6a49ce8"`);
        await queryRunner.query(`ALTER TABLE "project_members" DROP CONSTRAINT "FK_b5729113570c20c7e214cf3f58d"`);
        await queryRunner.query(`ALTER TABLE "task_dependencies" DROP CONSTRAINT "FK_ba14d140f4b3a79b3b1f475de57"`);
        await queryRunner.query(`ALTER TABLE "task_dependencies" DROP CONSTRAINT "FK_edffc2045be39cc292fe4abedde"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "FK_a8e7e6c3f9d9528ed35fe5bae33"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_9a16d2c86252529f622fa53f1e3"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_e08fca67ca8966e6b9914bf2956"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e89aae80e010c2faa72e6a49ce"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b5729113570c20c7e214cf3f58"`);
        await queryRunner.query(`DROP TABLE "project_members"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ba14d140f4b3a79b3b1f475de5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_edffc2045be39cc292fe4abedd"`);
        await queryRunner.query(`DROP TABLE "task_dependencies"`);
        await queryRunner.query(`DROP TABLE "projects"`);
        await queryRunner.query(`DROP TYPE "public"."projects_status_enum"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
        await queryRunner.query(`DROP TABLE "tasks"`);
        await queryRunner.query(`DROP TYPE "public"."tasks_priority_enum"`);
        await queryRunner.query(`DROP TYPE "public"."tasks_status_enum"`);
        await queryRunner.query(`DROP TABLE "local_changes"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c2cbb0398524f475bbd65079df"`);
        await queryRunner.query(`DROP TABLE "comments"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f6a012ebab7ea3ff10fa8f3c58"`);
        await queryRunner.query(`DROP TABLE "client_migration_status"`);
        await queryRunner.query(`DROP TYPE "public"."client_migration_status_status_enum"`);
    }

}
