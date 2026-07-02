import "dotenv/config";
import * as path from "path";
import { promises as fs } from "fs";
import { Kysely, Migrator, FileMigrationProvider, PostgresDialect } from "kysely";
import { Pool } from "pg";

/**
 * Standalone migration runner for PostgreSQL. Run before serving (the Docker
 * entrypoint does `npm run migrate` once Postgres is healthy). base.model also
 * migrates on boot as an idempotent safety net.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required to run migrations.");
    process.exit(1);
  }

  const db = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.resolve(process.cwd(), "migrations"),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  for (const r of results ?? []) {
    if (r.status === "Success") console.log(`  ✓ ${r.migrationName}`);
    else if (r.status === "Error") console.error(`  ✗ ${r.migrationName} (failed)`);
  }

  if (error) {
    console.error("Migration failed:", error);
    await db.destroy();
    process.exit(1);
  }

  if (!results || results.length === 0) console.log("No pending migrations.");
  else console.log(`Applied ${results.length} migration(s).`);

  await db.destroy();
}

main().catch((err) => {
  console.error("Migration runner crashed:", err);
  process.exit(1);
});
