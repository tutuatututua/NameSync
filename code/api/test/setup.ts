// Runs before any test module is imported, so config/env.ts sees these values
// (it parses process.env once at import). Points at a throwaway Postgres test DB
// and a local mock for the external webhooks.
process.env.NODE_ENV = "test";
process.env.DB_ENGINE = "postgres";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://networkintel:networkintel@localhost:55432/networkintel_test";
// Network Intel tables live in the `lakeshore` schema (globalSetup applies the schema there).
process.env.DB_SCHEMA = "lakeshore";
process.env.CORS_ORIGIN = "http://localhost:3000";
// Ingestion only. There is no COMPARE_WEBHOOK_URL: the comparison is computed against
// Postgres (matcher.service), so nothing external is triggered to run it.
process.env.COMPANY_WEBHOOK_URL = "http://127.0.0.1:8199/company";
process.env.FACEBOOK_WEBHOOK_URL = "http://127.0.0.1:8199/facebook";

/**
 * Pinned to "" rather than deleted — and the difference matters.
 *
 * `src/app.ts` opens with `import "dotenv/config"`, so the developer's own .env is read into this
 * process when the app is built. dotenv will not overwrite a variable that is *present* in
 * process.env, but a deleted one is not present: `delete` hands the key straight back to .env,
 * which is the opposite of what a scrub is for. An empty string is present, is falsy to every
 * check that reads it, and is therefore the only spelling of "off" that .env cannot undo.
 *
 * EXTERNAL_MATCHER is the one that bites. Every suite except external-matcher.test.ts asserts the
 * internal matcher's behaviour — an import that is `completed` when the request returns — and a
 * developer with EXTERNAL_MATCHER=1 in their .env (which is now the normal way to run this app)
 * would otherwise watch those suites fail for reasons that have nothing to do with their change.
 * The tests decide which matcher they are testing; the environment does not get a vote.
 */
process.env.EXTERNAL_MATCHER = "";
process.env.CALLBACK_TOKEN = "";
process.env.WEBHOOK_CALLBACK_URL_BASE = "";
// The test DB is migrated out-of-band (globalSetup runs a child tsx process),
// because Vitest's ESM loader can't dynamic-import migration files by Windows path.
process.env.DB_SKIP_MIGRATE = "1";
// Most suites exercise the routes without signing in. The auth tests in db-console.test.ts
// build their OWN app with AUTH_DISABLED unset, which turns auth back on — registerAuth()
// reads process.env at registration, not at import.
process.env.AUTH_DISABLED = "1";
// Keep the SQL console's timeout test fast (the default is 5s).
process.env.SQL_CONSOLE_TIMEOUT_MS = "2000";
// Center sign-in points at a URL that is never really dialled: center-auth.test.ts stubs
// global fetch. It must be present *here*, before config/env.ts parses process.env once at
// import, because lib/center.ts reads the frozen `env.CENTER_PLAYME_URL`, not process.env.
process.env.CENTER_PLAYME_URL = "http://127.0.0.1:59999/center/";
process.env.CENTER_GROUP_IAM2_ID = "test-group";

export const MOCK_PORT = 8199;
