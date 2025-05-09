import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  type ApiEnv,
  ServiceErrorType,
  createSuccessResponse,
  createErrorResponse,
} from '../types/api';
import { NeonService } from '../lib/neon-orm/neon-service';
import { User, UserRole } from "@repo/dataforge/server-entities";
import { UserRepository } from '../domains/users';

// Re-export enums for convenience
export { UserRole };

// Input types for API
export type UserCreateInput = Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt'>>;
export type UserUpdateInput = Partial<UserCreateInput>;

// Create users router
const users = new Hono<ApiEnv>();

// List users
users.get('/', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const neonService = new NeonService(c);
    const userRepo = new UserRepository(neonService);
    const { role } = c.req.query();
    
    let result: User[];
    if (role && Object.values(UserRole).includes(role as UserRole)) {
      // Use repository for role filtering
      result = await userRepo.findByRole(role as UserRole);
    } else {
      // Use repository for all users
      result = await userRepo.findAll();
    }
    
    return c.json(createSuccessResponse(result));
  } catch (err) {
    console.error('Error listing users:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Create user
users.post('/', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const body = await c.req.json();
    const neonService = new NeonService(c);
    const userRepo = new UserRepository(neonService);
    
    // The repository will handle validation and defaults
    const result = await userRepo.create(body);
    
    return c.json(createSuccessResponse(result), 201);
  } catch (err) {
    console.error('Error creating user:', err);
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

// Get user by ID
users.get('/:id', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const id = c.req.param('id');
    const neonService = new NeonService(c);
    const userRepo = new UserRepository(neonService);
    
    const user = await userRepo.findById(id);
    
    if (!user) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `User with id ${id} not found`
        ),
        404
      );
    }
    
    return c.json(createSuccessResponse(user));
  } catch (err) {
    console.error('Error getting user:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Update user
users.patch('/:id', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const neonService = new NeonService(c);
    const userRepo = new UserRepository(neonService);
    
    // Find the user first to ensure it exists
    const existingUser = await userRepo.findById(id);
    if (!existingUser) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `User with id ${id} not found`
        ),
        404
      );
    }
    
    // Update the user
    await userRepo.update(id, body);
    
    // Always fetch the updated user to return the most recent state
    const updatedUser = await userRepo.findById(id);
    if (!updatedUser) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `User with id ${id} not found after update`
        ),
        404
      );
    }
    
    return c.json(createSuccessResponse(updatedUser));
  } catch (err) {
    console.error('Error updating user:', err);
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

// Delete user
users.delete('/:id', async (c) => {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Unauthorized' });
  try {
    const id = c.req.param('id');
    const neonService = new NeonService(c);
    const userRepo = new UserRepository(neonService);
    
    // Find the user first to ensure it exists
    const existingUser = await userRepo.findById(id);
    if (!existingUser) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `User with id ${id} not found`
        ),
        404
      );
    }
    
    // Delete the user
    const deleted = await userRepo.delete(id);
    
    if (!deleted) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.INTERNAL,
          `User with id ${id} could not be deleted`
        ),
        500
      );
    }
    
    return c.json(createSuccessResponse({ id }));
  } catch (err) {
    console.error('Error deleting user:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

export { users }; 