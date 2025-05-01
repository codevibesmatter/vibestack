import { MigrationInterface, QueryRunner } from "typeorm";

export class RevertJWKSColumnsToCamelCase1746119000000 implements MigrationInterface {
    name = 'RevertJWKSColumnsToCamelCase1746119000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Check if new columns exist and if they do, rename them to camelCase
        try {
            // Rename snake_case columns back to camelCase
            await queryRunner.query(`ALTER TABLE "jwks" RENAME COLUMN "public_key" TO "publicKey"`);
            await queryRunner.query(`ALTER TABLE "jwks" RENAME COLUMN "private_key" TO "privateKey"`);
        } catch (error) {
            console.log("Error renaming columns, they may already be in camelCase:", error);
            
            // If the columns don't exist, they might be in camelCase already
            // OR we might need to recreate them from scratch
            try {
                // Check if camelCase columns exist
                await queryRunner.query(`SELECT "publicKey" FROM "jwks" LIMIT 1`);
                console.log("camelCase columns already exist, no action needed");
            } catch (err) {
                // If we get here, neither snake_case nor camelCase columns exist
                // We'll need to recreate them
                console.log("Recreating columns in camelCase format");
                await queryRunner.query(`ALTER TABLE "jwks" ADD "publicKey" text NOT NULL`);
                await queryRunner.query(`ALTER TABLE "jwks" ADD "privateKey" text NOT NULL`);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Revert back to snake_case
        await queryRunner.query(`ALTER TABLE "jwks" RENAME COLUMN "publicKey" TO "public_key"`);
        await queryRunner.query(`ALTER TABLE "jwks" RENAME COLUMN "privateKey" TO "private_key"`);
    }
} 