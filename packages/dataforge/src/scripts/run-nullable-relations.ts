import serverDataSource from '../datasources/server.js';

/**
 * Script to make the relationship fields nullable
 */
async function makeRelationshipsNullable() {
  try {
    console.log('Starting to update relationship fields to be nullable...');
    
    // Make sure connection is established
    if (!serverDataSource.isInitialized) {
      await serverDataSource.initialize();
    }

    // Run the migration SQL directly
    await serverDataSource.query(`ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "FK_b1bd2fbf5d0ef67319c91acb5cf"`);
    await serverDataSource.query(`ALTER TABLE "projects" ALTER COLUMN "owner_id" DROP NOT NULL`);
    
    await serverDataSource.query(`ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "FK_9eecdb5b1ed8c7c2a1b392c28d4"`);
    await serverDataSource.query(`ALTER TABLE "tasks" ALTER COLUMN "project_id" DROP NOT NULL`);
    
    await serverDataSource.query(`ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "FK_e6d38899c31997c45d128a8973b"`);
    await serverDataSource.query(`DROP INDEX IF EXISTS "IDX_comments_entity_type_entity_id"`);
    await serverDataSource.query(`ALTER TABLE "comments" ALTER COLUMN "entity_id" DROP NOT NULL`);
    await serverDataSource.query(`ALTER TABLE "comments" ALTER COLUMN "author_id" DROP NOT NULL`);
    await serverDataSource.query(`CREATE INDEX "IDX_comments_entity_type_entity_id" ON "comments" ("entity_type", "entity_id")`);
    
    // Recreate the foreign key constraints with the nullable fields
    await serverDataSource.query(`ALTER TABLE "projects" ADD CONSTRAINT "FK_b1bd2fbf5d0ef67319c91acb5cf" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    await serverDataSource.query(`ALTER TABLE "tasks" ADD CONSTRAINT "FK_9eecdb5b1ed8c7c2a1b392c28d4" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    await serverDataSource.query(`ALTER TABLE "comments" ADD CONSTRAINT "FK_e6d38899c31997c45d128a8973b" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    
    console.log('Successfully updated relationship fields to be nullable!');
    
  } catch (error) {
    console.error('Error updating relationship fields:', error);
  } finally {
    // Clean up to make sure script exits
    process.exit(0);
  }
}

// Run the function
makeRelationshipsNullable(); 