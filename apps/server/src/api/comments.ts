import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception'; // Import HTTPException
import {
  type ApiEnv,
  ServiceErrorType,
  createSuccessResponse,
  createErrorResponse
} from '../types/api';
import { NeonService } from '../lib/neon-orm/neon-service';
import { Comment } from "@repo/dataforge/server-entities";
import { CommentRepository } from '../domains/comments';

// Input types for API
export type CommentCreateInput = Partial<Omit<Comment, 'id' | 'createdAt' | 'updatedAt'>>;
export type CommentUpdateInput = Partial<CommentCreateInput>;

// Create comments router
const comments = new Hono<ApiEnv>();

// List comments
comments.get('/', async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  try {
    const neonService = new NeonService(c);
    const commentRepo = new CommentRepository(neonService);
    const { taskId, projectId, authorId } = c.req.query();
    
    let result: Comment[];
    
    // Use filters if provided
    if (taskId || projectId || authorId) {
      result = await commentRepo.findWithFilters({
        taskId: taskId as string,
        projectId: projectId as string,
        authorId: authorId as string
      });
    } else {
      // No filters, return all comments
      result = await commentRepo.findAll();
    }
    
    return c.json(createSuccessResponse(result));
  } catch (err) {
    console.error('Error listing comments:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Create comment
comments.post('/', async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  try {
    const body = await c.req.json();
    const neonService = new NeonService(c);
    const commentRepo = new CommentRepository(neonService);
    
    // The repository will handle validation
    const result = await commentRepo.create(body);
    
    return c.json(createSuccessResponse(result), 201);
  } catch (err) {
    console.error('Error creating comment:', err);
    if (err instanceof Error && err.message.includes('validation')) {
      return c.json(
        createErrorResponse(ServiceErrorType.VALIDATION, err.message),
        400
      );
    }
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Get comment by ID
comments.get('/:id', async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  try {
    const id = c.req.param('id');
    const neonService = new NeonService(c);
    const commentRepo = new CommentRepository(neonService);
    
    const comment = await commentRepo.findById(id);
    
    if (!comment) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Comment with id ${id} not found`
        ),
        404
      );
    }
    
    return c.json(createSuccessResponse(comment));
  } catch (err) {
    console.error('Error getting comment:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Update comment
comments.patch('/:id', async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const neonService = new NeonService(c);
    const commentRepo = new CommentRepository(neonService);
    
    // Find the comment first to ensure it exists
    const existingComment = await commentRepo.findById(id);
    if (!existingComment) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Comment with id ${id} not found`
        ),
        404
      );
    }
    
    // Update the comment
    await commentRepo.update(id, body);
    
    // Always fetch the updated comment to return the most recent state
    const updatedComment = await commentRepo.findById(id);
    if (!updatedComment) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Comment with id ${id} not found after update`
        ),
        404
      );
    }
    
    return c.json(createSuccessResponse(updatedComment));
  } catch (err) {
    console.error('Error updating comment:', err);
    if (err instanceof Error && err.message.includes('validation')) {
      return c.json(
        createErrorResponse(ServiceErrorType.VALIDATION, err.message),
        400
      );
    }
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Delete comment
comments.delete('/:id', async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  try {
    const id = c.req.param('id');
    const neonService = new NeonService(c);
    const commentRepo = new CommentRepository(neonService);
    
    // Find the comment first to ensure it exists
    const existingComment = await commentRepo.findById(id);
    if (!existingComment) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Comment with id ${id} not found`
        ),
        404
      );
    }
    
    // Delete the comment
    const deleted = await commentRepo.delete(id);
    
    if (!deleted) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.INTERNAL,
          `Comment with id ${id} could not be deleted`
        ),
        500
      );
    }
    
    return c.json(createSuccessResponse({ id }));
  } catch (err) {
    console.error('Error deleting comment:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

export { comments }; 