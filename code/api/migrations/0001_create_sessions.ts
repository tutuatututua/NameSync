import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // NOTE: This table is dead — dropped in migration 0005 and never used by app code.
  // `id` is a plain integer PK (no autoIncrement) so the chain also runs on Postgres,
  // whose Kysely dialect rejects autoIncrement().
  await db.schema
    .createTable("sessions")
    .addColumn("id", "integer", (col) => col.primaryKey())
    .addColumn("name", "varchar(255)", (col) => col.notNull())
    .addColumn("row_count", "integer", (col) => col.notNull())
    .addColumn("mean_confidence", "real", (col) => col.notNull())
    .addColumn("results", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("sessions").execute();
}
