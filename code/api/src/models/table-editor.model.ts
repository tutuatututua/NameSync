import { DBModel } from "@extensions/sqldb";
import { sql, type SqlBool } from "kysely";
import type { DbFilter, DbRow, PaginatedResult, TableQueryBody } from "@extensions/contract";
import { BadRequest, NotFound } from "../lib/errors";
import {
  columnRef,
  getColumn,
  getPrimaryKey,
  getTable,
  type RegistryColumn,
  type RegistryTable,
} from "../lib/table-registry";

/**
 * Generic row CRUD for the Database console.
 *
 * Two rules make this safe, and both are enforced here rather than trusted from the client:
 *   1. Every table and column name is resolved through the registry (lib/table-registry.ts),
 *      so an identifier the server doesn't already know cannot reach the SQL.
 *   2. Every *value* is passed as a Kysely parameter — nothing is string-interpolated.
 *
 * Kysely is typed `Kysely<any>` in this project (extensions/sqldb/src/db.types.ts is
 * `export type DB = any`), so the query builders below take `any`. The registry, not the
 * type system, is what guarantees the names are real.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const COMPARISON_OPS = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

/** `%` and `_` are ILIKE wildcards — a user searching for "50%" means the literal text. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Turn a JSON value from the browser into something the column can hold. An empty
 * string means "null" — the grid has no other way to express it. (A consequence: you
 * cannot store an empty string through the console; it becomes NULL.)
 */
function coerce(col: RegistryColumn, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "") {
    if (!col.nullable) throw new BadRequest(`"${col.name}" cannot be empty`);
    return null;
  }

  switch (col.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw new BadRequest(`"${col.name}" must be a number`);
      return n;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      const s = String(raw).trim().toLowerCase();
      if (s === "true" || s === "t" || s === "1") return true;
      if (s === "false" || s === "f" || s === "0") return false;
      throw new BadRequest(`"${col.name}" must be true or false`);
    }
    case "timestamp": {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) throw new BadRequest(`"${col.name}" must be a date/time`);
      return d.toISOString();
    }
    case "json": {
      if (typeof raw !== "string") return raw; // already an object/array from the JSON body
      try {
        return JSON.parse(raw);
      } catch {
        throw new BadRequest(`"${col.name}" must be valid JSON`);
      }
    }
    case "string":
    default: {
      const s = String(raw);
      if (col.enumValues && !col.enumValues.includes(s)) {
        throw new BadRequest(`"${col.name}" must be one of: ${col.enumValues.join(", ")}`);
      }
      return s;
    }
  }
}

/** Same coercion, but for a filter operand — where NULL is a legitimate thing to ask for. */
function coerceOperand(col: RegistryColumn, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  return coerce({ ...col, nullable: true }, raw);
}

/** A bigint key never matches a non-numeric string — short-circuit instead of letting
 *  Postgres raise "invalid input syntax for type bigint" as a 500. */
function coerceKey(pk: RegistryColumn, id: string): string {
  if (pk.type === "number" && !/^\d+$/.test(id)) throw new NotFound("Row not found");
  return id;
}

/**
 * Validate + coerce a write payload against the registry.
 *
 * Joined columns are `editable: false`, so the read-only check below is also what stops a
 * write from reaching a table the row doesn't belong to — editing `friend.uploaded_by`
 * would otherwise mean writing to `upload`.
 */
function buildValues(table: RegistryTable, values: Record<string, unknown>, forInsert: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(values)) {
    const col = getColumn(table, key); // 400 on an unknown column
    if (!col.editable) throw new BadRequest(`"${col.name}" is read-only`);
    out[col.name] = coerce(col, raw);
  }

  if (forInsert) {
    for (const col of table.columns) {
      if (col.required && (out[col.name] === undefined || out[col.name] === null)) {
        throw new BadRequest(`"${col.name}" is required`);
      }
    }
  }

  if (Object.keys(out).length === 0) throw new BadRequest("No values supplied");
  return out;
}

function applyFilter(q: any, table: RegistryTable, f: DbFilter): any {
  const col = getColumn(table, f.column);
  // Qualified (`friend.source`, `upload.uploaded_by`) — with a join in play, a bare column
  // name can be ambiguous, and the registry is what makes the qualification trustworthy.
  const ref = columnRef(table, col);

  if (f.op === "is_null") return q.where(ref, "is", null);
  if (f.op === "is_not_null") return q.where(ref, "is not", null);

  // jsonb has no useful ordering or equality for a grid filter; only null checks make sense.
  if (col.type === "json") {
    throw new BadRequest(`"${col.label}" is JSON — only "is empty" / "is not empty" can filter it`);
  }

  if (f.op === "contains") {
    if (col.type !== "string") throw new BadRequest(`"contains" only works on text columns`);
    return q.where(ref, "ilike", `%${escapeLike(String(f.value ?? ""))}%`);
  }

  if (f.op === "in") {
    if (!Array.isArray(f.value) || f.value.length === 0) {
      throw new BadRequest(`"${col.label}": "is one of" needs at least one value`);
    }
    return q.where(
      ref,
      "in",
      f.value.map((v) => coerceOperand(col, v))
    );
  }

  const operand = coerceOperand(col, f.value);
  // `= NULL` is never true in SQL; the user plainly meant IS NULL.
  if (operand === null) return q.where(ref, f.op === "neq" ? "is not" : "is", null);

  return q.where(ref, COMPARISON_OPS[f.op], operand);
}

