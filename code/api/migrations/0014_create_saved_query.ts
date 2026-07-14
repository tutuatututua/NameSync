import { Kysely, sql } from "kysely";

/**
 * saved_query — a named query you can re-run from the Database console.
 *
 * Two flavours share the table:
 *   kind='sql'      sql_text holds a read-only SELECT typed into the SQL editor
 *   kind='builder'  spec holds the visual builder's {table, filters, sort} as JSON
 *
 * `ifNotExists` because the redesign tables are also created out-of-band by
 * docs/schema-redesign.sql (which the test harness applies); whichever runs first wins
 * and the other is a no-op.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("saved_query")
    .ifNotExists()
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    .addColumn("name", "varchar(255)", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("sql_text", "text")
    .addColumn("spec", "jsonb")
    .addColumn("created_by", "varchar(255)")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("saved_query_kind_check", sql`kind in ('sql', 'builder')`)
    .execute();

  await db.schema
    .createIndex("idx_saved_query_created")
    .ifNotExists()
    .on("saved_query")
    .column("created_at")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("saved_query").ifExists().execute();
}
