import { Client } from '@neondatabase/serverless';
import { Comment } from "@repo/dataforge/server-entities";
import { validate } from "class-validator";
import { FindOptionsWhere, DeepPartial } from 'typeorm';
import { NeonService } from '../lib/neon-orm/neon-service';
import type { Context } from 'hono';
import type { Env } from '../types/env';

// Simplified type definitions
type CommentInstance = Comment;

// Input types for API
export type CommentCreateInput = Partial<Omit<CommentInstance, 'id' | 'created_at' | 'updated_at'>>;
export type CommentUpdateInput = Partial<CommentCreateInput>;

/**
 * CommentRepository class that uses TypeORM
 */
export class CommentRepository {
  private neonService: NeonService;
  
  constructor(neonService: NeonService) {
    this.neonService = neonService;
  }

  /**
   * Find all comments
   */
  async findAll(): Promise<Comment[]> {
    return await this.neonService.find(Comment);
  }

  /**
   * Find comment by ID
   */
  async findById(id: string): Promise<Comment | null> {
    return await this.neonService.findOne(Comment, { id } as FindOptionsWhere<Comment>);
  }

  /**
   * Find comments by task ID
   */
  async findByTaskId(taskId: string): Promise<Comment[]> {
    return await this.neonService.find(Comment, { taskId } as FindOptionsWhere<Comment>);
  }

  /**
   * Find comments by project ID
   */
  async findByProjectId(projectId: string): Promise<Comment[]> {
    return await this.neonService.find(Comment, { projectId } as FindOptionsWhere<Comment>);
  }

  /**
   * Find comments by author ID
   */
  async findByAuthorId(authorId: string): Promise<Comment[]> {
    return await this.neonService.find(Comment, { authorId } as FindOptionsWhere<Comment>);
  }

  /**
   * Find comments with multiple filters
   */
  async findWithFilters(filters: { taskId?: string; projectId?: string; authorId?: string }): Promise<Comment[]> {
    const queryBuilder = await this.neonService.createQueryBuilder(Comment, 'comment');
    
    if (filters.taskId) {
      queryBuilder.where('comment.taskId = :taskId', { taskId: filters.taskId });
    }
    
    if (filters.projectId) {
      const condition = filters.taskId ? 'comment.projectId = :projectId' : 'comment.projectId = :projectId';
      queryBuilder.andWhere(condition, { projectId: filters.projectId });
    }
    
    if (filters.authorId) {
      const condition = (filters.taskId || filters.projectId) ? 'comment.authorId = :authorId' : 'comment.authorId = :authorId';
      queryBuilder.andWhere(condition, { authorId: filters.authorId });
    }
    
    queryBuilder.orderBy('comment.createdAt', 'DESC');
    return await queryBuilder.getMany();
  }

  /**
   * Create a new comment
   */
  async create(data: CommentCreateInput): Promise<Comment> {
    // Validate that either taskId or projectId is provided
    if (!data.taskId && !data.projectId) {
      throw new Error('Validation failed: Either taskId or projectId must be provided');
    }
    
    // Create a new comment entity
    const comment = new Comment();
    Object.assign(comment, data);
    
    // Validate the comment
    const errors = await validate(comment, { skipMissingProperties: true });
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }
    
    // Insert and return the comment
    return await this.neonService.insert(Comment, data as DeepPartial<Comment>);
  }

  /**
   * Update a comment
   */
  async update(id: string, data: CommentUpdateInput): Promise<Comment | null> {
    // Create comment for validation
    const comment = new Comment();
    Object.assign(comment, { id, ...data });
    
    // Validate comment
    const errors = await validate(comment, { skipMissingProperties: true });
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }
    
    // Update the comment using TypeORM
    await this.neonService.update(Comment, { id } as FindOptionsWhere<Comment>, data as DeepPartial<Comment>);
    
    // Return the updated comment
    return await this.findById(id);
  }

  /**
   * Delete comment
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.neonService.delete(Comment, { id } as FindOptionsWhere<Comment>);
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

// Legacy compatibility layer (not used yet but included for consistency)
export const commentQueries = {
  findAll: async (client: Client): Promise<CommentInstance[]> => {
    const neonService = createServiceFromClient(client);
    const repo = new CommentRepository(neonService);
    return await repo.findAll();
  },

  findById: async (client: Client, id: string): Promise<CommentInstance | null> => {
    const neonService = createServiceFromClient(client);
    const repo = new CommentRepository(neonService);
    return await repo.findById(id);
  },

  findByTaskId: async (client: Client, taskId: string): Promise<CommentInstance[]> => {
    const neonService = createServiceFromClient(client);
    const repo = new CommentRepository(neonService);
    return await repo.findByTaskId(taskId);
  },

  findByProjectId: async (client: Client, projectId: string): Promise<CommentInstance[]> => {
    const neonService = createServiceFromClient(client);
    const repo = new CommentRepository(neonService);
    return await repo.findByProjectId(projectId);
  },

  findByAuthorId: async (client: Client, authorId: string): Promise<CommentInstance[]> => {
    const neonService = createServiceFromClient(client);
    const repo = new CommentRepository(neonService);
    return await repo.findByAuthorId(authorId);
  },

  create: async (client: Client, data: CommentCreateInput): Promise<CommentInstance> => {
    const neonService = createServiceFromClient(client);
    const repo = new CommentRepository(neonService);
    return await repo.create(data);
  },

  update: async (client: Client, id: string, data: CommentUpdateInput): Promise<CommentInstance | null> => {
    const neonService = createServiceFromClient(client);
    const repo = new CommentRepository(neonService);
    return await repo.update(id, data);
  },

  delete: async (client: Client, id: string): Promise<boolean> => {
    const neonService = createServiceFromClient(client);
    const repo = new CommentRepository(neonService);
    return await repo.delete(id);
  }
}; 