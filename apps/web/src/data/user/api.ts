import { User } from '@repo/typeorm/client-entities';
import { validateEntityOrThrow } from '@repo/typeorm';
import { changesLogger } from '../../utils/logger';
import { getDatabase } from '../../db/core';
import { dbMessageBus } from '../../db/message-bus';
import { config } from '../../config';
import { workerManager } from '../../sync/worker-manager';
import { getLSNManager } from '../../sync/lsn-manager';

/**
 * User API Module
 * 
 * This module provides functions for interacting with User entities.
 * It handles database operations and validation.
 * The UI updates are handled by the store directly with optimistic updates.
 */

// API endpoints
const API_ENDPOINTS = {
  base: `${config.apiUrl}/api/users`
};

// Track user IDs that are currently being updated to prevent duplicate operations
const userUpdateLocks = new Set<string>();

// Initialize LSN manager
const lsnManager = getLSNManager();
lsnManager.initialize().catch(err => {
  changesLogger.logServiceError('Failed to initialize LSN manager', err);
});

/**
 * Get a user by ID
 * @param userId The user ID
 * @returns Promise that resolves to the user or null if not found
 */
export async function getUserById(userId: string): Promise<User | null> {
  const startTime = Date.now();
  
  changesLogger.logServiceEvent(`Getting user by ID: ${userId}`);
  
  try {
    const db = await getDatabase();
    const result = await db.query(`
      SELECT * FROM "users" WHERE id = $1
    `, [userId]);
    
    const duration = Date.now() - startTime;
    changesLogger.logServiceEvent(`User retrieval completed: ${userId} (${duration}ms, found: ${result.rows.length > 0})`);
    
    return result.rows[0] as User || null;
  } catch (error) {
    changesLogger.logServiceError(`Failed to get user: ${userId}`, error);
    throw error;
  }
}

/**
 * Get all users
 * @returns Promise that resolves to an array of users
 */
export async function getAllUsers(): Promise<User[]> {
  const startTime = Date.now();
  
  changesLogger.logServiceEvent('Getting all users');
  
  try {
    const db = await getDatabase();
    const result = await db.query(`
      SELECT * FROM "users" ORDER BY name
    `);
    
    const duration = Date.now() - startTime;
    changesLogger.logServiceEvent(`Users retrieval completed: ${result.rows.length} users (${duration}ms)`);
    
    return result.rows as User[];
  } catch (error) {
    changesLogger.logServiceError('Failed to get all users', error);
    throw error;
  }
}

/**
 * Create a new user
 * @param userData The user data
 * @returns Promise that resolves to the created user
 */
export async function createUser(userData: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
  changesLogger.logServiceEvent('Creating new user');
  
  const db = await getDatabase();
  let newUser: User;
  
  try {
    // Ensure LSN manager is initialized
    await lsnManager.initialize();
    
    // Get the client ID
    const clientId = await lsnManager.getClientId();
    if (!clientId) {
      throw new Error('No client ID available - sync service may not be initialized');
    }
    
    // Start transaction
    await db.query(`BEGIN`);
    
    // Insert the user
    const result = await db.query<User>(
      `INSERT INTO "users" (
        name, email, "avatar_url"
      ) VALUES (
        $1, $2, $3
      ) RETURNING *`,
      [
        userData.name,
        userData.email,
        userData.avatarUrl || null
      ]
    );
    
    newUser = result.rows[0];
    
    // Commit transaction
    await db.query(`COMMIT`);
    
    // Send change to sync worker with correct client ID
    workerManager.sendMessage('client_change', {
      type: 'client_change',
      clientId,
      change: {
        table: 'user',
        operation: 'insert',
        data: {
          ...newUser,
          client_id: clientId
        },
        old_data: null
      },
      metadata: {
        timestamp: Date.now()
      }
    });
    
    // Also publish change event for legacy subscribers
    dbMessageBus.publish('change_recorded', {
      entity_type: 'user',
      entity_id: newUser.id,
      operation: 'insert',
      data: newUser,
      old_data: null,
      timestamp: Date.now()
    });
    
    changesLogger.logServiceEvent(`User created successfully: ${newUser.id}`);
    return newUser;
    
  } catch (error) {
    // Rollback on error
    await db.query(`ROLLBACK`);
    changesLogger.logServiceError('Failed to create user', error);
    throw error;
  }
}

/**
 * Update a user
 * @param userId The user ID
 * @param userData The user data to update
 * @returns Promise that resolves to the updated user
 */
