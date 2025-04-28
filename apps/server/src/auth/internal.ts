import { Hono } from 'hono';
import type { AppBindings } from '../types/hono'; // Assuming types are defined here
import { serverLogger } from '../middleware/logger'; // Assuming logger is available
import { findOrCreateUserFromIdentity } from './userService';

// Define the expected input structure from OpenAuth
interface OpenAuthSuccessValue {
  provider: string;
  profile: {
    providerId: string;
    emails?: Array<{ value: string; primary?: boolean }>;
    // Other profile fields might exist
  };
  // Other fields like tokens might exist
}

// Define the expected output structure for OpenAuth
interface FindOrCreateResponse {
  userId: string;
  workspaceId: string; // Assuming a default workspace ID for now
}

const internalAuthApp = new Hono<AppBindings>();

internalAuthApp.post('/find-or-create', async (c) => {
  serverLogger.info('[Server:InternalAuth] Received /find-or-create request');
  
  try {
    const openAuthValue = await c.req.json();
    serverLogger.debug('[Server:InternalAuth] Request body:', openAuthValue);

    // Use the proper user service implementation
    const userId = await findOrCreateUserFromIdentity(openAuthValue);
    serverLogger.info(`[Server:InternalAuth] Successfully found/created user. Returning userId: ${userId}`);

    // Return both userId and workspaceId for OpenAuth subject schema
    return c.json({ 
      userId: userId,
      workspaceId: 'default' // Replace with actual workspace logic if you have it
    }, 200);

  } catch (error) {
    serverLogger.error('[Server:InternalAuth] Error processing find-or-create:', error);
    return c.json({ ok: false, error: 'Internal Server Error processing auth data' }, 500);
  }
});

export default internalAuthApp; 