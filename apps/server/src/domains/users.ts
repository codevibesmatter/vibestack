import { Client } from '@neondatabase/serverless';
import { User, UserRole } from "@repo/typeorm/server-entities";
import { validate } from "class-validator";

// Simplified type definitions
type UserInstance = User;

// Input types for API
export type UserCreateInput = Partial<Omit<UserInstance, 'id' | 'created_at' | 'updated_at'>>;
export type UserUpdateInput = Partial<UserCreateInput>;

// Database operations
export const userQueries = {
  findAll: async (client: Client): Promise<UserInstance[]> => {
    const result = await client.query<UserInstance>(
      'SELECT * FROM "users"'
    );
    return result.rows;
  },

  findById: async (client: Client, id: string): Promise<UserInstance | null> => {
    const result = await client.query<UserInstance>(
      'SELECT * FROM "users" WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  },

  create: async (client: Client, data: UserCreateInput): Promise<UserInstance> => {
    // Create instance for validation using TypeORM entity
    const user = new User();
    Object.assign(user, {
      ...data,
      role: data.role || UserRole.MEMBER
    });
    
    // Skip validation for id, created_at, and updated_at since they're handled by the database
    const errors = await validate(user, { 
      skipMissingProperties: true,
      validationError: { target: false }
    });
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }

    // Use TypeORM column definitions for SQL
    const columns = Object.keys(data).map(key => `"${key}"`).join(", ");
    const values = Object.values(data);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

    const result = await client.query<UserInstance>(
      `INSERT INTO "users" (${columns}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    return result.rows[0];
  },

  update: async (client: Client, id: string, data: UserUpdateInput): Promise<UserInstance | null> => {
    // Create instance for validation using TypeORM entity
    const user = new User();
    Object.assign(user, { id, ...data });
    
    // Leverage class-validator decorators from TypeORM entity
    const errors = await validate(user, { skipMissingProperties: true });
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }

    const setClause = Object.keys(data)
      .map((key, index) => `"${key}" = $${index + 2}`)
      .join(", ");
    
    const values = [id, ...Object.values(data)];
    const result = await client.query<UserInstance>(
      `UPDATE "users" SET ${setClause} WHERE id = $1 RETURNING *`,
      values
    );
    return result.rows[0] || null;
  },

  delete: async (client: Client, id: string): Promise<boolean> => {
    // First delete project memberships
    await client.query(
      'DELETE FROM project_members WHERE user_id = $1',
      [id]
    );
    
    // Then delete the user
    const result = await client.query(
      'DELETE FROM "users" WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  },
  findByEmail: async (client: Client, email: string): Promise<UserInstance | null> => {
    const result = await client.query<UserInstance>(
      'SELECT * FROM "users" WHERE email = $1',
      [email]
    );
    return result.rows[0] || null;
  },
  
  findProjectMembers: async (client: Client, projectId: string): Promise<UserInstance[]> => {
    const result = await client.query<UserInstance>(
      `SELECT u.* FROM "users" u
       JOIN project_members pm ON u.id = pm.user_id
       WHERE pm.project_id = $1`,
      [projectId]
    );
    return result.rows;
  }
}; 