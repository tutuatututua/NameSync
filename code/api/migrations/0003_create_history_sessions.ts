import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("history_sessions")
    .addColumn("id", "varchar(36)", (col) => col.primaryKey())
    .addColumn("name", "varchar(255)", (col) => col.notNull())
    .addColumn("comparison_id", "varchar(36)")
    .addColumn("user_id", "varchar(36)", (col) => col.notNull())
    .addColumn("row_count", "integer")
    .addColumn("mean_confidence", "real")
    .addColumn("results", "text")
    .addColumn("created_at", "text")
    .addColumn("updated_at", "text")
    .execute();

  // Create indexes for better query performance
  await db.schema
    .createIndex("idx_history_user_created")
    .on("history_sessions")
    .columns(["user_id", "created_at"])
    .execute();

  await db.schema
    .createIndex("idx_history_name")
    .on("history_sessions")
    .column("name")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("idx_history_user_created").ifExists().execute();
  await db.schema.dropIndex("idx_history_name").ifExists().execute();
  await db.schema.dropTable("history_sessions").execute();
}
