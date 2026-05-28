import { Kysely } from "kysely";

/**
 * Add a nullable `status` column to facebook_data.
 *
 * NULL means the row has not yet been pushed to FACEBOOK_WEBHOOK_URL. After a
 * successful ingestion-webhook send the row is marked 'sent', so re-uploads only
 * forward genuinely new (unprocessed) friends instead of the whole table.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("facebook_data")
    .addColumn("status", "varchar(50)")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("facebook_data")
    .dropColumn("status")
    .execute();
}
