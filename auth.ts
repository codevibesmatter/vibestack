import { betterAuth } from "better-auth";
import { Pool } from 'pg';
import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from the server's .dev.vars file
config({ path: resolve(__dirname, "apps/server/.dev.vars") });

// Validate required environment variables
const requiredEnvVars = {
  DATABASE_URL: process.env.DATABASE_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
} as const;

// Check if all required environment variables are present
for (const [key, value] of Object.entries(requiredEnvVars)) {
  if (!value) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

export const auth = betterAuth({
  database: new Pool({
    connectionString: requiredEnvVars.DATABASE_URL as string,
  }),
  secret: requiredEnvVars.BETTER_AUTH_SECRET as string,
  baseUrl: requiredEnvVars.BETTER_AUTH_URL as string,
  emailAndPassword: { enabled: true },
}); 