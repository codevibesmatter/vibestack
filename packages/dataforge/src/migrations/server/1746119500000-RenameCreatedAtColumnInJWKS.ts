import { MigrationInterface, QueryRunner } from "typeorm";

export class RenameCreatedAtColumnInJWKS1746119500000 implements MigrationInterface {
    name = 'RenameCreatedAtColumnInJWKS1746119500000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Rename created_at to createdAt
        try {
            await queryRunner.query(`ALTER TABLE "jwks" RENAME COLUMN "created_at" TO "createdAt"`);
            console.log("Successfully renamed created_at to createdAt in jwks table");
        } catch (error) {
            console.log("Error renaming created_at column:", error);
            
            // Check if the createdAt column already exists
            try {
                await queryRunner.query(`SELECT "createdAt" FROM "jwks" LIMIT 1`);
                console.log("createdAt column already exists, no action needed");
            } catch (err) {
                // If createdAt doesn't exist, we need to add it
                console.log("Adding createdAt column");
                await queryRunner.query(`ALTER TABLE "jwks" ADD "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Revert to snake_case
        await queryRunner.query(`ALTER TABLE "jwks" RENAME COLUMN "createdAt" TO "created_at"`);
    }
} 