/**
 * Free-text search: one term, matched as a case-insensitive substring against every text
 * column at once, the columns OR'd together. The term is escaped like `contains`, so a
 * literal `%` or `_` matches itself, and only string columns take part — numbers,
 * timestamps, booleans and jsonb have no useful substring match. The OR group is a single
 * `where`, so it AND-combines with any filters rather than widening them.
 */
function applySearch(q: any, table: RegistryTable, term: string): any {
  const like = `%${escapeLike(term)}%`;
  const refs = table.columns.filter((col) => col.type === "string").map((col) => columnRef(table, col));
  // Every registry table has a text column; the guard only stops a future text-free table
  // from handing eb.or() an empty array, which it rejects.
  if (refs.length === 0) return q;
  /**
   * `::text` because "string" here is the REGISTRY's type, not Postgres's, and the two stopped
   * agreeing when `person_key` (a real `uuid`) was listed. `uuid ILIKE text` has no operator, so
   * the whole search 500s — not just on that column, on the table.
   *
   * Casting rather than filtering the column out, because searching it is genuinely useful: paste
   * a person key in and get every row of that person, which is the question the column exists to
   * answer. A no-op on the varchar columns, and it costs nothing that was not already lost — a
   * leading-`%` LIKE could never use an index anyway.
   */
  return q.where((eb: any) =>
    eb.or(refs.map((ref: string) => sql<SqlBool>`${sql.ref(ref)}::text ilike ${like}`))
  );
}

export class TableEditorModel extends DBModel {
  /** Filtered, sorted, paginated rows. Throws 404/400 for anything not in the registry. */
  static async queryRows(tableName: string, body: TableQueryBody): Promise<PaginatedResult<DbRow>> {
    const table = getTable(tableName);
    const pk = getPrimaryKey(table);
    const db = await this.getKyselyDB();
    const offset = (body.page - 1) * body.limit;

    // Both queries start from the same base — the table plus its joins — so a filter on a
    // joined column resolves in the count as well as in the page of rows, and the two
    // agree. Every join in the registry is to the other table's primary key, so a LEFT
    // JOIN matches at most one row and cannot inflate the count.
    const base = (): any =>
      (table.joins ?? []).reduce(
        (q: any, j) => q.leftJoin(j.table, `${table.name}.${j.localColumn}`, `${j.table}.${j.foreignColumn}`),
        (db as any).selectFrom(table.name)
      );

    // Filters AND the free-text search. Both narrow the same base, so the count and the
    // page of rows stay in agreement.
    const term = body.search?.trim();
    const constrain = (q: any): any => {
      const filtered = body.filters.reduce((acc, f) => applyFilter(acc, table, f), q);
      return term ? applySearch(filtered, table, term) : filtered;
    };

    // An explicit select list, not selectAll(): across a join, `friend` and `upload` both
    // have `id`, `source`, `created_at` and `updated_at`, and selectAll() would collapse
    // each pair into one — silently handing back the wrong table's value.
    const selection = table.columns.map((col) =>
      col.derived ? `${columnRef(table, col)} as ${col.name}` : columnRef(table, col)
    );

    const sortCol = columnRef(table, body.sort ? getColumn(table, body.sort.column) : pk);
    const sortDir = body.sort?.direction ?? "asc";

    const [data, countRow] = await Promise.all([
      constrain(base().select(selection))
        .orderBy(sortCol, sortDir)
        .limit(body.limit)
        .offset(offset)
        .execute() as Promise<DbRow[]>,
      constrain(base().select((db as any).fn.count(columnRef(table, pk)).as("count")))
        .executeTakeFirst() as Promise<{ count: number | string | bigint } | undefined>,
    ]);

    const total = Number(countRow?.count) || 0;
    return {
      data,
      pagination: { page: body.page, limit: body.limit, total, totalPages: Math.ceil(total / body.limit) },
    };
  }

  static async insertRow(tableName: string, values: Record<string, unknown>): Promise<DbRow> {
    const table = getTable(tableName);
    const data = buildValues(table, values, true);
    const db = await this.getKyselyDB();
    const row = await (db as any)
      .insertInto(table.name)
      .values(data)
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as DbRow;
  }

  static async updateRow(tableName: string, id: string, values: Record<string, unknown>): Promise<DbRow> {
    const table = getTable(tableName);
    const pk = getPrimaryKey(table);
    const data = buildValues(table, values, false);
    const db = await this.getKyselyDB();
    const row = await (db as any)
      .updateTable(table.name)
      .set(data)
      .where(pk.name, "=", coerceKey(pk, id))
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFound("Row not found");
    return row as DbRow;
  }

  static async deleteRow(tableName: string, id: string): Promise<number> {
    const table = getTable(tableName);
    const pk = getPrimaryKey(table);
    const db = await this.getKyselyDB();
    const result = await (db as any)
      .deleteFrom(table.name)
      .where(pk.name, "=", coerceKey(pk, id))
      .executeTakeFirst();
    const deleted = Number(result?.numDeletedRows ?? 0);
    if (deleted === 0) throw new NotFound("Row not found");
    return deleted;
  }
}
