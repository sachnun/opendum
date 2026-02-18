-- Migration: NextAuth → Better Auth data transformation
-- Run this AFTER drizzle-kit push has created the new schema
-- Run this BEFORE users start using the new auth system
--
-- IMPORTANT: Take a database snapshot/backup before running this script!
--
-- This script assumes:
-- 1. The old NextAuth tables ("Account", "Session", "User", "VerificationToken") exist
-- 2. The new Better Auth tables ("user", "session", "account", "verification") exist
-- 3. Table names are case-sensitive in PostgreSQL when quoted

-- ============================================================================
-- Step 1: Migrate User records
-- ============================================================================
-- Better Auth user table uses 'emailVerified' as boolean (not timestamp)
-- NextAuth user table uses 'emailVerified' as timestamp (null = not verified)

INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
SELECT
  "id",
  COALESCE("name", ''),
  "email",
  CASE WHEN "emailVerified" IS NOT NULL THEN true ELSE false END,
  "image",
  "createdAt",
  "updatedAt"
FROM "User"
WHERE "email" IS NOT NULL
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "emailVerified" = EXCLUDED."emailVerified",
  "image" = EXCLUDED."image",
  "updatedAt" = EXCLUDED."updatedAt";

-- ============================================================================
-- Step 2: Migrate Account records (OAuth provider links)
-- ============================================================================
-- NextAuth Account fields → Better Auth account fields mapping:
--   id → id
--   userId → userId
--   providerAccountId → accountId (the provider's user ID)
--   provider → providerId
--   access_token → accessToken
--   refresh_token → refreshToken
--   expires_at → accessTokenExpiresAt (convert from unix seconds to timestamp)
--   scope → scope
--   id_token → idToken

INSERT INTO "account" (
  "id", "userId", "accountId", "providerId",
  "accessToken", "refreshToken", "accessTokenExpiresAt",
  "scope", "idToken", "createdAt", "updatedAt"
)
SELECT
  "id",
  "userId",
  "providerAccountId",
  "provider",
  "access_token",
  "refresh_token",
  CASE
    WHEN "expires_at" IS NOT NULL
    THEN to_timestamp("expires_at")
    ELSE NULL
  END,
  "scope",
  "id_token",
  NOW(),
  NOW()
FROM "Account"
ON CONFLICT ("id") DO UPDATE SET
  "accessToken" = EXCLUDED."accessToken",
  "refreshToken" = EXCLUDED."refreshToken",
  "accessTokenExpiresAt" = EXCLUDED."accessTokenExpiresAt",
  "updatedAt" = NOW();

-- ============================================================================
-- Step 3: Verify migration
-- ============================================================================
-- Run these queries to verify the migration was successful:

-- Check user count matches
-- SELECT 'Old users' as source, COUNT(*) FROM "User"
-- UNION ALL
-- SELECT 'New users' as source, COUNT(*) FROM "user";

-- Check account count matches
-- SELECT 'Old accounts' as source, COUNT(*) FROM "Account"
-- UNION ALL
-- SELECT 'New accounts' as source, COUNT(*) FROM "account";

-- ============================================================================
-- Step 4 (OPTIONAL): Drop old NextAuth tables after verification
-- ============================================================================
-- Only run these after confirming the migration is successful and Better Auth
-- is working correctly in production!

-- DROP TABLE IF EXISTS "Account" CASCADE;
-- DROP TABLE IF EXISTS "Session" CASCADE;
-- DROP TABLE IF EXISTS "VerificationToken" CASCADE;
-- DROP TABLE IF EXISTS "User" CASCADE;

-- Note: The "User" table should be dropped LAST because other tables
-- reference it via foreign keys. The CASCADE will handle this, but
-- be aware it will also drop the app-specific tables (ProviderAccount,
-- ProxyApiKey, UsageLog, DisabledModel) if they still reference the
-- old "User" table. The new schema should already have these tables
-- referencing the new "user" table.
