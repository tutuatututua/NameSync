import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://namesync:namesync@localhost:55432/namesync_test";
const SCHEMA = process.env.DB_SCHEMA || "lakeshore";

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
 * Runs once before the suite: ensure the test DB exists, then (re)apply the
 * lakeshore schema from docs/schema-redesign.sql. The file is idempotent — it drops
 * and recreates its tables — so a fresh, empty schema is guaranteed each run.
 * (The app's on-boot migrator is disabled via DB_SKIP_MIGRATE; the schema is
 * managed by this SQL, not the old migrations.)
 */
export default async function setup(): Promise<void> {
  await ensureDatabase(DATABASE_URL);
  const sql = await fs.readFile(path.resolve(process.cwd(), "docs/schema-redesign.sql"), "utf8");

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await client.query(sql);
  await client.end();
}
