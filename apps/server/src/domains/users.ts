import { Client } from '@neondatabase/serverless';
import { User, UserRole } from "@repo/dataforge/server-entities";
import { validate } from "class-validator";
import { FindOptionsWhere, DeepPartial } from 'typeorm';
import { NeonService } from '../lib/neon-orm/neon-service';
import type { Context } from 'hono';
import type { Env } from '../types/env';

// Re-export enums for convenience
export { UserRole };

// Simplified type definitions
type UserInstance = User;

// Input types for API
export type UserCreateInput = Partial<Omit<UserInstance, 'id' | 'created_at' | 'updated_at'>>;
export type UserUpdateInput = Partial<UserCreateInput>;

/**
 * UserRepository class that uses TypeORM
 */
export class UserRepository {
  private neonService: NeonService;
  
  constructor(neonService: NeonService) {
    this.neonService = neonService;
  }

  /**
   * Find all users
   */
  async findAll(): Promise<User[]> {
    return await this.neonService.find(User);
  }

  /**
   * Find user by ID
   */
  async findById(id: string): Promise<User | null> {
    return await this.neonService.findOne(User, { id } as FindOptionsWhere<User>);
  }

  /**
   * Find user by email
   */
  async findByEmail(email: string): Promise<User | null> {
    return await this.neonService.findOne(User, { email } as FindOptionsWhere<User>);
  }

  /**
   * Find users by role
   */
  async findByRole(role: UserRole): Promise<User[]> {
    return await this.neonService.find(User, { role } as FindOptionsWhere<User>);
  }

  /**
   * Find project members
   */
  async findProjectMembers(projectId: string): Promise<User[]> {
    const queryBuilder = await this.neonService.createQueryBuilder(User, 'u');
    return await queryBuilder
      .innerJoin('project_members', 'pm', 'u.id = pm.user_id')
      .where('pm.project_id = :projectId', { projectId })
      .getMany();
  }

  /**
   * Create a new user
   */
  async create(data: UserCreateInput): Promise<User> {
    // Set default values if not provided
    const userData = {
      ...data,
      role: data.role || UserRole.MEMBER,
      emailVerified: data.emailVerified !== undefined ? data.emailVerified : false
    };
    
    // Create a new user entity
    const user = new User();
    Object.assign(user, userData);
    
    // Validate the user
    const errors = await validate(user, { skipMissingProperties: true });
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }
    
    // Insert and return the user
    return await this.neonService.insert(User, userData as DeepPartial<User>);
  }

  /**
   * Update a user
   */
  async update(id: string, data: UserUpdateInput): Promise<User | null> {
    // Create user for validation
    const user = new User();
    Object.assign(user, { id, ...data });
    
    // Validate user
    const errors = await validate(user, { skipMissingProperties: true });
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }
    
    // Update the user using TypeORM
    await this.neonService.update(User, { id } as FindOptionsWhere<User>, data as DeepPartial<User>);
    
    // Return the updated user
    return await this.findById(id);
  }

  /**
   * Delete user
   */
  async delete(id: string): Promise<boolean> {
    try {
      // First delete project memberships using direct query
      await this.neonService.query(
        `DELETE FROM project_members WHERE user_id = $1`,
        [id]
      );
      
      // Then delete the user
      const result = await this.neonService.delete(User, { id } as FindOptionsWhere<User>);
      return (result.affected !== null && result.affected !== undefined && result.affected > 0);
    } catch (error) {
      console.error('Error deleting user:', error);
      throw error;
    }
  }
}

// Helper to create a NeonService instance from a Neon client
const createServiceFromClient = (client: Client): NeonService => {
  // Create a minimal mock of Hono context with the client
  // First cast to unknown to avoid strict type checking errors
  const context = {
    req: { neon: client },
    env: { DATABASE_URL: "neon-client://internal" },
    // Add minimal implementations of required methods/properties
    finalized: false,
    error: null,
    get executionCtx() { return null; },
    get event() { return null; }
  } as unknown as Context<{ Bindings: Env }>;
  
  return new NeonService(context);
};

// Legacy compatibility layer - maps the class-based repository to the old interface
export const userQueries = {
  findAll: async (client: Client): Promise<UserInstance[]> => {
    const neonService = createServiceFromClient(client);
    const repo = new UserRepository(neonService);
    return await repo.findAll();
  },

  findById: async (client: Client, id: string): Promise<UserInstance | null> => {
    const neonService = createServiceFromClient(client);
    const repo = new UserRepository(neonService);
    return await repo.findById(id);
  },

  create: async (client: Client, data: UserCreateInput): Promise<UserInstance> => {
    const neonService = createServiceFromClient(client);
    const repo = new UserRepository(neonService);
    return await repo.create(data);
  },

  update: async (client: Client, id: string, data: UserUpdateInput): Promise<UserInstance | null> => {
    const neonService = createServiceFromClient(client);
    const repo = new UserRepository(neonService);
    return await repo.update(id, data);
  },

  delete: async (client: Client, id: string): Promise<boolean> => {
    const neonService = createServiceFromClient(client);
    const repo = new UserRepository(neonService);
    return await repo.delete(id);
  },

  findByEmail: async (client: Client, email: string): Promise<UserInstance | null> => {
    const neonService = createServiceFromClient(client);
    const repo = new UserRepository(neonService);
    return await repo.findByEmail(email);
  },
  
  findProjectMembers: async (client: Client, projectId: string): Promise<UserInstance[]> => {
    const neonService = createServiceFromClient(client);
    const repo = new UserRepository(neonService);
    return await repo.findProjectMembers(projectId);
  }
}; 