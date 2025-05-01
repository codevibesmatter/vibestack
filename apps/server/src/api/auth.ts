import { Hono } from "hono";
import { getAuth, AuthType } from "../lib/auth";

const authRouter = new Hono<AuthType>();

// Helper to enhance response with proper CORS headers
const enhanceResponseWithCORS = (response: Response, origin: string | null | undefined): Response => {
  const newResponse = new Response(response.body, response);
  
  if (origin) {
    const allowedOrigins = ['https://127.0.0.1:5173', 'http://127.0.0.1:5173', 'http://localhost:5173'];
    if (allowedOrigins.includes(origin)) {
      newResponse.headers.set('Access-Control-Allow-Origin', origin);
      newResponse.headers.set('Access-Control-Allow-Credentials', 'true');
      newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      newResponse.headers.set('Access-Control-Expose-Headers', 'Set-Cookie');
      // This ensures Vary header is set for proper cache behavior
      newResponse.headers.set('Vary', 'Origin');
    }
  }
  
  return newResponse;
};

// Handle only POST and GET, no OPTIONS or CORS handling here
authRouter.on(["POST", "GET"], "/*", async (c) => {
  console.log(`[Auth Router] Handling path: ${c.req.path}, Method: ${c.req.method}`);
  
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
    const origin = request.headers.get('Origin');
    return enhanceResponseWithCORS(response, origin);

  } catch (error) {
    console.error("[Auth Router] Error in Better Auth handler:", error);
    // Return a simple error response with CORS headers
    const origin = c.req.header('Origin');
    const errorResponse = new Response(JSON.stringify({ error: "Internal Auth Error" }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
    return enhanceResponseWithCORS(errorResponse, origin);
  }
});

export default authRouter; 