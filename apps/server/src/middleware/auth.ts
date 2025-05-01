import { createMiddleware } from 'hono/factory';
import { getAuth, AuthType } from '../lib/auth'; // Assuming getAuth is the way to get runtime auth instance
import type { AppBindings } from '../types/hono'; // Import your AppBindings if they define Variables

// Define the middleware using createMiddleware for better typing
export const authMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const auth = getAuth(c); // Get the configured auth instance for this request

  // Try to get the session using headers from the raw request
  // Note: Ensure your getAuth provides an instance with the 'api' property
  if (auth.api && typeof auth.api.getSession === 'function') {
    const sessionData = await auth.api.getSession({ headers: c.req.raw.headers });

    if (sessionData) {
      // Session found, set user and session in context
      c.set('user', sessionData.user);
      c.set('session', sessionData.session);
    } else {
      // No session found, explicitly set to null
      c.set('user', null);
      c.set('session', null);
    }
  } else {
    // Handle case where getSession is not available (e.g., configuration issue)
    console.error("[Auth Middleware] Could not find auth.api.getSession. Ensure getAuth provides the necessary methods.");
    c.set('user', null);
    c.set('session', null);
  }

  // Proceed to the next middleware or route handler
  await next();
}); 