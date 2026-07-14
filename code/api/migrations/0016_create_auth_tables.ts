import { Kysely, sql } from "kysely";

/**
 * Real authentication, replacing the verify-only JWT setup.
 *
 * NameSync used to sit behind a website that logged the user in and handed over a JWT;
 * there was no user, no password and no session here. It now owns the whole flow, which
 * needs exactly two tables:
 *
 *   app_user      who can sign in. `password_hash` is a self-describing scrypt string
 *                 (see lib/password.ts) — the parameters travel with the hash, so they
 *                 can be raised later without invalidating existing rows.
 *
 *   auth_session  the sessions themselves. A session token is 32 random bytes that only
 *                 the browser ever sees; what is stored here is its SHA-256, so a leaked
 *                 dump of this table cannot be replayed as a login. Rows are the reason a
 *                 session can be *revoked* — the thing a stateless JWT cannot do.
 *
 * `ifNotExists` throughout, to match the other migrations: the redesign tables are also
 * created out-of-band by docs/schema-redesign.sql (which the test harness applies), so
 * whichever runs first wins and the other is a no-op.
 */
/**
 * The migration runner (src/migrate.ts) opens its own pool and does NOT pin a search_path,
 * so an unqualified CREATE TABLE here lands in `public` — while the app's pool DOES pin one
 * (`DB_SCHEMA`, e.g. `lakeshore`; see extensions/sqldb/src/pools/postgres.ts). Left alone,
 * that means the migration creates app_user in a schema the app never looks in, and every
 * login fails with "relation app_user does not exist".
 *
 * So honour DB_SCHEMA here, exactly as the app does. Unset => `public`, unchanged.
 */
const schema = process.env.DB_SCHEMA?.trim();
const qualified = (table: string): string => (schema ? `${schema}.${table}` : table);

export async function up(db: Kysely<any>): Promise<void> {
  const builder = schema ? db.schema.withSchema(schema) : db.schema;

  await builder
    .createTable("app_user")
    .ifNotExists()
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    // 320 = the longest legal email address (64 local + @ + 255 domain).
    .addColumn("email", "varchar(320)", (col) => col.notNull())
    .addColumn("password_hash", "text", (col) => col.notNull())
    .addColumn("name", "varchar(255)")
    .addColumn("roles", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'::text[]`))
    // Disabling beats deleting: it kills the login without orphaning anything the user
    // created. The guard also re-checks this on every request, so it takes effect at once.
    .addColumn("is_active", "boolean", (col) => col.notNull().defaultTo(true))
    .addColumn("last_login_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Unique on lower(email), not on email: otherwise Ann@x.com and ann@x.com are two
  // accounts, and which one you get at login depends on how you typed it.
  // Raw SQL because Kysely's index builder cannot express a functional index.
  await sql
    .raw(`create unique index if not exists idx_app_user_email on ${qualified("app_user")} (lower(email))`)
    .execute(db);

  await builder
    .createTable("auth_session")
    .ifNotExists()
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    .addColumn("user_id", "bigint", (col) =>
      // Deleting a user must take their live sessions with them, or they stay signed in.
      col.notNull().references(`${qualified("app_user")}.id`).onDelete("cascade")
    )
    // SHA-256 hex of the token the browser holds. Unique so a token maps to one session.
    .addColumn("token_hash", "varchar(64)", (col) => col.notNull().unique())
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("last_seen_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("user_agent", "text")
    .addColumn("ip", "varchar(64)")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Listing / revoking every session belonging to one user ("sign out everywhere").
  await builder
    .createIndex("idx_auth_session_user")
    .ifNotExists()
    .on("auth_session")
    .column("user_id")
    .execute();

  // The periodic sweep of expired rows scans by this.
  await builder
    .createIndex("idx_auth_session_expires")
    .ifNotExists()
    .on("auth_session")
    .column("expires_at")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  const builder = schema ? db.schema.withSchema(schema) : db.schema;
  // auth_session first: it holds the FK into app_user.
  await builder.dropTable("auth_session").ifExists().execute();
  await builder.dropTable("app_user").ifExists().execute();
}
