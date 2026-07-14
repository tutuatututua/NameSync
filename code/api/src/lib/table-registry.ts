import type { ColumnType, DbColumn, DbTable } from "@extensions/contract";
import { isExternalMatcher } from "../config/env";
import { BadRequest, NotFound } from "./errors";

/**
 * The allowlist for the Database console — the single source of truth for which tables
 * and columns the row editor can touch, and what each column holds.
 *
 * This is the security boundary. The console builds SQL from a table name and column
 * names supplied by the browser; every one of them is resolved through here first, so a
 * name that isn't in this file cannot reach the database. Values are always passed as
 * Kysely parameters and never interpolated, so the registry only has to guard
 * *identifiers* — but it has to guard them completely.
 *
 * Mirrors docs/schema-redesign.sql. Keep the two in step: a column that exists in the
 * DB but not here is simply invisible to the console (safe), while one that's here but
 * not in the DB is an error at query time (loud).
 *
 * Deliberately excluded: `history_sessions` (its `results` column is a giant JSON blob —
 * meaningless in a grid) and `saved_query` (it has its own UI). Both remain readable
 * through the SQL console.
 */

interface ColOpts {
  /** Header shown in the grid. Defaults to the raw column name. */
  label?: string;
  nullable?: boolean;
  editable?: boolean;
  /** NOT NULL and no DB default → the insert must supply it. */
  required?: boolean;
  pk?: boolean;
  enumValues?: string[];
}

/**
 * A column that lives on a *joined* table, surfaced read-only under an alias.
 *
 * `friend` and `company_contact` only carry `upload_id`; who actually uploaded a row is
 * `upload.uploaded_by`. That column is the reason a person can make sense of these tables
 * at all, so the console resolves it through a LEFT JOIN rather than making everyone
 * pivot through the Uploads table by hand.
 */
interface Derived {
  /** The joined table the value comes from. */
  from: string;
  /** The column on that table (the registry column's own `name` is the alias). */
  column: string;
}

interface RegistryColumn extends DbColumn {
  derived?: Derived;
}

interface Join {
  table: string;
  /** `<base>.<localColumn> = <table>.<foreignColumn>` */
  localColumn: string;
  foreignColumn: string;
}

interface RegistryTable extends DbTable {
  columns: RegistryColumn[];
  joins?: Join[];
}

const c = (name: string, type: ColumnType, o: ColOpts = {}): RegistryColumn => ({
  name,
  label: o.label ?? name,
  type,
  nullable: o.nullable ?? true,
  editable: o.editable ?? true,
  required: o.required ?? false,
  pk: o.pk ?? false,
  ...(o.enumValues ? { enumValues: o.enumValues } : {}),
});

/** A read-only column pulled in over a join. Never writable — `editable: false` is what
 *  stops a write reaching a table the row doesn't belong to. */
const joined = (alias: string, type: ColumnType, from: string, column: string, label: string): RegistryColumn => ({
  ...c(alias, type, { label, editable: false }),
  derived: { from, column },
});

/** Generated bigint identity key — displayed, never written. */
const idCol = (): RegistryColumn => c("id", "number", { label: "ID", nullable: false, editable: false, pk: true });

/** Database-managed timestamps — displayed, never written (a trigger owns updated_at). */
const createdAt = (): RegistryColumn =>
  c("created_at", "timestamp", { label: "Created", nullable: false, editable: false });
const updatedAt = (): RegistryColumn =>
  c("updated_at", "timestamp", { label: "Updated", nullable: false, editable: false });

/** The two columns every upload-owned table borrows from `upload`, so a row is legible
 *  without pivoting to the Uploads table. */
const UPLOAD_JOIN: Join = { table: "upload", localColumn: "upload_id", foreignColumn: "id" };
const uploadedBy = (): RegistryColumn => joined("uploaded_by", "string", "upload", "uploaded_by", "Uploaded by");
const uploadName = (): RegistryColumn => joined("upload_name", "string", "upload", "name", "Upload");

const UPLOAD_STATUS = ["pending", "processing", "pending_webhook", "completed", "failed", "rolled_back"];
const COMPARISON_STATUS = ["pending", "processing", "completed", "failed"];

/**
 * What the external workflow has said about one data row (docs/EXTERNAL-MATCHER.md).
 * Not a CHECK constraint — the workflow can store anything, and the console will show it —
 * so this is the pick-list, not a guarantee.
 */
const ROW_STATUS = ["processing", "match", "unmatch", "complete"];

/**
 * The row's verdict — the column the workflow writes, surfaced in place of `fetched`.
 *
 * These two columns answer the same question ("is this row done?") for the two matchers, and
 * only one matcher is ever live. `fetched` is the internal one's boolean; `status` is the
 * workflow's verdict, and it says *what* the verdict was rather than merely that there was one.
 *
 * Which one the console shows is decided here, at module load, on the same flag the models
 * use — and it has to be, because `status` only exists once docs/migrations/2026-07-14-row-status.sql
 * has been applied by hand. Naming it with the flag off would put a column that isn't there
 * into every SELECT the console builds.
 */
