import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialClientSchema1746049351106 implements MigrationInterface {
    name = 'InitialClientSchema1746049351106'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."client_migration_status_status_enum" AS ENUM('pending', 'in_progress', 'completed', 'failed', 'rolled_back')`);
        await queryRunner.query(`CREATE TABLE "client_migration_status" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "migration_name" text NOT NULL, "schema_version" text NOT NULL, "status" "public"."client_migration_status_status_enum" NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE, "completed_at" TIMESTAMP WITH TIME ZONE, "error_message" text, "attempts" integer NOT NULL DEFAULT '0', "timestamp" bigint NOT NULL, CONSTRAINT "PK_c36ad25534183aea155df9ca89d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "comments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "client_id" uuid, "content" text NOT NULL, "author_id" uuid, "parent_id" uuid, "task_id" uuid, "project_id" uuid, CONSTRAINT "PK_8bf68bc960f2b69e818bdb90dcb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "local_changes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "table" text NOT NULL, "operation" text NOT NULL, "data" jsonb NOT NULL, "lsn" text NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "processed_sync" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_183aaeba20c9012ea8d4f54a8bf" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."projects_status_enum" AS ENUM('active', 'in_progress', 'completed', 'on_hold')`);
        await queryRunner.query(`CREATE TABLE "projects" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "client_id" uuid, "name" character varying(100) NOT NULL, "description" text, "status" "public"."projects_status_enum" NOT NULL DEFAULT 'active', "owner_id" uuid, CONSTRAINT "PK_6271df0a7aed1d6c0691ce6ac50" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "sync_metadata" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "current_lsn" text NOT NULL DEFAULT '0/0', "sync_state" text NOT NULL DEFAULT 'disconnected', "last_sync_time" TIMESTAMP WITH TIME ZONE, "pending_changes_count" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_fbdfc072a3e60cc5086d9d84b05" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."tasks_status_enum" AS ENUM('open', 'in_progress', 'completed')`);
        await queryRunner.query(`CREATE TYPE "public"."tasks_priority_enum" AS ENUM('low', 'medium', 'high')`);
        await queryRunner.query(`CREATE TABLE "tasks" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "client_id" uuid, "title" character varying(100) NOT NULL, "description" text, "status" "public"."tasks_status_enum" NOT NULL, "priority" "public"."tasks_priority_enum" NOT NULL DEFAULT 'medium', "due_date" TIMESTAMP WITH TIME ZONE, "completed_at" TIMESTAMP WITH TIME ZONE, "time_range" tsrange, "estimated_duration" interval, "tags" text array NOT NULL DEFAULT '{}', "project_id" uuid, "assignee_id" uuid, CONSTRAINT "PK_8d12ff38fcc62aaba2cab748772" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."users_role_enum" AS ENUM('admin', 'member', 'viewer')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "client_id" uuid, "name" character varying(100) NOT NULL, "email" character varying(255) NOT NULL, "email_verified" boolean NOT NULL DEFAULT false, "image" character varying(255), "role" "public"."users_role_enum" NOT NULL DEFAULT 'member', CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "project_members" ("project_id" uuid NOT NULL, "user_id" uuid NOT NULL, CONSTRAINT "PK_b3f491d3a3f986106d281d8eb4b" PRIMARY KEY ("project_id", "user_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b5729113570c20c7e214cf3f58" ON "project_members" ("project_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_e89aae80e010c2faa72e6a49ce" ON "project_members" ("user_id") `);
        await queryRunner.query(`CREATE TABLE "task_dependencies" ("dependent_task_id" uuid NOT NULL, "dependency_task_id" uuid NOT NULL, CONSTRAINT "PK_71b0636f4fd9b1536100fc28e16" PRIMARY KEY ("dependent_task_id", "dependency_task_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_edffc2045be39cc292fe4abedd" ON "task_dependencies" ("dependent_task_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ba14d140f4b3a79b3b1f475de5" ON "task_dependencies" ("dependency_task_id") `);
        await queryRunner.query(`ALTER TABLE "comments" ADD CONSTRAINT "FK_e6d38899c31997c45d128a8973b" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "comments" ADD CONSTRAINT "FK_d6f93329801a93536da4241e386" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "comments" ADD CONSTRAINT "FK_18c2493067c11f44efb35ca0e03" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "comments" ADD CONSTRAINT "FK_03dbde2ff570596e874bb3bb311" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "projects" ADD CONSTRAINT "FK_b1bd2fbf5d0ef67319c91acb5cf" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD CONSTRAINT "FK_9eecdb5b1ed8c7c2a1b392c28d4" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD CONSTRAINT "FK_855d484825b715c545349212c7f" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "project_members" ADD CONSTRAINT "FK_b5729113570c20c7e214cf3f58d" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "project_members" ADD CONSTRAINT "FK_e89aae80e010c2faa72e6a49ce8" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "task_dependencies" ADD CONSTRAINT "FK_edffc2045be39cc292fe4abedde" FOREIGN KEY ("dependent_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "task_dependencies" ADD CONSTRAINT "FK_ba14d140f4b3a79b3b1f475de57" FOREIGN KEY ("dependency_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "task_dependencies" DROP CONSTRAINT "FK_ba14d140f4b3a79b3b1f475de57"`);
        await queryRunner.query(`ALTER TABLE "task_dependencies" DROP CONSTRAINT "FK_edffc2045be39cc292fe4abedde"`);
        await queryRunner.query(`ALTER TABLE "project_members" DROP CONSTRAINT "FK_e89aae80e010c2faa72e6a49ce8"`);
        await queryRunner.query(`ALTER TABLE "project_members" DROP CONSTRAINT "FK_b5729113570c20c7e214cf3f58d"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_855d484825b715c545349212c7f"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_9eecdb5b1ed8c7c2a1b392c28d4"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "FK_b1bd2fbf5d0ef67319c91acb5cf"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP CONSTRAINT "FK_03dbde2ff570596e874bb3bb311"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP CONSTRAINT "FK_18c2493067c11f44efb35ca0e03"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP CONSTRAINT "FK_d6f93329801a93536da4241e386"`);
        await queryRunner.query(`ALTER TABLE "comments" DROP CONSTRAINT "FK_e6d38899c31997c45d128a8973b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ba14d140f4b3a79b3b1f475de5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_edffc2045be39cc292fe4abedd"`);
        await queryRunner.query(`DROP TABLE "task_dependencies"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e89aae80e010c2faa72e6a49ce"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b5729113570c20c7e214cf3f58"`);
        await queryRunner.query(`DROP TABLE "project_members"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
        await queryRunner.query(`DROP TABLE "tasks"`);
        await queryRunner.query(`DROP TYPE "public"."tasks_priority_enum"`);
        await queryRunner.query(`DROP TYPE "public"."tasks_status_enum"`);
        await queryRunner.query(`DROP TABLE "sync_metadata"`);
        await queryRunner.query(`DROP TABLE "projects"`);
        await queryRunner.query(`DROP TYPE "public"."projects_status_enum"`);
        await queryRunner.query(`DROP TABLE "local_changes"`);
        await queryRunner.query(`DROP TABLE "comments"`);
        await queryRunner.query(`DROP TABLE "client_migration_status"`);
        await queryRunner.query(`DROP TYPE "public"."client_migration_status_status_enum"`);
    }

}
