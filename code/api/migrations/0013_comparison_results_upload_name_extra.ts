import { Kysely } from "kysely";

/**
 * The comparison results now surface the uploader who has a potential connection
 * to the selected company, plus any additional fields the external matcher returns.
 *  - upload_name  the connected uploader, when the matcher provides it (otherwise
 *                 derived at read time from facebook_data.upload_person_name).
 *  - extra        JSON blob of any non-standard fields from the callback payload.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("comparison_results")
    .addColumn("upload_name", "varchar(255)")
    .addColumn("extra", "text")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("comparison_results")
    .dropColumn("upload_name")
    .dropColumn("extra")
    .execute();
}
