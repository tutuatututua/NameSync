import { Kysely } from "kysely";

/**
 * Track who uploaded each company row, mirroring facebook_data.upload_person_name,
 * so both tables record their upload user.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("company_data")
    .addColumn("upload_person_name", "varchar(255)")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("company_data")
    .dropColumn("upload_person_name")
    .execute();
}
