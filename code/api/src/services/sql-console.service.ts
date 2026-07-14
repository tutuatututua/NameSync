import { Pool, type DatabaseError } from "pg";
import type { SqlResult } from "@extensions/contract";
import { env } from "../config/env";
import { BadRequest, ServiceUnavailable } from "../lib/errors";

/**
 * The read-only SQL console.
 *
 * Runs on its own small pg pool rather than through Kysely, for two reasons:
 *   - `rowMode: "array"` gives back real column metadata in SELECT order. Kysely hands
 *     rows over as objects, which silently collapses duplicate column names — and
 *     `SELECT * FROM friend JOIN upload …` produces two `id` columns and two
 *     `created_at`s. An object would lose half of them.
 *   - it can point at DATABASE_URL_READONLY (a role that physically cannot write) if
 *     ops supplies one.
 *
 * Nothing a user types can write to the database. Four independent layers:
 *   1. The statement is wrapped as a subquery (see below) — a write or a second
 *      statement becomes a *syntax error*, not a query.
 *   2. It runs in a READ ONLY transaction, so Postgres itself refuses any write.
 *   3. The transaction is always rolled back.
 *   4. statement_timeout and a hard row cap bound the damage a runaway SELECT can do.
 * Layer 1 alone would be enough; the rest are there because "alone" is a bad bet.
 */

let pool: Pool | null = null;

const isPostgresUrl = (url: string): boolean => /^postgres(ql)?:\/\//i.test(url);

function getPool(): Pool {
  if (pool) return pool;

  const url = env.DATABASE_URL_READONLY?.trim() || env.DATABASE_URL?.trim();
  if (!url || !isPostgresUrl(url)) {
    throw new ServiceUnavailable("The SQL console needs a PostgreSQL connection (set DATABASE_URL).");
  }

  // Pin search_path the same way the app's pool does, so unqualified table names resolve
  // in the app's schema and a user can write `select * from friend`.
  const schema = process.env.DB_SCHEMA?.trim();
  const options = [
    ...(schema ? [`-c search_path=${schema}`] : []),
    "-c application_name=namesync-sql-console",
  ].join(" ");

  pool = new Pool({ connectionString: url, max: 3, options });
  return pool;
}

export async function closeSqlConsolePool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end();
}

/**
 * Statements that can't be a subquery. The subquery wrap already rejects every one of
 * these — but as an opaque "syntax error at or near ...", which is a terrible thing to
 * show someone who just typed `DELETE FROM friend`. This exists purely to say *why*.
 * It is not the security boundary and must never be treated as one.
 */
const NOT_A_SELECT =
  /^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|reindex|refresh|call|do|set|begin|commit|rollback|comment|lock|analyze|explain|prepare|execute|listen|notify)\b/i;

export async function runReadOnlyQuery(rawSql: string): Promise<SqlResult> {
  // One trailing semicolon is normal to type; strip it so the wrap stays valid. Any
  // *other* semicolon stays put and blows up inside the subquery, which is what we want.
  const statement = rawSql.trim().replace(/;+\s*$/, "").trim();
  if (!statement) throw new BadRequest("Enter a query");

  if (NOT_A_SELECT.test(statement)) {
    throw new BadRequest(
      "The SQL console is read-only — it runs SELECT (and WITH … SELECT) queries only."
    );
  }

  const cap = env.SQL_CONSOLE_MAX_ROWS;
  // Fetch one more than the cap so we can tell "exactly cap rows" from "there are more".
  const wrapped = `SELECT * FROM (\n${statement}\n) AS __console LIMIT ${cap + 1}`;

  const client = await getPool().connect();
  const startedAt = Date.now();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${env.SQL_CONSOLE_TIMEOUT_MS}`);

    const result = await client.query<unknown[]>({ text: wrapped, rowMode: "array" });
    const elapsedMs = Date.now() - startedAt;

    const truncated = result.rows.length > cap;
    const rows = truncated ? result.rows.slice(0, cap) : result.rows;

    return {
      columns: result.fields.map((f) => f.name),
      rows,
      rowCount: rows.length,
      truncated,
      elapsedMs,
    };
  } catch (err) {
    throw translate(err, Date.now() - startedAt);
  } finally {
    // The transaction never commits. Rolling back a already-aborted tx is a no-op, and
    // if the connection died there's nothing to roll back — either way, don't mask the
    // original error with a cleanup one.
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/**
 * Postgres' own error text is the most useful thing we can show here ("column x does not
 * exist", "syntax error at or near ..."), and this endpoint is behind auth — so surface
 * it rather than hiding it behind a generic 500. Only the codes with a better story get
 * rewritten.
 */
function translate(err: unknown, elapsedMs: number): Error {
  const e = err as Partial<DatabaseError> & { message?: string };

  switch (e.code) {
    case "57014": // query_canceled — our statement_timeout fired
      return new BadRequest(
        `Query cancelled after ${elapsedMs}ms (the limit is ${env.SQL_CONSOLE_TIMEOUT_MS}ms). Narrow it down or add a LIMIT.`
      );
    case "25006": // read_only_sql_transaction
    case "42501": // insufficient_privilege
      return new BadRequest("The SQL console is read-only — that statement would modify the database.");
    default:
      return new BadRequest(e.message ?? "Could not run that query");
  }
}
