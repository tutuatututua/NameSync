import { DBModel } from "@extensions/sqldb";
import type { CreateSavedQueryBody, UpdateSavedQueryBody } from "@extensions/contract";
import type { SavedQuery } from "../db.types";

/**
 * `saved_query` — a named query you can re-run from the Database console. Either a
 * read-only SELECT (`kind='sql'`, in `sql_text`) or the visual builder's state
 * (`kind='builder'`, in `spec` as jsonb).
 *
 * Saving a query stores it verbatim; it is NOT validated or run here. `sql_text` only
 * ever reaches the database through the read-only console (services/sql-console.service.ts),
 * so a saved query is no more dangerous than a typed one.
 */
export class SavedQueryModel extends DBModel {
  /** Newest first — the console lists them in a sidebar. */
  static async findAll(): Promise<SavedQuery[]> {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("saved_query")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute() as Promise<SavedQuery[]>;
  }

  static async findById(id: string): Promise<SavedQuery | undefined> {
    if (!/^\d+$/.test(id)) return undefined; // bigint PK: a non-numeric id can never match
    const db = await this.getKyselyDB();
    return db
      .selectFrom("saved_query")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst() as Promise<SavedQuery | undefined>;
  }

  static async create(body: CreateSavedQueryBody, createdBy: string | null): Promise<SavedQuery> {
    const db = await this.getKyselyDB();
    const row = await db
      .insertInto("saved_query")
      .values({
        name: body.name,
        kind: body.kind,
        sql_text: body.sql_text ?? null,
        // Object -> jsonb (node-postgres serializes it); null stays null.
        spec: body.spec ?? null,
        created_by: createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as unknown as SavedQuery;
  }

  static async update(id: string, body: UpdateSavedQueryBody): Promise<SavedQuery | undefined> {
    if (!/^\d+$/.test(id)) return undefined;
    const db = await this.getKyselyDB();
    const row = await db
      .updateTable("saved_query")
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.sql_text !== undefined ? { sql_text: body.sql_text } : {}),
        ...(body.spec !== undefined ? { spec: body.spec } : {}),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return row as unknown as SavedQuery | undefined;
  }

  static async deleteById(id: string): Promise<number> {
    if (!/^\d+$/.test(id)) return 0;
    const db = await this.getKyselyDB();
    const result = await db.deleteFrom("saved_query").where("id", "=", id).executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }
}
