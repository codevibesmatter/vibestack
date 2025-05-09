import { Client } from '@neondatabase/serverless';
import { Project, ProjectStatus } from "@repo/dataforge/server-entities";
import { validate } from "class-validator";
import { FindOptionsWhere, DeepPartial } from 'typeorm';
import { NeonService } from '../lib/neon-orm/neon-service';
import type { Context } from 'hono';
import type { Env } from '../types/env';

// Re-export enums for convenience
export { ProjectStatus };

// Simplified type definitions
type ProjectInstance = Project;

// Input types for API
export type ProjectCreateInput = Partial<Omit<ProjectInstance, 'id' | 'created_at' | 'updated_at'>>;
export type ProjectUpdateInput = Partial<ProjectCreateInput>;

/**
 * ProjectRepository class that uses TypeORM
 */
export class ProjectRepository {
  private neonService: NeonService;
  
  constructor(neonService: NeonService) {
    this.neonService = neonService;
  }

  /**
   * Find all projects
   */
  async findAll(): Promise<Project[]> {
    return await this.neonService.find(Project);
  }

  /**
   * Find project by ID
   */
  async findById(id: string): Promise<Project | null> {
    return await this.neonService.findOne(Project, { id } as FindOptionsWhere<Project>);
  }

  /**
   * Find projects by owner ID
   */
  async findByOwnerId(ownerId: string): Promise<Project[]> {
    return await this.neonService.find(Project, { ownerId } as FindOptionsWhere<Project>);
  }

  /**
   * Find projects by status
   */
  async findByStatus(status: ProjectStatus): Promise<Project[]> {
    return await this.neonService.find(Project, { status } as FindOptionsWhere<Project>);
  }

  /**
   * Create a new project
   */
  async create(data: ProjectCreateInput): Promise<Project> {
    // Set default values if not provided
    const projectData = {
      ...data,
      status: data.status || ProjectStatus.ACTIVE
    };
    
    // Create a new project entity
    const project = new Project();
    Object.assign(project, projectData);
    
    // Validate the project
    const errors = await validate(project, { skipMissingProperties: true });
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }
    
    // Insert and return the project
    return await this.neonService.insert(Project, projectData as DeepPartial<Project>);
  }

  /**
   * Update a project
   */
  async update(id: string, data: ProjectUpdateInput): Promise<Project | null> {
    // Create project for validation
    const project = new Project();
    Object.assign(project, { id, ...data });
    
    // Validate project
    const errors = await validate(project, { skipMissingProperties: true });
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }
    
    // Update the project using TypeORM
    await this.neonService.update(Project, { id } as FindOptionsWhere<Project>, data as DeepPartial<Project>);
    
    // Return the updated project
    return await this.findById(id);
  }

  /**
   * Delete project
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.neonService.delete(Project, { id } as FindOptionsWhere<Project>);
    return (result.affected !== null && result.affected !== undefined && result.affected > 0);
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
export const projectQueries = {
  findAll: async (client: Client): Promise<ProjectInstance[]> => {
    const neonService = createServiceFromClient(client);
    const repo = new ProjectRepository(neonService);
    return await repo.findAll();
  },

  findById: async (client: Client, id: string): Promise<ProjectInstance | null> => {
    const neonService = createServiceFromClient(client);
    const repo = new ProjectRepository(neonService);
    return await repo.findById(id);
  },

  findByOwnerId: async (client: Client, ownerId: string): Promise<ProjectInstance[]> => {
    const neonService = createServiceFromClient(client);
    const repo = new ProjectRepository(neonService);
    return await repo.findByOwnerId(ownerId);
  },

  create: async (client: Client, data: ProjectCreateInput): Promise<ProjectInstance> => {
    const neonService = createServiceFromClient(client);
    const repo = new ProjectRepository(neonService);
    return await repo.create(data);
  },

  update: async (client: Client, id: string, data: ProjectUpdateInput): Promise<ProjectInstance | null> => {
    const neonService = createServiceFromClient(client);
    const repo = new ProjectRepository(neonService);
    return await repo.update(id, data);
  },

  delete: async (client: Client, id: string): Promise<boolean> => {
    const neonService = createServiceFromClient(client);
    const repo = new ProjectRepository(neonService);
    return await repo.delete(id);
  }
}; 