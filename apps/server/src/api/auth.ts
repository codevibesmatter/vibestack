import { Hono } from "hono";
import { getAuth, AuthType } from "../lib/auth";

const authRouter = new Hono<AuthType>();

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
    
    // Return the raw response directly. No CORS headers added here.
    return response;

  } catch (error) {
    console.error("[Auth Router] Error in Better Auth handler:", error);
    // Return a simple error response. No CORS headers added here.
    return c.json({ error: "Internal Auth Error" }, 500);
  }
});

export default authRouter; 