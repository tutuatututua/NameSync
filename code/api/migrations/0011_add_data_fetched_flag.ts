import { Kysely, sql } from "kysely";

/**
 * Track whether each data row has been through a completed comparison ("fetched").
 * New uploads default to false ("new"); a completed comparison flips every row to
 * true ("old"). This drives the old-vs-new breakdown on the Compare Both card.
 *
 * Existing rows predate the flag and were presumably already compared, so backfill
 * them to true rather than surfacing the whole table as "new".
 */
export async function up(db: Kysely<any>): Promise<void> {
  for (const table of ["company_data", "facebook_data"]) {
    await db.schema
      .alterTable(table)
      .addColumn("fetched", "boolean", (col) => col.notNull().defaultTo(false))
      .execute();
    await sql`update ${sql.ref(table)} set fetched = true`.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("company_data").dropColumn("fetched").execute();
  await db.schema.alterTable("facebook_data").dropColumn("fetched").execute();
}
