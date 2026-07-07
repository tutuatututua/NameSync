import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Drop the legacy sessions table (replaced by upload_sessions with UUID)
  await db.schema.dropTable("sessions").ifExists().execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Recreate the sessions table (for rollback purposes)
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
