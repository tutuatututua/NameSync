import { Kysely } from "kysely";

/**
 * The comparison results now surface the uploader who has a potential connection
 * to the selected company, plus any additional fields the external matcher returns.
 *  - upload_name  the connected uploader, when the matcher provides it (otherwise
 *                 derived at read time from facebook_data.upload_person_name).
 *  - extra        JSON blob of any non-standard fields from the callback payload.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // SQLite only allows one ADD COLUMN per ALTER TABLE statement, so run each separately.
  await db.schema
    .alterTable("comparison_results")
    .addColumn("upload_name", "varchar(255)")
    .execute();
  await db.schema
    .alterTable("comparison_results")
    .addColumn("extra", "text")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // SQLite only allows one DROP COLUMN per ALTER TABLE statement, so run each separately.
  await db.schema.alterTable("comparison_results").dropColumn("upload_name").execute();
  await db.schema.alterTable("comparison_results").dropColumn("extra").execute();
}
