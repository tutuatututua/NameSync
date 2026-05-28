import { Kysely } from "kysely";

/**
 * Migration 0006 added global UNIQUE indexes on facebook_data(fb_name,
 * upload_person_name) and company_data(company_name, person_name_en,
 * person_name_th). Both are broken:
 *   - facebook_data: not scoped to session_id and inserted without ON CONFLICT,
 *     so duplicate friend names within a file (or re-uploading with the same
 *     upload_person_name) throws a UNIQUE violation and fails the whole upload.
 *   - company_data: includes person_name_en which the parser always sets to NULL;
 *     SQLite treats NULLs as distinct, so the constraint enforces nothing.
 *
 * The promised "merge" upsert was never implemented, so these indexes only cause
 * harm. Drop them to restore working uploads.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("idx_facebook_data_unique").ifExists().execute();
  await db.schema.dropIndex("idx_company_data_unique").ifExists().execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .createIndex("idx_facebook_data_unique")
    .on("facebook_data")
    .columns(["fb_name", "upload_person_name"])
    .unique()
    .execute();

  await db.schema
    .createIndex("idx_company_data_unique")
    .on("company_data")
    .columns(["company_name", "person_name_en", "person_name_th"])
    .unique()
    .execute();
}
