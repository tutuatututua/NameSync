import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Create upload_history table for per-source tracking
  await db.schema
    .createTable("upload_history")
    .addColumn("id", "varchar(36)", (col) => col.primaryKey())
    .addColumn("source_type", "varchar(20)", (col) => col.notNull()) // 'facebook' | 'company'
    .addColumn("user_upload", "varchar(255)", (col) => col.notNull())
    .addColumn("timestamp", "text", (col) => col.notNull())
    .addColumn("rows_processed", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("duplicate_rows", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("session_id", "varchar(36)", (col) =>
      col.references("upload_sessions.id").onDelete("set null")
    )
    .addColumn("created_at", "text")
    .execute();

  // Create index for source_type queries
  await db.schema
    .createIndex("idx_upload_history_source_type")
    .on("upload_history")
    .column("source_type")
    .execute();

  // Create index for timestamp-based queries (recent uploads first)
  await db.schema
    .createIndex("idx_upload_history_timestamp")
    .on("upload_history")
    .column("timestamp")
    .execute();

  // Create composite index for source + timestamp queries
  await db.schema
    .createIndex("idx_upload_history_source_timestamp")
    .on("upload_history")
    .columns(["source_type", "timestamp"])
    .execute();

  // Add unique constraints to facebook_data for merge semantics
  // Business key: fb_name + upload_person_name
  await db.schema
    .createIndex("idx_facebook_data_unique")
    .on("facebook_data")
    .columns(["fb_name", "upload_person_name"])
    .unique()
    .execute();

  // Add unique constraints to company_data for merge semantics
  // Business key: company_name + person_name_en + person_name_th
  await db.schema
    .createIndex("idx_company_data_unique")
    .on("company_data")
    .columns(["company_name", "person_name_en", "person_name_th"])
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Drop unique indexes
  await db.schema
    .dropIndex("idx_company_data_unique")
    .ifExists()
    .execute();

  await db.schema
    .dropIndex("idx_facebook_data_unique")
    .ifExists()
    .execute();

  // Drop upload_history indexes
  await db.schema
    .dropIndex("idx_upload_history_source_timestamp")
    .ifExists()
    .execute();

  await db.schema
    .dropIndex("idx_upload_history_timestamp")
    .ifExists()
    .execute();

  await db.schema
    .dropIndex("idx_upload_history_source_type")
    .ifExists()
    .execute();

  // Drop upload_history table
  await db.schema.dropTable("upload_history").execute();
}
