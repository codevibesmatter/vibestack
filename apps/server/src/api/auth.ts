import { Hono } from "hono";
import { getAuth, AuthType } from "../lib/auth";

const authRouter = new Hono<AuthType>();

// Add a diagnostic /me endpoint for development and debugging
authRouter.get('/me', async (c) => {
  try {
    // Get the auth instance
    const auth = getAuth(c);
    
    // Attempt to get session data from the request
    const sessionData = await auth.api.getSession({ headers: c.req.raw.headers });
    
    // Basic diagnostics data
    const diagnosticInfo = {
      timestamp: new Date().toISOString(),
      requestInfo: {
        path: c.req.path,
        method: c.req.method,
        headers: Object.fromEntries(c.req.raw.headers.entries()),
        origin: c.req.header('Origin') || 'Not provided',
        cookies: c.req.header('Cookie') || 'No cookies'
      },
      auth: {
        sessionExists: !!sessionData,
        sessionInfo: sessionData ? {
          userId: sessionData.user?.id,
          email: sessionData.user?.email,
          expiresAt: sessionData.session?.expiresAt,
          createdAt: sessionData.session?.createdAt,
          id: sessionData.session?.id,
        } : null,
        // Only include user info if session exists
        userInfo: sessionData?.user ? {
          id: sessionData.user.id,
          email: sessionData.user.email,
          name: sessionData.user.name,
          emailVerified: sessionData.user.emailVerified,
          createdAt: sessionData.user.createdAt,
          updatedAt: sessionData.user.updatedAt,
        } : null
      },
      environment: {
        nodeEnv: process.env.NODE_ENV || 'development',
        isSecure: c.req.url.startsWith('https')
      }
    };
    
    // Log diagnostic information
    console.log('[Auth] Diagnostic info for /me endpoint:', JSON.stringify(diagnosticInfo, null, 2));
    
    // If no session, return 401 Unauthorized
    if (!sessionData) {
      return c.json({
        authenticated: false,
        message: "No authenticated session found",
        diagnostics: diagnosticInfo
      }, 401);
    }
    
    // Return successful response with user and session info
    return c.json({
      authenticated: true,
      user: diagnosticInfo.auth.userInfo,
      session: diagnosticInfo.auth.sessionInfo,
      diagnostics: diagnosticInfo
    });
    
  } catch (error) {
    console.error('[Auth] Error in /me endpoint:', error);
    return c.json({
      authenticated: false,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// Helper to enhance response with proper CORS headers
const enhanceResponseWithCORS = (response: Response, origin: string | null | undefined): Response => {
  const newResponse = new Response(response.body, response);
  
  // Always set the Vary header to ensure proper caching behavior with CORS
  newResponse.headers.set('Vary', 'Origin');
  
  // Define allowed origins
  const allowedOrigins = [
    // Ensure localhost:5173 is explicitly included 
    'http://localhost:5173',
    // Development origins
    'https://127.0.0.1:5173', 
    'http://127.0.0.1:5173',
    'https://localhost:5173',
    // Common Vite development server ports
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://127.0.0.1:4173',
    'http://localhost:4173',
    // Common development IPs with various ports
    'http://127.0.0.1:8080',
    'http://localhost:8080',
    // Allow local access on the network
    /^https?:\/\/192\.168\.\d+\.\d+:\d+$/,
    /^https?:\/\/10\.\d+\.\d+\.\d+:\d+$/,
    /^https?:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+:\d+$/
  ];
  
  console.log(`[Auth CORS] Checking origin: "${origin}" against allowed origins:`, allowedOrigins);
  
  // For requests with no Origin header, which can happen with the Vite proxy
  // we'll assume they're from localhost:5173 in development
  if (!origin) {
    console.log('[Auth CORS] No origin header present, assuming localhost in dev');
    
    // Check if we're running in a development environment
    const isDev = process.env.NODE_ENV !== 'production';
    
    if (isDev) {
      // Use default development origin
      const defaultDevOrigin = 'http://localhost:5173';
      console.log(`[Auth CORS] Setting default dev origin: ${defaultDevOrigin}`);
      
      // Set CORS headers for the default development origin
      newResponse.headers.set('Access-Control-Allow-Origin', defaultDevOrigin);
      newResponse.headers.set('Access-Control-Allow-Credentials', 'true');
      newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      newResponse.headers.set('Access-Control-Expose-Headers', 'Set-Cookie, set-auth-jwt');
    }
  } else {
    // Check if the origin is allowed (either direct match or regex match)
    const isAllowed = allowedOrigins.some(allowedOrigin => {
      if (typeof allowedOrigin === 'string') {
        return allowedOrigin === origin;
      } else if (allowedOrigin instanceof RegExp) {
        return allowedOrigin.test(origin);
      }
      return false;
    });
    
    if (isAllowed) {
      console.log(`[Auth CORS] Origin "${origin}" is allowed, setting CORS headers`);
      
      // Set CORS headers only for allowed origins
      newResponse.headers.set('Access-Control-Allow-Origin', origin);
      newResponse.headers.set('Access-Control-Allow-Credentials', 'true');
      newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      newResponse.headers.set('Access-Control-Expose-Headers', 'Set-Cookie, set-auth-jwt');
    } else {
      console.log(`[Auth CORS] Origin "${origin}" is not in the allowed list`);
    }
  }
  
  return newResponse;
};

// Handle only POST and GET, no OPTIONS or CORS handling here
authRouter.on(["POST", "GET"], "/*", async (c) => {
  const origin = c.req.header('Origin');
  console.log(`[Auth Router] Handling path: ${c.req.path}, Method: ${c.req.method}, Origin: ${origin}`);
  
  const authInstance = getAuth(c);
  try {
    const request = c.req.raw;
    const url = new URL(request.url);
    url.pathname = c.req.path;
    const modifiedRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: request.redirect,
      signal: request.signal,
    });

    const response = await authInstance.handler(modifiedRequest);
    console.log("[Auth Router] Handler returned response");
    
    // Enhance response with proper CORS headers
    const enhancedResponse = enhanceResponseWithCORS(response, origin);
    
    // Log the headers that were set
    const corsHeaders = {
      'access-control-allow-origin': enhancedResponse.headers.get('Access-Control-Allow-Origin'),
      'access-control-allow-credentials': enhancedResponse.headers.get('Access-Control-Allow-Credentials'),
      'access-control-expose-headers': enhancedResponse.headers.get('Access-Control-Expose-Headers'),
    };
    console.log("[Auth Router] CORS headers set:", corsHeaders);
    
    return enhancedResponse;

  } catch (error) {
    console.error("[Auth Router] Error in Better Auth handler:", error);
    // Return a simple error response with CORS headers
    const errorResponse = new Response(JSON.stringify({ error: "Internal Auth Error" }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
    return enhanceResponseWithCORS(errorResponse, origin);
  }
});

export default authRouter; 