const verdict = (): RegistryColumn =>
  isExternalMatcher()
    ? c("status", "string", { label: "Status", nullable: false, enumValues: ROW_STATUS })
    : c("fetched", "boolean", { label: "Fetched", nullable: false });

const TABLES: RegistryTable[] = [
  {
    name: "upload",
    label: "Uploads",
    description: "One import event — a company CSV or a social JSON. Deleting one cascades to its rows.",
    columns: [
      idCol(),
      c("name", "string", { label: "Name" }),
      c("kind", "string", { label: "Kind", nullable: false, required: true, enumValues: ["company", "social"] }),
      c("source", "string", { label: "Source" }),
      c("status", "string", { label: "Status", nullable: false, enumValues: UPLOAD_STATUS }),
      c("mode", "string", { label: "Mode", enumValues: ["fresh", "continue"] }),
      c("uploaded_by", "string", { label: "Uploaded by" }),
      c("total_records", "number", { label: "Total records", nullable: false }),
      c("duplicate_records", "number", { label: "Duplicates", nullable: false }),
      createdAt(),
      updatedAt(),
    ],
  },
  {
    name: "company_contact",
    label: "Company data",
    description: "Company people. Each row belongs to the upload that added it.",
    importSource: "company",
    joins: [UPLOAD_JOIN],
    columns: [
      idCol(),
      c("company_name", "string", { label: "Company" }),
      c("person_name_th", "string", { label: "Thai name (raw)" }),
      c("person_name_en", "string", { label: "English name (raw)" }),
      uploadedBy(),
      uploadName(),
      c("upload_id", "number", { label: "Upload ID", nullable: false, required: true }),
      verdict(),
      createdAt(),
      updatedAt(),
    ],
  },
  {
    name: "friend",
    label: "Facebook data",
    description: "Social contacts. Each row belongs to the upload that added it.",
    importSource: "facebook",
    joins: [UPLOAD_JOIN],
    columns: [
      idCol(),
      c("friend_name", "string", { label: "Facebook name (raw)" }),
      uploadedBy(),
      c("source", "string", { label: "Source", nullable: false, required: true }),
      c("source_timestamp", "timestamp", { label: "Added" }),
      uploadName(),
      c("upload_id", "number", { label: "Upload ID", nullable: false, required: true }),
      verdict(),
      createdAt(),
      updatedAt(),
    ],
  },
  {
    name: "comparison",
    label: "Comparisons",
    description: "One compare run. Deleting one cascades to its results.",
    columns: [
      idCol(),
      c("name", "string", { label: "Name" }),
      c("selected_company", "string", { label: "Company" }),
      c("source", "string", { label: "Source" }),
      c("status", "string", { label: "Status", nullable: false, enumValues: COMPARISON_STATUS }),
      c("expected_batches", "number", { label: "Expected batches" }),
      createdAt(),
      updatedAt(),
    ],
  },
  {
    name: "comparison_result",
    label: "Comparison results",
    description: "The scored matches a compare run produced.",
    joins: [{ table: "comparison", localColumn: "comparison_id", foreignColumn: "id" }],
    columns: [
      idCol(),
      joined("comparison_name", "string", "comparison", "name", "Comparison"),
      c("comparison_id", "number", { label: "Comparison ID", nullable: false, required: true }),
      c("friend_name", "string", { label: "Facebook name" }),
      c("person_name_en", "string", { label: "English name" }),
      c("person_name_th", "string", { label: "Thai name" }),
      c("matching_score", "number", { label: "Score" }),
      c("batch_number", "number", { label: "Batch" }),
      c("is_complete", "boolean", { label: "Complete", nullable: false }),
      c("upload_name", "string", { label: "Upload" }),
      c("extra", "json", { label: "Extra" }),
      createdAt(),
    ],
  },
];

const BY_NAME = new Map(TABLES.map((t) => [t.name, t]));

export type { RegistryColumn, RegistryTable };

export const listTables = (): RegistryTable[] => TABLES;

/** Resolve a client-supplied table name, or 404. */
export function getTable(name: string): RegistryTable {
  const table = BY_NAME.get(name);
  if (!table) throw new NotFound(`Unknown table "${name}"`);
  return table;
}

/** Resolve a client-supplied column name within a table, or 400. */
export function getColumn(table: RegistryTable, name: string): RegistryColumn {
  const col = table.columns.find((x) => x.name === name);
  if (!col) throw new BadRequest(`Unknown column "${name}" on "${table.name}"`);
  return col;
}

/** The primary key column (always `id` today, but resolved rather than assumed). */
export function getPrimaryKey(table: RegistryTable): RegistryColumn {
  const pk = table.columns.find((x) => x.pk);
  if (!pk) throw new BadRequest(`Table "${table.name}" has no primary key`);
  return pk;
}

/**
 * The SQL reference for a column — `upload.uploaded_by` for a joined one, `friend.source`
 * for the table's own. Always qualified: once a join is in play a bare `id` or `source`
 * is ambiguous, and Postgres would reject it.
 */
export function columnRef(table: RegistryTable, col: RegistryColumn): string {
  return col.derived ? `${col.derived.from}.${col.derived.column}` : `${table.name}.${col.name}`;
}
