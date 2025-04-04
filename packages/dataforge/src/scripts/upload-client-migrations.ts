import { DataSource } from 'typeorm';
import pkg from 'glob';
const { glob } = pkg;
import path from 'path';
import { fileURLToPath } from 'url';
import serverDataSource from '../datasources/server.js';
import { ClientMigration, MigrationType, MigrationState } from '../entities/ClientMigration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get migration name from command line args if provided
const forceUpdateMigration = process.argv[2];

async function getMigrationQueries(migration: any): Promise<{ up: string[], down: string[] }> {
  const up: string[] = [];
  const down: string[] = [];

  // Get the queryRunner methods
  const upMethod = migration.up;
  const downMethod = migration.down;

  // Create a mock queryRunner that captures queries
  const queryRunner = {
    query: (query: string) => {
      up.push(query);
      return Promise.resolve();
    }
  };

  // Run the up method to capture queries
  await upMethod.call(migration, queryRunner);

  // Switch to capturing down queries
  queryRunner.query = (query: string) => {
    down.push(query);
    return Promise.resolve();
  };

  // Run the down method to capture queries
  await downMethod.call(migration, queryRunner);

  return { up, down };
}

async function getNextSchemaVersion(dataSource: DataSource): Promise<string> {
  // Get the latest schema version from existing migrations
  const result = await dataSource.manager
    .createQueryBuilder(ClientMigration, "migration")
    .select("migration.schemaVersion")
    .orderBy("migration.schemaVersion", "DESC")
    .getOne();

  if (!result) {
    return "0.1.0"; // Initial version if no migrations exist
  }

  // Parse version and increment minor version
  const [major, minor, patch] = result.schemaVersion.split('.').map(Number);
  return `${major}.${minor + 1}.${patch}`;
}

async function uploadClientMigrations() {
  try {
    // Initialize server connection
    await serverDataSource.initialize();

    // Get existing migrations from server
    const existingMigrations = await serverDataSource.manager.find(ClientMigration);
    const existingMigrationNames = new Set(existingMigrations.map(m => m.migrationName));

    // Get all client migration files
    const pattern = path.join(process.cwd(), 'src/migrations/client/*.ts');
    const migrationFiles = await new Promise<string[]>((resolve, reject) => {
      glob(pattern, (err, matches) => {
        if (err) reject(err);
        else resolve(matches);
      });
    });

    // Process migration files
    const migrationsToUpload = [];
    for (const file of migrationFiles) {
      // Import migration file to get its name
      const migration = await import(file);
      const migrationClass = Object.values(migration)[0] as any;
      const instance = new migrationClass();
      
      // Include if it's new OR if it matches the force update name
      if (!existingMigrationNames.has(instance.name) || instance.name === forceUpdateMigration) {
        migrationsToUpload.push({ file, instance });
      }
    }

    if (migrationsToUpload.length === 0) {
      console.log('No migrations to upload');
      return;
    }

    // Get the next schema version only if we have migrations to upload
    const schemaVersion = await getNextSchemaVersion(serverDataSource);
    
    for (const { file, instance } of migrationsToUpload) {
      // Extract timestamp from filename
      const timestamp = parseInt(path.basename(file).split('-')[0]);

      // Get queries from migration
      const { up, down } = await getMigrationQueries(instance);

      // Create migration record
      const clientMigration = new ClientMigration();
      clientMigration.migrationName = instance.name;
      clientMigration.schemaVersion = schemaVersion;
      clientMigration.dependencies = [];
      clientMigration.migrationType = MigrationType.SCHEMA;
      clientMigration.state = MigrationState.PENDING;
      clientMigration.upQueries = up;
      clientMigration.downQueries = down;
      clientMigration.timestamp = timestamp;
      clientMigration.description = `Client migration ${instance.name}`;

      if (instance.name === forceUpdateMigration) {
        // Update existing migration
        await serverDataSource.manager.createQueryBuilder()
          .update(ClientMigration)
          .set({
            schemaVersion: schemaVersion,
            upQueries: up,
            downQueries: down,
            state: MigrationState.PENDING // Reset state for re-application
          })
          .where("migration_name = :name", { name: instance.name })
          .execute();
        
        console.log(`Updated existing migration: ${instance.name} with schema version ${schemaVersion}`);
      } else {
        // Insert new migration
        await serverDataSource.manager.createQueryBuilder()
          .insert()
          .into(ClientMigration)
          .values(clientMigration)
          .execute();
        
        console.log(`Uploaded new client migration: ${instance.name} with schema version ${schemaVersion}`);
      }
    }

    console.log('All client migrations processed successfully');
  } catch (error) {
    console.error('Error uploading client migrations:', error);
    process.exit(1);
  } finally {
    await serverDataSource.destroy();
  }
}

// Run the upload
uploadClientMigrations(); 