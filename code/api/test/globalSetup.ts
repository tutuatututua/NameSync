import { execSync } from "node:child_process";
import { Client } from "pg";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://namesync:namesync@localhost:55432/namesync_test";

/** Create the test database if it doesn't exist yet (CREATE DATABASE can't run in a tx). */
async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  const admin = new URL(url);
  admin.pathname = "/postgres";

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();
}

/**
 * Runs once before the suite: ensure the test DB exists, then migrate it in a child
 * tsx process (tsx can dynamic-import the migration files by absolute path, which
 * Vitest's own ESM loader cannot on Windows `c:\` paths).
 */
export default async function setup(): Promise<void> {
  await ensureDatabase(DATABASE_URL);
  execSync("npx tsx src/migrate.ts", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL },
  });
}