export async function updateUser(userId: string, updates: Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt'>>): Promise<User> {
  changesLogger.logServiceEvent(`Updating user: ${userId}`);
  
  const db = await getDatabase();
  let updatedUser: User;
  let oldUser: User;
  
  try {
    // Ensure LSN manager is initialized
    await lsnManager.initialize();
    
    // Get the client ID
    const clientId = await lsnManager.getClientId();
    if (!clientId) {
      throw new Error('No client ID available - sync service may not be initialized');
    }
    
    // Start transaction
    await db.query(`BEGIN`);
    
    // Get current user data
    const currentUser = await db.query<User>(
      `SELECT * FROM "user" WHERE id = $1`,
      [userId]
    );
    
    if (currentUser.rows.length === 0) {
      throw new Error(`User not found: ${userId}`);
    }
    
    oldUser = currentUser.rows[0];
    
    // Update the user
    const result = await db.query<User>(
      `UPDATE "users" SET
        name = COALESCE($1, name),
        email = COALESCE($2, email),
        "avatar_url" = COALESCE($3, "avatar_url"),
        "updatedAt" = NOW()
      WHERE id = $4
      RETURNING *`,
      [
        updates.name,
        updates.email,
        updates.avatarUrl,
        userId
      ]
    );
    
    updatedUser = result.rows[0];
    
    // Commit transaction
    await db.query(`COMMIT`);
    
    // Send change to sync worker with correct client ID
    workerManager.sendMessage('client_change', {
      type: 'client_change',
      clientId,
      change: {
        table: 'user',
        operation: 'update',
        data: {
          ...updatedUser,
          client_id: clientId
        },
        old_data: oldUser
      },
      metadata: {
        timestamp: Date.now()
      }
    });
    
    // Also publish change event for legacy subscribers
    dbMessageBus.publish('change_recorded', {
      entity_type: 'user',
      entity_id: userId,
      operation: 'update',
      data: updatedUser,
      old_data: oldUser,
      timestamp: Date.now()
    });
    
    changesLogger.logServiceEvent(`User updated successfully: ${userId}`);
    return updatedUser;
    
  } catch (error) {
    // Rollback on error
    await db.query(`ROLLBACK`);
    changesLogger.logServiceError('Failed to update user', error);
    throw error;
  }
}

/**
 * Delete a user
 * @param userId The user ID
 * @param fromServer Whether this operation is triggered from server sync
 * @returns Promise that resolves to the deleted user
 */
export async function deleteUser(userId: string, fromServer: boolean = false): Promise<User> {
  changesLogger.logServiceEvent(`deleteUser called for ${userId}${fromServer ? ' (from server)' : ''}`);
  
  // Check if this user is already being updated
  if (userUpdateLocks.has(userId)) {
    changesLogger.logServiceEvent(`Update for user ${userId} is already in progress, skipping delete operation`);
    throw new Error(`Update for user ${userId} is already in progress`);
  }
  
  // Add user ID to locks
  userUpdateLocks.add(userId);
  
  try {
    // Ensure LSN manager is initialized
    await lsnManager.initialize();
    
    // Get the client ID
    const clientId = await lsnManager.getClientId();
    if (!clientId) {
      throw new Error('No client ID available - sync service may not be initialized');
    }
    
    // Get database connection
    const db = await getDatabase();
    
    // Start transaction
    await db.query(`BEGIN`);
    
    try {
      // Get the user before deleting it
      const getUserResult = await db.query(`
        SELECT * FROM "users" WHERE id = $1
      `, [userId]);
      
      if (getUserResult.rows.length === 0) {
        throw new Error(`User with ID ${userId} not found`);
      }
      
      const userToDelete = getUserResult.rows[0] as User;
      
      // Delete the user
      const deleteResult = await db.query(`
        DELETE FROM "user" WHERE id = $1 RETURNING *
      `, [userId]);
      
      if (deleteResult.rows.length === 0) {
        throw new Error(`Failed to delete user ${userId}`);
      }
      
      changesLogger.logServiceEvent(`User deleted successfully: ${userId}`);

      // Send change to sync worker with correct client ID
      workerManager.sendMessage('client_change', {
        type: 'client_change',
        clientId,
        change: {
          table: 'user',
          operation: 'delete',
          data: null,
          old_data: userToDelete
        },
        metadata: {
          timestamp: Date.now()
        }
      });

      // Also publish change event for legacy subscribers
      dbMessageBus.publish('change_recorded', {
        entity_type: 'user',
        entity_id: userId,
        operation: 'delete',
        data: null,
        old_data: userToDelete,
        timestamp: Date.now()
      });
      
      // Commit transaction
      await db.query(`COMMIT`);
      
      return userToDelete;
    } catch (error) {
      // Rollback transaction on error
      await db.query(`ROLLBACK`);
      changesLogger.logServiceError(`Error in transaction for user ${userId}`, error);
      throw error;
    }
  } catch (error) {
    changesLogger.logServiceError(`Error deleting user ${userId}`, error);
    throw error;
  } finally {
    // Remove user ID from locks regardless of success or failure
    userUpdateLocks.delete(userId);
    changesLogger.logServiceEvent(`Released update lock for user ${userId}`);
  }
}

/**
 * Upsert a user (create if it doesn't exist, update if it does)
 * @param userId The user ID
 * @param userData The user data
 * @param fromServer Whether this operation is triggered from server sync
 * @returns Promise that resolves to the upserted user
 */
