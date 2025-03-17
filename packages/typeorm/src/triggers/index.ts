import { DataSource } from 'typeorm';

/**
 * Creates trigger functions for domain entities (Task, Project, User).
 * These functions handle:
 * 1. Resetting client_id when unchanged in updates
 * 2. Updating updated_at timestamp on changes
 */
export async function createTriggerFunctions(dataSource: DataSource) {
  // Reset client_id when it hasn't changed in an update
  await dataSource.query(`
    CREATE OR REPLACE FUNCTION reset_client_id()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.client_id IS NOT DISTINCT FROM OLD.client_id THEN
        NEW.client_id = NULL;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Update the updated_at timestamp on any change
  await dataSource.query(`
    CREATE OR REPLACE FUNCTION update_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
}

/**
 * Creates triggers for domain entities (Task, Project, User).
 * These triggers handle:
 * 1. Resetting client_id when unchanged in updates
 * 2. Updating updated_at timestamp on changes
 */
export async function createTriggers(dataSource: DataSource) {
  // Domain entities that have client_id and updated_at fields
  const domainEntities = ['tasks', 'projects', 'users'];
  
  for (const table of domainEntities) {
    // Create trigger for client_id reset
    await dataSource.query(`
      CREATE TRIGGER reset_client_id_trigger
      BEFORE UPDATE ON "${table}"
      FOR EACH ROW
      EXECUTE FUNCTION reset_client_id();
    `);

    // Create trigger for updated_at timestamp
    await dataSource.query(`
      CREATE TRIGGER update_updated_at_trigger
      BEFORE UPDATE ON "${table}"
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at();
    `);
  }
}

export async function dropTriggers(dataSource: DataSource) {
  const domainEntities = ['tasks', 'projects', 'users'];
  
  // Drop all triggers
  for (const table of domainEntities) {
    await dataSource.query(`
      DROP TRIGGER IF EXISTS reset_client_id_trigger ON "${table}";
      DROP TRIGGER IF EXISTS update_updated_at_trigger ON "${table}";
    `);
  }

  // Drop trigger functions
  await dataSource.query(`
    DROP FUNCTION IF EXISTS reset_client_id();
    DROP FUNCTION IF EXISTS update_updated_at();
  `);
} 