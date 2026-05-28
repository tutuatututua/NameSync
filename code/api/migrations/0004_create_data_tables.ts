import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Create company_data table
  await db.schema
    .createTable("company_data")
    .addColumn("uuid", "varchar(36)", (col) => col.primaryKey())
    .addColumn("company_name", "varchar(255)")
    .addColumn("person_name_th", "varchar(255)")
    .addColumn("person_name_en", "varchar(255)")
    .addColumn("status", "varchar(50)")
    .addColumn("session_id", "varchar(36)", (col) =>
      col.references("upload_sessions.id").onDelete("cascade")
    )
    .execute();

  // Create facebook_data table
  await db.schema
    .createTable("facebook_data")
    .addColumn("uuid", "varchar(36)", (col) => col.primaryKey())
    .addColumn("fb_name", "varchar(255)")
    .addColumn("timestamp", "varchar(50)")
    .addColumn("upload_person_name", "varchar(255)")
    .addColumn("session_id", "varchar(36)", (col) =>
      col.references("upload_sessions.id").onDelete("cascade")
    )
    .execute();

  // Create comparison_results table
  await db.schema
    .createTable("comparison_results")
    .addColumn("uuid", "varchar(36)", (col) => col.primaryKey())
    .addColumn("fb_name", "varchar(255)")
    .addColumn("person_name_en", "varchar(255)")
    .addColumn("person_name_th", "varchar(255)")
    .addColumn("matching_score", "real")
    .addColumn("batch_number", "integer")
    .addColumn("is_complete", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("session_id", "varchar(36)", (col) =>
      col.references("upload_sessions.id").onDelete("cascade")
    )
    .execute();

  // Create indexes for foreign keys
  await db.schema
    .createIndex("idx_company_data_session_id")
    .on("company_data")
    .column("session_id")
    .execute();

  await db.schema
    .createIndex("idx_facebook_data_session_id")
    .on("facebook_data")
    .column("session_id")
    .execute();

  await db.schema
    .createIndex("idx_comparison_results_session_id")
    .on("comparison_results")
    .column("session_id")
    .execute();

  // Drop linkedin_file_path column from upload_sessions
  await db.schema
    .alterTable("upload_sessions")
    .dropColumn("linkedin_file_path")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Restore linkedin_file_path column
  await db.schema
    .alterTable("upload_sessions")
    .addColumn("linkedin_file_path", "varchar(500)")
    .execute();

  // Drop indexes
  await db.schema
    .dropIndex("idx_comparison_results_session_id")
    .ifExists()
    .execute();

  await db.schema
    .dropIndex("idx_facebook_data_session_id")
    .ifExists()
    .execute();

  await db.schema
    .dropIndex("idx_company_data_session_id")
    .ifExists()
    .execute();

  // Drop tables
  await db.schema.dropTable("comparison_results").execute();
  await db.schema.dropTable("facebook_data").execute();
  await db.schema.dropTable("company_data").execute();
}