export async function upsertUser(userId: string, userData: Partial<User>, fromServer: boolean = false): Promise<User> {
  changesLogger.logServiceEvent(`upsertUser called for ${userId}${fromServer ? ' (from server)' : ''}`);
  
  // Check if this user is already being updated
  if (userUpdateLocks.has(userId)) {
    changesLogger.logServiceEvent(`Update for user ${userId} is already in progress, skipping duplicate update`);
    throw new Error(`Update for user ${userId} is already in progress`);
  }
  
  // Add user ID to locks
  userUpdateLocks.add(userId);
  
  try {
    // Validate user data
    await validateEntityOrThrow(userData, User);
    
    // Get database connection
    const db = await getDatabase();
    
    // Start transaction
    await db.query(`BEGIN`);
    
    try {
      // Check if user exists
      const checkResult = await db.query(`
        SELECT * FROM "users" WHERE id = $1
      `, [userId]);
      
      const userExists = checkResult.rows.length > 0;
      const existingUser = userExists ? checkResult.rows[0] as User : null;
      
      let result;
      
      if (userExists) {
        // User exists, update it
        changesLogger.logServiceEvent(`User exists, updating: ${userId}`);
        
        // Set the updatedAt timestamp
        const updatedAt = new Date();
        
        // Build the update query dynamically based on provided fields
        const updateFields = [];
        const queryParams = [];
        let paramIndex = 1;
        
        if (userData.name !== undefined) {
          updateFields.push(`name = $${paramIndex}`);
          queryParams.push(userData.name);
          paramIndex++;
        }
        
        if (userData.email !== undefined) {
          updateFields.push(`email = $${paramIndex}`);
          queryParams.push(userData.email);
          paramIndex++;
        }
        
        if (userData.avatarUrl !== undefined) {
          updateFields.push(`"avatar_url" = $${paramIndex}`);
          queryParams.push(userData.avatarUrl);
          paramIndex++;
        }
        
        // Always update the updatedAt timestamp
        updateFields.push(`"updatedAt" = $${paramIndex}`);
        queryParams.push(updatedAt);
        paramIndex++;
        
        // Add the userId as the last parameter
        queryParams.push(userId);
        
        // Execute the update query
        const updateQuery = `
          UPDATE "user"
          SET ${updateFields.join(', ')}
          WHERE id = $${paramIndex}
          RETURNING *
        `;
        
        changesLogger.logServiceEvent(`Executing update query: ${updateQuery}`);
        changesLogger.logServiceEvent(`Query parameters: ${JSON.stringify(queryParams)}`);
        
        result = await db.query(updateQuery, queryParams);
        
        if (result.rows.length === 0) {
          throw new Error(`Failed to update user ${userId}`);
        }
      } else {
        // User doesn't exist, create it
        changesLogger.logServiceEvent(`User doesn't exist, creating: ${userId}`);
        
        // Set timestamps
        const now = new Date();
        
        // Execute the insert query
        result = await db.query(`
          INSERT INTO "user" (
            id, name, email, "avatar_url", "createdAt", "updatedAt"
          ) VALUES (
            $1, $2, $3, $4, $5, $6
          )
          RETURNING *
        `, [
          userId,
          userData.name || 'New User',
          userData.email || `${userId}@example.com`,
          userData.avatarUrl || null,
          now,
          now
        ]);
        
        if (result.rows.length === 0) {
          throw new Error('Failed to create user');
        }
      }
      
      const upsertedUser = result.rows[0] as User;
      changesLogger.logServiceEvent(`User ${userExists ? 'updated' : 'created'} successfully: ${userId}`);

      // Record change through worker
      dbMessageBus.publish('change_recorded', {
        entity_type: 'user',
        entity_id: userId,
        operation: userExists ? 'update' : 'insert',
        data: upsertedUser,
        old_data: existingUser,
        timestamp: Date.now(),
        from_server: fromServer
      });
      
      // Commit transaction
      await db.query(`COMMIT`);
      
      return upsertedUser;
    } catch (error) {
      // Rollback transaction on error
      await db.query(`ROLLBACK`);
      changesLogger.logServiceError(`Error in transaction for user ${userId}`, error);
      throw error;
    }
  } catch (error) {
    changesLogger.logServiceError(`Error upserting user ${userId}`, error);
    throw error;
  } finally {
    // Remove user ID from locks regardless of success or failure
    userUpdateLocks.delete(userId);
    changesLogger.logServiceEvent(`Released update lock for user ${userId}`);
  }
}

/**
 * List all users
 */
export async function listUsers(): Promise<User[]> {
  changesLogger.logServiceEvent('Listing all users');
  
  try {
    const db = await getDatabase();
    const result = await db.query<User>(
      'SELECT * FROM "user" ORDER BY "createdAt" DESC'
    );
    
    changesLogger.logServiceEvent(`Listed ${result.rows.length} users`);
    return result.rows;
    
  } catch (error) {
    changesLogger.logServiceError('Failed to list users', error);
    throw error;
  }
} 