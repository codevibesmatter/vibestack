import { betterAuth } from "better-auth";
import { config } from "dotenv";
import { resolve } from "path";
import { Pool } from 'pg';

// Load environment variables from the server's .dev.vars file
config({ path: resolve(__dirname, "../../../apps/server/.dev.vars") });

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

// Create the auth instance with the same configuration as the server
const auth = betterAuth({
  database: new Pool({
    connectionString: requiredEnvVars.DATABASE_URL as string,
  }),
  secret: requiredEnvVars.BETTER_AUTH_SECRET as string,
  baseUrl: requiredEnvVars.BETTER_AUTH_URL as string,
  emailAndPassword: { enabled: true },
});

// Run migrations
async function main() {
  try {
    console.log("Running Better Auth migrations...");
    // Use the Better Auth CLI to run migrations with config path
    const { execSync } = require('child_process');
    execSync('npx @better-auth/cli migrate --config ../../auth.ts', { stdio: 'inherit' });
    console.log("Migrations completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

main(); 