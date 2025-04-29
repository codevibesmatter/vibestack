import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { createClient } from '@openauthjs/openauth/client';
// Adjust relative path to correctly locate subjects.ts in apps/openauth
import { subjects } from '../../../../openauth/src/subjects'; // Import subjects for verification
import type { ApiEnv } from '../../types/api'; // Assuming this type exists for env access
import { serverLogger as log } from '../../middleware/logger';
import type { AppBindings } from '../../types/hono';
import { User } from '@repo/dataforge/generated/server-entities'; // Corrected path
import { getDataSource } from '../../lib/data-source'; // Import the helper

// Configuration (Consider moving to environment variables or bindings)
const OPENAUTH_ISSUER_URL = 'http://localhost:8788'; // URL of your apps/openauth worker
const CLIENT_ID = 'vibestack-web'; // MUST match client ID used by frontend
const REDIRECT_URI = 'http://localhost:8787/api/auth/callback'; // This server's callback URI
const FRONTEND_REDIRECT_URL = 'http://localhost:5173'; // Your apps/web URL (Assuming default Vite port)
const COOKIE_SECRET = 'your-very-secret-key-for-cookies'; // CHANGE THIS & move to env

// Create OpenAuth client instance for the server
const authClient = createClient({
  issuer: OPENAUTH_ISSUER_URL,
  clientID: CLIENT_ID,
  // clientSecret: 'YOUR_CLIENT_SECRET' // Add if configured in OpenAuth
});

