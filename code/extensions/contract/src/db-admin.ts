import { z } from 'zod';
import { PaginationQuerySchema } from './common';

/**
 * The Database console: browse/insert/edit/delete rows in the tables the API chooses
 * to expose, run a read-only SELECT, and save a query to re-run later.
 *
 * The server owns the allowlist (api/src/lib/table-registry.ts). The client never
 * names a table or column that didn't come back from GET /api/db/tables, and the
 * server re-checks every identifier anyway — nothing here is trusted.
 */

// ── Schema metadata (drives the whole UI) ───────────────────────────────────

export const ColumnTypeSchema = z.enum(['string', 'number', 'boolean', 'timestamp', 'json']);
export type ColumnType = z.infer<typeof ColumnTypeSchema>;

export const DbColumnSchema = z.object({
  name: z.string(),
  /** Human-readable header ("Thai name" for person_name_th). Falls back to the name. */
  label: z.string(),
  type: ColumnTypeSchema,
  nullable: z.boolean(),
  /** False for generated ids, created_at/updated_at, and joined columns — shown, never written. */
  editable: z.boolean(),
  /** NOT NULL *and* no database default — the insert form must supply a value. */
  required: z.boolean(),
  pk: z.boolean(),
  /** Allowed values where the column has a CHECK constraint (renders as a dropdown). */
  enumValues: z.array(z.string()).optional(),
});
export type DbColumn = z.infer<typeof DbColumnSchema>;

export const DbTableSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  columns: z.array(DbColumnSchema),
  /**
   * The import that feeds this table, if any. The console renders the matching Import /
   * Clear-all controls for it — so the client still names no table of its own: the server
   * says "`company_contact` is fed by the company import" and the UI follows.
   */
  importSource: z.enum(['company', 'facebook']).optional(),
});
export type DbTable = z.infer<typeof DbTableSchema>;

/** GET /api/db/tables */
export const DbTablesDataSchema = z.object({ tables: z.array(DbTableSchema) });
export type DbTablesData = z.infer<typeof DbTablesDataSchema>;

// ── Rows ────────────────────────────────────────────────────────────────────

/** A row is just an object keyed by column name — the shape varies per table. */
export const DbRowSchema = z.record(z.unknown());
export type DbRow = z.infer<typeof DbRowSchema>;

export const FilterOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'is_null',
  'is_not_null',
  'in',
]);
export type FilterOperator = z.infer<typeof FilterOperatorSchema>;

export const FilterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);
export type FilterValue = z.infer<typeof FilterValueSchema>;

export const DbFilterSchema = z.object({
  column: z.string().min(1),
  op: FilterOperatorSchema,
  /** Omitted for is_null / is_not_null; an array for `in`. */
  value: FilterValueSchema.optional(),
});
export type DbFilter = z.infer<typeof DbFilterSchema>;

export const DbSortSchema = z.object({
  column: z.string().min(1),
  direction: z.enum(['asc', 'desc']),
});
export type DbSort = z.infer<typeof DbSortSchema>;

/** POST /api/db/tables/:table/query — a POST so the filters travel as JSON, not a query string. */
export const TableQueryBodySchema = PaginationQuerySchema.extend({
  filters: z.array(DbFilterSchema).max(20).default([]),
  sort: DbSortSchema.optional(),
  /**
   * Free-text search — one box the server matches as a case-insensitive substring against
   * every text column at once. Independent of `filters`: a search narrows within them.
   */
  search: z.string().trim().max(200).optional(),
});
export type TableQueryBody = z.infer<typeof TableQueryBodySchema>;

export const TableParamSchema = z.object({ table: z.string().min(1) });
export type TableParam = z.infer<typeof TableParamSchema>;

export const TableRowParamSchema = z.object({ table: z.string().min(1), id: z.string().min(1) });
export type TableRowParam = z.infer<typeof TableRowParamSchema>;

/** POST / PATCH /api/db/tables/:table/rows — `values` is keyed by column name. */
export const RowValuesBodySchema = z.object({ values: z.record(z.unknown()) });
export type RowValuesBody = z.infer<typeof RowValuesBodySchema>;

export const DeletedDataSchema = z.object({ deleted: z.number() });
export type DeletedData = z.infer<typeof DeletedDataSchema>;

// ── SQL console ─────────────────────────────────────────────────────────────

/** POST /api/db/sql — one read-only SELECT. The server refuses anything else. */
export const SqlQueryBodySchema = z.object({
  sql: z.string().trim().min(1, 'Enter a query').max(20_000, 'Query is too long'),
});
export type SqlQueryBody = z.infer<typeof SqlQueryBodySchema>;

/**
 * Rows come back as arrays, not objects, and `columns` carries the real SELECT order.
 * `SELECT *` across a join can legitimately produce two columns with the same name —
 * an object would silently drop one of them.
 */
export const SqlResultSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number(),
  /** The row cap was hit — there are more rows than these. */
  truncated: z.boolean(),
  elapsedMs: z.number(),
});
export type SqlResult = z.infer<typeof SqlResultSchema>;

// ── Saved queries ───────────────────────────────────────────────────────────

export const SavedQueryKindSchema = z.enum(['sql', 'builder']);
export type SavedQueryKind = z.infer<typeof SavedQueryKindSchema>;

/** The visual builder's state, saved verbatim so loading it restores the filter bar. */
export const BuilderSpecSchema = z.object({
  table: z.string().min(1),
  filters: z.array(DbFilterSchema).max(20).default([]),
  sort: DbSortSchema.optional(),
});
export type BuilderSpec = z.infer<typeof BuilderSpecSchema>;

export const SavedQueryRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  sql_text: z.string().nullable(),
  spec: z.unknown().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SavedQueryRow = z.infer<typeof SavedQueryRowSchema>;

export const CreateSavedQueryBodySchema = z
  .object({
    name: z.string().trim().min(1, 'Name the query').max(255),
    kind: SavedQueryKindSchema,
    sql_text: z.string().trim().min(1).max(20_000).optional(),
    spec: BuilderSpecSchema.optional(),
  })
  .refine((b) => (b.kind === 'sql' ? !!b.sql_text : !!b.spec), {
    message: "A 'sql' query needs sql_text; a 'builder' query needs spec",
  });
export type CreateSavedQueryBody = z.infer<typeof CreateSavedQueryBodySchema>;

export const UpdateSavedQueryBodySchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  sql_text: z.string().trim().min(1).max(20_000).optional(),
  spec: BuilderSpecSchema.optional(),
});
export type UpdateSavedQueryBody = z.infer<typeof UpdateSavedQueryBodySchema>;
