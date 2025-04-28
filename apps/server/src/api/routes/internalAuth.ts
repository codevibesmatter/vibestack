import { Hono } from 'hono';
import type { ApiEnv } from '../../types/api';
import { serverLogger as log } from '../../middleware/logger';
import { findOrCreateUserFromIdentity } from '../../auth/userService'; // Import the service function
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { HTTPException } from 'hono/http-exception';

// Define input schema for validation (can be shared or redefined here)
const IdentitySchema = z.object({
  provider: z.string().min(1),
  email: z.string().email().optional(),
  profile: z.any().optional(),
}).passthrough();

const internalAuth = new Hono<ApiEnv>();

// Define the POST route for find-or-create
internalAuth.post(
  '/find-or-create', 
  zValidator('json', IdentitySchema, (result, c) => { // Validate request body
    if (!result.success) {
      log.warn('Invalid identity payload received:', result.error.errors);
      return c.json({ message: 'Invalid identity payload', errors: result.error.flatten() }, 400);
    }
  }), 
  async (c) => {
    const validatedIdentity = c.req.valid('json');
    log.info('Handling validated /internal/auth/find-or-create request');
    log.debug('Validated identity:', validatedIdentity);

    try {
      const userId = await findOrCreateUserFromIdentity(validatedIdentity);
      log.info(`Successfully found/created user. Returning userId: ${userId}`);
      // Return both userId and workspaceId for OpenAuth subject schema
      return c.json({ 
        userId: userId,
        workspaceId: 'default' // Replace with actual workspace logic if you have it
      }, 200);
    } catch (error) {
      // Log the error from the service layer
      log.error('Error calling findOrCreateUserFromIdentity service:', error);
      // Re-throw HTTPExceptions, wrap others for consistent response
      if (error instanceof HTTPException) {
          // You might want to customize the response based on the error status from the service
          return c.json({ message: error.message }, error.status);
      } 
      return c.json({ message: 'Internal server error processing user identity.' }, 500);
    }
  }
);

export default internalAuth; 