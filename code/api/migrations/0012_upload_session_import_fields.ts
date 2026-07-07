import { Kysely } from "kysely";

/**
 * Turn upload_sessions into the "upload session" record the UI groups imports by
 * and can roll back:
 *  - upload_type      'company' | 'facebook' for an import; NULL for a compare run
 *                     (the Company/Facebook discriminator the spec asks for).
 *  - uploaded_by      who ran the import.
 *  - records_uploaded / duplicate_records   counts computed at import time.
 *  - selected_company the company chosen for a compare run (company-selection flow).
 *
 * A rollback deletes the session's data rows and sets status = 'rolled_back'
 * (status stays a plain varchar — no migration needed for the new value).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("upload_sessions")
    .addColumn("upload_type", "varchar(20)")
    .addColumn("uploaded_by", "varchar(255)")
    .addColumn("records_uploaded", "integer")
    .addColumn("duplicate_records", "integer")
    .addColumn("selected_company", "varchar(255)")
    .execute();

  // Import sessions are listed/filtered by type — index it.
  await db.schema
    .createIndex("idx_upload_sessions_upload_type")
    .on("upload_sessions")
    .column("upload_type")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("idx_upload_sessions_upload_type").ifExists().execute();

  await db.schema
    .alterTable("upload_sessions")
    .dropColumn("upload_type")
    .dropColumn("uploaded_by")
    .dropColumn("records_uploaded")
    .dropColumn("duplicate_records")
    .dropColumn("selected_company")
    .execute();
}
