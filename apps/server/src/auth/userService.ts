import { serverDataSource } from '@repo/dataforge';
import { User, UserIdentity } from '@repo/dataforge';
import { EntityManager } from 'typeorm';
import { serverLogger as log } from '../middleware/logger';
import { HTTPException } from 'hono/http-exception';

// Define the structure of the identity payload we expect from the auth worker
// This should match the schema used in the Hono route validator
interface IdentityPayload {
  provider: string;
  email?: string;
  profile?: any; // Consider defining a more specific profile type
  // Add other fields from OpenAuth `value` object if needed
  [key: string]: any; // Allow other properties
}

/**
 * Finds an existing user based on the identity provider details, 
 * links the identity if the user exists but the identity doesn't, 
 * or creates a new user and identity if neither exists.
 * 
 * @param identity - The identity payload from the OpenAuth worker.
 * @returns The internal application userId.
 * @throws HTTPException for invalid input or database errors.
 */
export async function findOrCreateUserFromIdentity(identity: IdentityPayload): Promise<string> {
  log.info(`[AuthService] Finding or creating user for provider: ${identity.provider}`);
  
  // 1. Extract provider, providerId, email, name, avatarUrl from identity
  //    (Similar logic as previously in the route handler)
  const provider = identity.provider;
  let providerId: string | undefined;
  let userEmail = identity.email;
  let userName = 'New User';
  let avatarUrl = undefined;

  if (provider === 'github' && identity.profile) {
      providerId = identity.profile.id?.toString(); 
      if (!userEmail && identity.profile.email) userEmail = identity.profile.email;
      if (identity.profile.name) userName = identity.profile.name;
      if (identity.profile.avatar_url) avatarUrl = identity.profile.avatar_url;
  } else if (provider === 'password' && identity.email) {
      providerId = identity.email;
      userEmail = identity.email; // Ensure userEmail is set for password provider
      userName = userEmail?.split('@')[0] ?? userName;
  }
  // TODO: Add logic for other providers

  if (!providerId) {
    log.warn('[AuthService] Could not determine providerId from identity:', identity);
    throw new HTTPException(400, { message: 'Invalid identity payload: Missing provider identifier' });
  }

  try {
    // Get repositories (outside transaction for initial reads)
    const userIdentityRepo = serverDataSource.getRepository(UserIdentity);
    const userRepo = serverDataSource.getRepository(User);

    // 2. Query UserIdentity by provider and providerId
    log.debug(`[AuthService] Searching UserIdentity for provider=${provider}, providerId=${providerId}`);
    const existingIdentity = await userIdentityRepo.findOneBy({ provider, providerId });

    if (existingIdentity) {
      // 3. If UserIdentity found, return existing userId
      log.info(`[AuthService] Found existing UserIdentity, userId: ${existingIdentity.userId}`);
      return existingIdentity.userId;
    }

    // 4. If UserIdentity not found, check for existing User by email (if available)
    let existingUser: User | null = null;
    if (userEmail) {
      log.debug(`[AuthService] UserIdentity not found. Searching User by email: ${userEmail}`);
      existingUser = await userRepo.findOneBy({ email: userEmail });
    }

    // 5. Use a transaction for create/link operations
    let userId: string;
    await serverDataSource.transaction(async (transactionalEntityManager: EntityManager) => {
        const transUserRepo = transactionalEntityManager.getRepository(User);
        const transUserIdentityRepo = transactionalEntityManager.getRepository(UserIdentity);

        if (existingUser) {
            // 5a. Link new UserIdentity to existing User
            log.info(`[AuthService] Found existing User by email (ID: ${existingUser.id}). Linking new UserIdentity.`);
            userId = existingUser.id;
            const newUserIdentity = transUserIdentityRepo.create({
                userId: existingUser.id,
                provider: provider,
                providerId: providerId,
            });
            await transUserIdentityRepo.save(newUserIdentity);
            log.debug(`[AuthService] Created new UserIdentity for existing user.`);
        } else {
            // 5b. Create *both* User and UserIdentity
            log.info(`[AuthService] No existing User found. Creating new User and UserIdentity.`);
            if (!userEmail) {
                log.error('[AuthService] Cannot create new user without an email address.', identity);
                throw new HTTPException(400, { message: 'Email is required to create a new user account.'});
            }
            
            const newUser = transUserRepo.create({
                email: userEmail,
                name: userName,
                avatarUrl: avatarUrl,
            });
            const savedUser = await transUserRepo.save(newUser);
            userId = savedUser.id;
            log.debug(`[AuthService] Created new User with ID: ${userId}`);

            const newUserIdentity = transUserIdentityRepo.create({
                userId: userId,
                provider: provider,
                providerId: providerId,
            });
            await transUserIdentityRepo.save(newUserIdentity);
            log.debug(`[AuthService] Created new UserIdentity linked to new user.`);
        }
    });

    // 6. Return the determined userId
    log.info(`[AuthService] Successfully processed find-or-create. Returning userId: ${userId!}`);
    return userId!;

  } catch (error) {
      // Log database errors or unexpected issues
      log.error('[AuthService] Error during find-or-create process:', error);
      // Re-throw HTTPExceptions, wrap others
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(500, { message: 'Internal server error during user processing.', cause: error });
  }
} 