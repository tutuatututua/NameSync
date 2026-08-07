import type { ColumnType, DbColumn, DbTable } from "@extensions/contract";
import { ROW_QUEUED, ROW_PENDING, ROW_MATCH, ROW_UNMATCH, COMPARE_BY_VALUES } from "@extensions/contract";
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
 * What the external workflow has said about one uploaded row (docs/EXTERNAL-MATCHER.md).
 * Not a CHECK constraint — the workflow can store anything, and the console will show it —
 * so this is the pick-list, not a guarantee. Built from the contract's constants so the console
 * cannot start offering a spelling the verdict rule doesn't know.
 */
const ROW_STATUS = [ROW_PENDING, ROW_MATCH, ROW_UNMATCH, "failed"];

/** Same, for `comparison_result` — which additionally starts at 'pending', since a workflow may
 *  insert a result row before it has decided it. */
const RESULT_STATUS = [ROW_QUEUED, ROW_PENDING, ROW_MATCH, ROW_UNMATCH, "failed"];

/** The row's verdict, as the workflow writes it. It used to be picked at module load against
 *  isExternalMatcher(), because `status` only existed once a migration had been applied by hand
 *  and `fetched` was the internal matcher's answer to the same question. `fetched` is gone and
 *  `status` is unconditional in schema-redesign.sql, so there is nothing left to choose. */
