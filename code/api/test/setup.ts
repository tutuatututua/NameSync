// Runs before any test module is imported, so config/env.ts sees these values
// (it parses process.env once at import). Points at a throwaway Postgres test DB
// and a local mock for the external webhooks.
process.env.NODE_ENV = "test";
process.env.DB_ENGINE = "postgres";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://namesync:namesync@localhost:55432/namesync_test";
process.env.CORS_ORIGIN = "http://localhost:3000";
process.env.COMPANY_WEBHOOK_URL = "http://127.0.0.1:8199/company";
process.env.FACEBOOK_WEBHOOK_URL = "http://127.0.0.1:8199/facebook";
process.env.COMPARE_WEBHOOK_URL = "http://127.0.0.1:8199/compare";
delete process.env.CALLBACK_TOKEN;
delete process.env.WEBHOOK_CALLBACK_URL_BASE;
// The test DB is migrated out-of-band (globalSetup runs a child tsx process),
// because Vitest's ESM loader can't dynamic-import migration files by Windows path.
process.env.DB_SKIP_MIGRATE = "1";

export const MOCK_PORT = 8199;
