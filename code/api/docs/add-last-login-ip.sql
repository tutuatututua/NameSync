-- ============================================================================
-- Network Intel — record the address a user last signed in from
-- ============================================================================
-- Run this against a live database. Purely additive and fully idempotent: one
-- nullable column, no row rewritten, no default to backfill. Running it twice is
-- a no-op, and existing accounts simply read NULL until their next sign-in.
--
--   psql "$DATABASE_URL" -f docs/add-last-login-ip.sql
--
-- `auth_session.ip` already stored an address per session; this is the account-level
-- twin of `last_login_at`, so "when did they last sign in, and from where" is one
-- read of app_user rather than a join against sessions that get deleted at logout.
--
-- NOTE: the value is only the user's real address if the API can see it. Exposed
-- directly it always can; behind a reverse proxy it needs TRUST_PROXY set, or every
-- row here records the proxy's internal address. See api/src/config/env.ts.
--
-- Adjust the schema below if yours is not `lakeshore` (it must match DB_SCHEMA).
-- ============================================================================

SET search_path TO lakeshore, public;

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS last_login_ip varchar(64);
