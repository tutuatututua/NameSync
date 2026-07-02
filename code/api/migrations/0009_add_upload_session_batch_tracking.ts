import { Kysely } from "kysely";

/**
 * Persist the declared total batch count for a comparison on the session row.
 *
 * Previously this lived in a module-scope `Map` in comparison-results.model.ts, so
 * it was lost on restart, unbounded, and wrong across instances. Storing it here lets
 * completion be judged against the real declared total, durably.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("upload_sessions")
    .addColumn("expected_batches", "integer")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("upload_sessions")
    .dropColumn("expected_batches")
    .execute();
}
