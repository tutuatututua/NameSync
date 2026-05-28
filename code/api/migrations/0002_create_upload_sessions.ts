import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("upload_sessions")
    .addColumn("id", "varchar(36)", (col) => col.primaryKey())
    .addColumn("name", "varchar(255)")
    .addColumn("linkedin_file_path", "varchar(500)")
    .addColumn("facebook_file_path", "varchar(500)")
    .addColumn("mode", "varchar(20)")
    .addColumn("parent_session_id", "varchar(36)", (col) =>
      col.references("upload_sessions.id").onDelete("set null")
    )
    .addColumn("status", "varchar(20)", (col) => col.notNull().defaultTo("pending"))
    .addColumn("created_at", "text")
    .addColumn("updated_at", "text")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("upload_sessions").execute();
}