// Create a more resilient fetch function for manual direct calls to OpenAuth
const fetchWithRetry = async (url: string, options: RequestInit): Promise<Response> => {
  const maxRetries = 3;
  const timeout = 5000; // 5 seconds
  
  // Utility function for timeout control
  const fetchWithTimeout = async (fetchUrl: string, fetchOptions: RequestInit, timeoutMs: number) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(fetchUrl, {
        ...fetchOptions,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  };
  
  // Implement retry logic
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      log.info(`[AuthClient] Fetch attempt ${attempt + 1}/${maxRetries} to ${url}`);
      const response = await fetchWithTimeout(url, options, timeout);
      if (response.ok) {
        log.info(`[AuthClient] Fetch successful on attempt ${attempt + 1}`);
        return response;
      }
      
      // Log non-success responses
      const responseText = await response.text();
      log.warn(`[AuthClient] Fetch attempt ${attempt + 1} failed with status ${response.status}: ${responseText}`);
      lastError = new Error(`HTTP ${response.status}: ${responseText}`);
      
      // Wait before retrying (exponential backoff)
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 100; // 100ms, 200ms, 400ms, etc.
        log.info(`[AuthClient] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error: any) {
      log.warn(`[AuthClient] Fetch attempt ${attempt + 1} threw an error:`, error);
      lastError = error;
      
      // If we're not at the last attempt yet, retry after a delay
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 100;
        log.info(`[AuthClient] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // If we get here, all retries failed
  throw new Error(`All ${maxRetries} fetch attempts failed: ${lastError?.message || 'Unknown error'}`);
};

const authRoutes = new Hono<AppBindings>();

// Placeholder for login initiation or status check if needed
authRoutes.get('/', (c) => {
  return c.text('Auth base route - use specific endpoints like /callback');
});

// --- Callback handler for OpenAuth redirects ---
authRoutes.get('/callback', async (c) => {
  log.info('>>> [Server:Auth] ENTERED /api/auth/callback HANDLER <<<');
  const code = c.req.query('code');
  const error = c.req.query('error');
  const state = c.req.query('state'); // Optional state parameter

  if (error) {
    log.error(`OpenAuth callback error: ${error}`);
    // TODO: Redirect user to a frontend error page with error info
    // return c.redirect(`${FRONTEND_REDIRECT_URL}/auth-error?error=${encodeURIComponent(error)}`, 302);
    return c.text(`Authentication failed: ${error}`, 400);
  }

  if (!code) {
     log.error('OpenAuth callback missing code parameter.');
     // TODO: Redirect user to a frontend error page
     // return c.redirect(`${FRONTEND_REDIRECT_URL}/auth-error?error=missing_code`, 302);
     return c.text('Authentication callback missing code', 400);
  }

  log.info(`Received authorization code. Exchanging for tokens...`);

  try {
    // Exchange the code for tokens using the OpenAuth client
    const exchanged = await authClient.exchange(code, REDIRECT_URI);

    if (exchanged.err) {
        log.error('Token exchange failed:', exchanged.err);
        // TODO: Redirect user to frontend error page
        return c.text(`Token exchange failed: ${exchanged.err.message || 'Unknown error'}`, 500);
    }

    if (!exchanged.tokens?.access || !exchanged.tokens?.refresh) {
        log.error('Token exchange response missing tokens.', exchanged.tokens);
        // TODO: Redirect user to frontend error page
        return c.text('Token exchange failed: Invalid response from auth server', 500);
    }

    log.info('Token exchange successful. Setting cookies...');

    const cookieOptions = {
      httpOnly: true,
      secure: c.env.ENVIRONMENT === 'production', // Use env var or similar check
      sameSite: 'Lax' as const, // Lax is generally recommended
      path: '/',
      // maxAge: 34560000, // Optional: Set max age in seconds (e.g., from exchanged.tokens.expires_in)
      // secret: COOKIE_SECRET, // Enable if using signed cookies
    };

    // Set tokens in HttpOnly cookies
    setCookie(c, 'access_token', exchanged.tokens.access, cookieOptions);
    setCookie(c, 'refresh_token', exchanged.tokens.refresh, cookieOptions);

    log.info('Cookies set. Redirecting to frontend...');

    // Redirect the user's browser to the frontend application
    return c.redirect(FRONTEND_REDIRECT_URL, 302);

  } catch (exchangeError: any) {
    log.error('Exception during token exchange process:', exchangeError);
    // TODO: Redirect user to frontend error page
    return c.text(`An unexpected error occurred during login: ${exchangeError.message || 'Please check console'}`, 500);
  }
});

// --- Get Current User (/api/me) Endpoint ---
authRoutes.get('/me', async (c) => {
  log.info('>>> [Server:Auth] ENTERED /api/me HANDLER <<<');

  // 1. Get the access token from the cookie
  const accessToken = getCookie(c, 'access_token');
  // const refreshToken = getCookie(c, 'refresh_token'); // Get refresh token if needed for auto-refresh later

  if (!accessToken) {
    log.warn('/api/me: No access token cookie found.');
    return c.json({ error: 'Unauthorized', message: 'Missing access token' }, 401);
  }

  log.info('/api/me: Found access token. Verifying...');

  try {
    // Enhanced logging for debugging
    log.info(`/api/me: Using OpenAuth issuer URL: ${OPENAUTH_ISSUER_URL}`);
    log.info(`/api/me: Using client ID: ${CLIENT_ID}`);
    
    // Attempt to directly call OpenAuth's well-known endpoint to check connectivity
    try {
      log.info('/api/me: Testing direct connectivity to OpenAuth server...');
      const wellKnownUrl = `${OPENAUTH_ISSUER_URL}/.well-known/oauth-authorization-server`;
      log.info(`/api/me: Fetching from: ${wellKnownUrl}`);
      
      // Use the more resilient fetch function
      const response = await fetchWithRetry(wellKnownUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });
      
      const data = await response.json();
      log.info('/api/me: OpenAuth well-known endpoint is reachable!', data);
    } catch (wellKnownError) {
      log.error('/api/me: Failed to connect to OpenAuth well-known endpoint:', wellKnownError);
    }
    
    // 2. Verify the access token using the OpenAuth client with more logging
    log.info('/api/me: Now attempting to verify token via OpenAuth client...');
    // TODO: Implement token refresh logic using refresh_token if needed
    const verified = await authClient.verify(subjects, accessToken, {
      // Pass our custom fetch function to handle potential timeouts/retries
      fetch: fetchWithRetry,
      // refresh: refreshToken // Keep refresh token logic if needed later
    });

    if (verified.err) {
      log.warn('/api/me: Token verification failed.', verified.err);
       // TODO: Clear invalid cookies?
      // clearCookie(c, 'access_token', { path: '/' });
      // clearCookie(c, 'refresh_token', { path: '/' });
      return c.json({ error: 'Unauthorized', message: 'Invalid or expired token' }, 401);
    }

    // If verification includes refreshed tokens, set them (optional)
    // if (verified.tokens) {
    //    log.info('/api/me: Token refreshed during verification. Updating cookies...');
    //    setCookie(c, 'access_token', verified.tokens.access, cookieOptions);
    //    setCookie(c, 'refresh_token', verified.tokens.refresh, cookieOptions);
    // }

    log.info('/api/me: Token verified successfully. Subject:', verified.subject);

    // 3. Extract userId (which is actually email in this context) from verified token
    let userEmail = verified.subject?.properties?.userId;
    if (!userEmail) {
        log.error('/api/me: Could not extract user email (from userId property) from verified token subject.', verified.subject);
        return c.json({ error: 'Server Error', message: 'Failed to identify user from token' }, 500);
    }

    // Remove the "user-" prefix if it exists
    const prefix = 'user-';
    if (userEmail.startsWith(prefix)) {
      userEmail = userEmail.substring(prefix.length);
      log.info(`/api/me: Removed prefix, using email: ${userEmail}`);
    }

    // 4. Fetch user details using the correct pattern (by email)
    log.info(`/api/me: Fetching user details for email: ${userEmail}`);
    const dataSource = await getDataSource(c); // Use the helper
    if (!dataSource || !dataSource.isInitialized) { 
        log.error('/api/me: Failed to get initialized DataSource.');
        return c.json({ error: 'Server Configuration Error', message: 'DB not configured.'}, 500);
    }
    const userRepo = dataSource.getRepository(User);
    // Find user by email instead of ID
    const user = await userRepo.findOne({ where: { email: userEmail } });

    if (!user) {
        log.error(`/api/me: User not found in DB for email: ${userEmail}`);
        return c.json({ error: 'Unauthorized', message: 'User associated with token not found' }, 401);
    }

    log.info('/api/me: Returning user data.');
    return c.json(user);

  } catch (verifyError: any) {
    log.error('Exception during /api/me token verification process:', verifyError);
    // Add more detailed error logging
    if (verifyError.cause) {
      log.error('Caused by:', verifyError.cause);
    }
    if (verifyError.stack) {
      log.error('Stack trace:', verifyError.stack);
    }
    
    return c.json({ 
      error: 'Server Error', 
      message: 'An unexpected error occurred verifying authentication',
      details: verifyError.message || 'Unknown error'
    }, 500);
  }
});

// --- Logout Endpoint --- 
authRoutes.post('/logout', (c) => {
  log.info('>>> [Server:Auth] ENTERED /api/auth/logout HANDLER <<<');

  // Clear the authentication cookies
  deleteCookie(c, 'access_token', { path: '/' });
  deleteCookie(c, 'refresh_token', { path: '/' });

  log.info('/api/auth/logout: Cleared auth cookies.');
  return c.json({ message: 'Logged out successfully' });
});

// Add other auth-related routes here later (e.g., /logout)

export default authRoutes; 