const verdict = (): RegistryColumn =>
  c("status", "string", { label: "Status", nullable: false, enumValues: ROW_STATUS });

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
      // Who performed the import. Not the relationship owner — that is per friend row
      // (friend.relationship_owner) since 2026-07-27, because one file can carry several.
      c("uploaded_by", "string", { label: "Uploaded by" }),
      c("total_records", "number", { label: "Total records", nullable: false }),
      c("duplicate_records", "number", { label: "Duplicates", nullable: false }),
      createdAt(),
      updatedAt(),
    ],
  },
  {
    name: "upload_source",
    label: "Import types",
    description:
      "The pick-list behind an import's type. Nothing has a foreign key into it, so removing a row only takes the option off the picker.",
    columns: [
      idCol(),
      c("value", "string", { label: "Value", nullable: false, required: true }),
      c("label", "string", { label: "Label", nullable: false, required: true }),
      c("created_by", "string", { label: "Added by" }),
      createdAt(),
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
      c("person_name_th", "string", { label: "Thai name" }),
      c("person_name_en", "string", { label: "English name" }),
      // WHICH CONTACT this row is about — shared by every copy of them. Imports stack, so the same
      // person imported twice is two rows here, and this is the only thing on the row that says so.
      // Shown because a console session asking "why do I see this contact twice / why is the count
      // 1 when there are 2 rows" is answered by exactly this column.
      //
      // READ-ONLY. Editing it re-decides who somebody IS — merging two people or splitting one —
      // which silently moves every count, roster and connection that folds on it. The importer
      // assigns it from the names, and that is the one place the rule lives.
      c("person_key", "string", { label: "Person key", editable: false }),
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
    label: "Friends",
    description: "Friends and social contacts. Each row belongs to the upload that added it.",
    importSource: "facebook",
    joins: [UPLOAD_JOIN],
    columns: [
      idCol(),
      // A column per language, symmetric with company_contact. Editable, because this console
      // is the deliberate, visible way to change a stored name — an IMPORT may only fill a null
      // spelling and never overwrite one (see FriendModel.mergeUpload), and that restriction
      // exists so an import cannot silently orphan result rows that resolve back by name. A
      // human doing it here is making that trade knowingly.
      c("friend_name_en", "string", { label: "Name (English)" }),
      c("friend_name_th", "string", { label: "Name (Thai)" }),
      // The pre-2026-07-28 single `friend_name` was listed here, read-only and labelled "(legacy)",
      // until 2026-07-28b-drop-friend-name.sql removed the column. `comparison_result` carried a
      // `friend_name` of its own — same name, different fact (the spelling a run actually scored) —
      // and that one is gone too, as of 2026-08-03c.
      // Whose relationship this is — the row's OWN column since 2026-07-27, not the joined
      // `uploaded_by` beneath it. Editable here on purpose: re-filing a friend under the
      // right colleague is the one correction this table exists to make, and it moves the
      // row between rosters (the dedup key is (owner, name)) rather than merely relabelling it.
      c("relationship_owner", "string", { label: "Relationship owner" }),
      // Which PERSON this row is about — see the company_contact twin. Read-only for the same
      // reason, and note the interaction with the editable columns above it: changing a name or an
      // owner here does NOT re-decide identity, so a friend re-filed under another colleague keeps
      // the key they had. That is usually what you want (it is the same person, moved) and it is
      // worth knowing it is what happens.
      c("person_key", "string", { label: "Person key", editable: false }),
      uploadedBy(),
      c("source", "string", { label: "Type", nullable: false, required: true }),
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
      /**
       * text[], surfaced read-only.
       *
       * `json` is the closest the console's type system gets to an array, and it is close enough
       * to *read*: node-postgres hands a text[] back as a JS array and the grid renders it. It is
       * not close enough to write — the JSON editor would accept `{"a":1}` just as happily as
       * `["PTT"]` and hand Postgres an object for a text[] column. So `editable: false`, which is
       * the same guarantee the joined columns rely on: shown, never written.
       *
       * Adding a real `array` ColumnType would mean teaching the editor, the filters and the
       * coercion about arrays — a fair amount of console for one column that is only ever written
       * by the compare route.
       */
      c("selected_companies", "json", { label: "Companies", editable: false }),
      /**
       * Which friends the run covered — `text[]`, NULL for every source.
       *
       * Read-only for the same two reasons `selected_companies` above is: node-postgres hands a
       * text[] back as a JS array the grid renders fine, and the JSON editor cannot tell `["a"]`
       * from `{"a":1}` on the way back in. There is a third reason here — like `compare_by` below,
       * this describes what a finished run ALREADY DID. Editing it would relabel a run as having
       * covered a population it never looked at, and every count on the run page reads this column
       * to size its own denominator.
       *
       * Was a scalar `source varchar(100)` until 2026-08-03d. Nothing ever wrote it.
       */
      c("sources", "json", { label: "Sources", editable: false }),
      c("status", "string", { label: "Status", nullable: false, enumValues: COMPARISON_STATUS }),
      /**
       * How the run compared — `'<script>_<part>'`. Read-only, and that is the point: a run's
       * mode describes what already happened, and editing it here would not re-run anything.
       * It would just relabel a finished run as having asked a question it never asked, which
       * is worse than an unhelpful label — every reader of this column treats it as the
       * provenance of the verdicts beneath it.
       *
       * NULL reads as the default everywhere, so the grid showing a blank here is showing the
       * truth rather than a gap.
       */
      c("compare_by", "string", { label: "Compared by", editable: false, enumValues: [...COMPARE_BY_VALUES] }),
      /**
       * Who started the run. Read-only, and for a stronger reason than the two above.
       *
       * `sources` and `compare_by` are read-only because editing them would relabel what a finished
       * run DID. This is a record of who DID it, and it is what the Audit trail attributes a run to
       * — an editable field there is a record of an act that can be quietly reassigned to somebody
       * else, from a console that logs nothing. Provenance is the one kind of column a data browser
       * should not hand you a pencil for.
       *
       * NULL is legitimate and reads as "nobody on file": a run predating the column (2026-08-04),
       * or one created through this console, which writes no actor. The trail then falls back to
       * the uploader of the import that opened the run, and shows nothing if there is none.
       */
      c("created_by", "string", { label: "Started by", editable: false }),
      c("expected_batches", "number", { label: "Expected batches" }),
      createdAt(),
      updatedAt(),
    ],
  },
  {
    name: "comparison_result",
    label: "Comparison results",
    description: "The matches a compare run produced.",
    joins: [{ table: "comparison", localColumn: "comparison_id", foreignColumn: "id" }],
    columns: [
      idCol(),
      joined("comparison_name", "string", "comparison", "name", "Comparison"),
      c("comparison_id", "number", { label: "Comparison ID", nullable: false, required: true }),
      // The friend's two spellings as the run recorded them. Frozen evidence of what was
      // compared, which is why they are text here and not a lookup through `friend_id`. A third
      // column, `friend_name`, held the one spelling the run scored until 2026-08-03c; which of
      // these two that was is read off the run's `compare_by` now.
      c("friend_name_en", "string", { label: "Friend name (English)" }),
      c("friend_name_th", "string", { label: "Friend name (Thai)" }),
      c("person_name_en", "string", { label: "English name" }),
      c("person_name_th", "string", { label: "Thai name" }),
      // IDENTITY, for counting only — never resolve a display name through these. Read-only:
      // hand-editing an identity link would silently move a run's history onto a different
      // person, and the text columns beside them are what the UI actually renders.
      c("friend_id", "number", { label: "Friend ID", editable: false }),
      c("company_contact_id", "number", { label: "Contact ID", editable: false }),
      c("batch_number", "number", { label: "Batch" }),
      c("status", "string", { label: "Status", nullable: false, enumValues: RESULT_STATUS }),
      // Sort/display only — in [0, 1], NULL when unrecorded. Never the verdict; `status` is.
      c("similarity", "number", { label: "Similarity" }),
      // NOT the upload, despite the name, and not reliably the owner either — it is whatever the
      // matcher claimed the owner was. Labelled for what it is: nothing groups by it any more (see
      // models/network.model.ts), so a console reader must not take it for the answer to "whose
      // friend is this". That lives on `friend.relationship_owner`.
      c("upload_name", "string", { label: "Owner (as matcher reported)" }),
      c("company_name", "string", { label: "Company" }),
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
