import { betterAuth } from "better-auth";
import { NeonHTTPDialect } from "kysely-neon";
import { Hono, Context } from "hono";
import type { Env } from "../types/env";

// Type for Hono context including Auth variables
export type AuthType = {
  Variables: {
    user: typeof auth.$Infer.Session.user | null;
    session: typeof auth.$Infer.Session.session | null;
  };
  Bindings: Env;
};

// Define a type for the Hono Context with AuthType
type HonoAuthContext = Context<AuthType>;

// --- Top-level initialization for CLI compatibility ---
// The CLI needs to instantiate the config at module load time.
// It runs in Node.js, so we attempt to use process.env here.
// Hono runtime will use the instance generated via getAuth.

// Check for process.env existence (Node.js environment)
const dbUrlForCli = typeof process !== 'undefined' ? process.env.DATABASE_URL : undefined;
const secretForCli = typeof process !== 'undefined' ? process.env.BETTER_AUTH_SECRET : undefined;
const baseUrlForCli = typeof process !== 'undefined' ? process.env.BETTER_AUTH_URL : undefined;

// Use NeonHTTPDialect (Stateless HTTPS) for CLI instance if dbUrlForCli is available
const cliNeonDialect = dbUrlForCli
  ? new NeonHTTPDialect({ connectionString: dbUrlForCli })
  : undefined;

// Top-level auth instance for CLI schema generation and potentially type inference.
// Provide minimal config required for the CLI to detect the database type.
// The actual runtime configuration happens in initializeAuth below.
export const auth = betterAuth({
    // Wrap dialect in an object and specify the type for CLI
    database: cliNeonDialect ? {
      dialect: cliNeonDialect,
      type: "postgres"
    } : undefined,
    secret: secretForCli,
    baseUrl: baseUrlForCli,
    emailAndPassword: { enabled: true },
});


// --- Runtime initialization for Hono ---

// Helper function to get the auth instance (ensures env vars are accessed within request context)
function initializeAuth(env: Env) {
  const neonDialect = new NeonHTTPDialect({
    connectionString: env.DATABASE_URL,
  });

  console.log("[AUTH Runtime Init] Initializing Better Auth with:");
  console.log(`  DATABASE_URL (type): ${typeof env.DATABASE_URL}`); 
  console.log(`  BETTER_AUTH_SECRET (type): ${typeof env.BETTER_AUTH_SECRET}`);
  console.log(`  TRUSTED_ORIGINS: ${['http://localhost:5173']}`);

  // Return a fully configured instance for runtime use
  return betterAuth({
    database: {
      dialect: neonDialect,
      type: "postgres",
      log: ['query', 'error']
    },
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: env.BETTER_AUTH_URL,
    cookieOptions: {
      secure: true,
      sameSite: "none"
    },
    emailAndPassword: {
      enabled: true,
    },
    advanced: {
      database: {
        generateId: false,
      },
    },
  });
}

// Export a function that initializes auth based on Hono context for runtime use
export const getAuth = (c: HonoAuthContext) => {
    return initializeAuth(c.env);
} 