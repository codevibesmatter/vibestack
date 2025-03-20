import { Client } from '@neondatabase/serverless';
import { Project, ProjectStatus } from "@repo/dataforge/server-entities";
import { validate } from "class-validator";

// Simplified type definitions
type ProjectInstance = Project;

// Input types for API
export type ProjectCreateInput = Partial<Omit<ProjectInstance, 'id' | 'created_at' | 'updated_at'>>;
export type ProjectUpdateInput = Partial<ProjectCreateInput>;

// Database operations
export const projectQueries = {
  findAll: async (client: Client): Promise<ProjectInstance[]> => {
    const result = await client.query<ProjectInstance>(
      `SELECT * FROM "projects"`
    );
    return result.rows;
  },

  findById: async (client: Client, id: string): Promise<ProjectInstance | null> => {
    const result = await client.query<ProjectInstance>(
      `SELECT * FROM "projects" WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  findByOwnerId: async (client: Client, ownerId: string): Promise<ProjectInstance[]> => {
    const result = await client.query<ProjectInstance>(
      `SELECT * FROM "projects" WHERE "owner_id" = $1`,
      [ownerId]
    );
    return result.rows;
  },

  create: async (client: Client, data: ProjectCreateInput): Promise<ProjectInstance> => {
    // Create instance for validation using TypeORM entity
    const project = new Project();
    Object.assign(project, {
      ...data,
      status: data.status || ProjectStatus.ACTIVE
    });
    
    // Leverage class-validator decorators from TypeORM entity
    const errors = await validate(project);
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }

    // Use TypeORM column definitions for SQL
    const columns = Object.keys(data).map(key => `"${key}"`).join(", ");
    const values = Object.values(data);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

    const result = await client.query<ProjectInstance>(
      `INSERT INTO "projects" (${columns}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    return result.rows[0];
  },

  update: async (client: Client, id: string, data: ProjectUpdateInput): Promise<ProjectInstance | null> => {
    // Create instance for validation using TypeORM entity
    const project = new Project();
    Object.assign(project, { id, ...data });
    
    // Leverage class-validator decorators from TypeORM entity
    const errors = await validate(project, { skipMissingProperties: true });
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }

    const setClause = Object.keys(data)
      .map((key, index) => `"${key}" = $${index + 2}`)
      .join(", ");
    
    const values = [id, ...Object.values(data)];
    const result = await client.query<ProjectInstance>(
      `UPDATE "projects" SET ${setClause} WHERE id = $1 RETURNING *`,
      values
    );
    return result.rows[0] || null;
  },

  delete: async (client: Client, id: string): Promise<boolean> => {
    const result = await client.query(
      `DELETE FROM "projects" WHERE id = $1`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}; 