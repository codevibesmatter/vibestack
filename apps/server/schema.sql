-- Enable pgcrypto extension if not already enabled (for gen_random_uuid)
-- You might need to run this separately via Neon console or psql if it fails here.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Modify existing 'users' table for Better Auth compatibility
ALTER TABLE users ALTER COLUMN name DROP NOT NULL;
ALTER TABLE users ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users RENAME COLUMN avatar_url TO image;

-- Account Table: Links users to authentication methods (email/password, social providers)
CREATE TABLE "account" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL REFERENCES "users"(id) ON DELETE CASCADE, -- Reference the existing 'users' table
    "accountId" TEXT NOT NULL, -- Provider's user ID or user's own ID for credentials
    "providerId" TEXT NOT NULL, -- e.g., 'email-password', 'github', 'google'
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ,
    "refreshTokenExpiresAt" TIMESTAMPTZ,
    "scope" TEXT,
    "idToken" TEXT,
    "password" TEXT, -- Stores hashed password for 'email-password' provider
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Ensure a user can only link one account per provider
    UNIQUE ("providerId", "accountId")
);

-- Session Table: Stores active user sessions
CREATE TABLE "session" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL REFERENCES "users"(id) ON DELETE CASCADE, -- Reference the existing 'users' table
    "token" TEXT UNIQUE NOT NULL, -- The session token value
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Verification Table: Stores tokens for email verification, password reset, etc.
CREATE TABLE "verification" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "identifier" TEXT NOT NULL, -- e.g., email address
    "value" TEXT NOT NULL, -- The verification token/code
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Optional: Index for faster lookups on verification identifiers
CREATE INDEX idx_verification_identifier ON "verification"("identifier");

-- Optional: Indexes for foreign keys if not automatically created
-- Note: Reference existing 'users' table name
CREATE INDEX idx_account_userId ON "account"("userId");
CREATE INDEX idx_session_userId ON "session"("userId"); 