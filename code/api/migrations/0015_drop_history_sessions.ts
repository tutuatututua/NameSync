import { Kysely, sql } from "kysely";

/**
 * Drop `history_sessions`.
 *
 * "Past runs" now lists the comparisons themselves (GET /api/comparisons). The snapshot
 * table stored a second, denormalized copy of a run's results — but a run is ALREADY
 * immutable: `comparison_result` holds names and scores as plain text with no FK back to
 * `friend` or `company_contact`, so rolling back an upload or re-importing cannot change
 * a finished run. The copy therefore protected against nothing, and only gave the same
 * data a second shape to fall out of step with (which it did — it was written in
 * snake_case and read in camelCase, and a saved run rendered a table of empty cells).
 *
 * Irreversible in practice: `down` recreates the table, not the rows. Nothing is lost that
 * the `comparison` / `comparison_result` tables do not already hold.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("history_sessions").ifExists().execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("history_sessions")
    .ifNotExists()
    .addColumn("id", "varchar(36)", (col) => col.primaryKey())
    .addColumn("name", "varchar(255)", (col) => col.notNull())
    .addColumn("comparison_id", "varchar(36)")
    .addColumn("user_id", "varchar(36)", (col) => col.notNull())
    .addColumn("row_count", "integer")
    .addColumn("mean_confidence", sql`real`)
    .addColumn("results", "text")
    .addColumn("created_at", "text")
    .addColumn("updated_at", "text")
    .execute();
}
