import { DBModel } from "@extensions/sqldb";
import { sql } from "kysely";
import type { UploadSource } from "@extensions/contract";
import { FriendModel } from "./friend.model";

/**
 * `upload_source` — the pick-list behind an import's "type": where the data came from.
 *
 * This is not a new axis. `upload.source` / `friend.source` already held exactly this vocabulary
 * ('facebook' | 'linkedin'), nothing in the app branches on their contents, and "business card"
 * is a provenance like any other — reading those columns as *export format* described the two
 * values that happened to be in them rather than a rule they enforced. A second column admitting
 * one more value would have been a redundant axis with no way for a reader to know which of the
 * two to trust.
 *
 * So this table constrains the DROPDOWN, not the column, and nothing has a foreign key into it.
 * Two consequences, both deliberate:
 *
 *   · The Database console can still write any string into `upload.source`, and does not fail.
 *   · Deleting an entry is purely cosmetic — rows keep the string they hold and go on grouping
 *     correctly. Which is the only reason it is safe to let anyone add one: a typo is retractable.
 *
 * Every entry is deletable, including the three the schema starts with. An `is_seeded` flag used
 * to make those undeletable because the import path names 'facebook' in code — but with no FK,
 * deleting a value cannot fail a write, and `list` unions this table with the values in use, so
 * a deleted 'facebook' stays in the picker while any import carries it. The flag only had teeth
 * on a database where nothing used the value, which is exactly where dropping the option is safe.
 *
 * `list` unions the table with the values actually in use, so a value written around the picker
 * still appears in the list it is plainly a member of, rather than being invisible until someone
 * happens to retype it.
 */
export class UploadSourceModel extends DBModel {
  /**
   * Every type the picker should offer, with how many imports have used it.
   *
   * The use count is what lets a bad entry be told from a live one before anybody deletes it —
   * "linkdin (0)" beside "linkedin (14)" answers the question the delete button would otherwise
   * have to be brave about.
   */
  static async list(): Promise<UploadSource[]> {
    const db = await this.getKyselyDB();

    const [listed, used, friendCounts] = await Promise.all([
      db
        .selectFrom("upload_source")
        .select(["value", "label"])
        .orderBy("label", "asc")
        .execute(),
      // Counted over uploads rather than friend rows: "how many imports used this" is the
      // question a person deleting an entry is asking, and a single 40,000-row import would
      // otherwise read as heavy use of a type nobody has chosen twice.
      db
        .selectFrom("upload")
        .select([sql<string>`lower(source)`.as("key"), sql<string>`count(*)`.as("count")])
        .where("source", "is not", null)
        .groupBy(sql`lower(source)`)
        .execute(),
      // Counted over FRIEND ROWS, which is the other question this list gets asked: the run
      // dialog's source picker needs "how many people would I be comparing", where the delete
      // affordance needs "how many imports would I disturb". A single 40,000-row import is 1 and
      // 40,000 respectively, and neither number substitutes for the other.
      FriendModel.countBySource(),
    ]);

    const counts = new Map((used as { key: string; count: string }[]).map((r) => [r.key, Number(r.count) || 0]));
    const out: UploadSource[] = (listed as { value: string; label: string }[]).map((r) => ({
      value: r.value,
      label: r.label,
      useCount: counts.get(r.value.toLowerCase()) ?? 0,
      friendCount: friendCounts[r.value.toLowerCase()] ?? 0,
    }));

    // A value in use that the table has never heard of — written by the console, or left behind
    // by a deleted entry. Listed rather than hidden: it is on rows the user can see, so a picker
    // that omitted it would offer no way to file a new import alongside them.
    const known = new Set(out.map((s) => s.value.toLowerCase()));
    for (const [key, count] of counts) {
      if (known.has(key)) continue;
      out.push({ value: key, label: key, useCount: count, friendCount: friendCounts[key] ?? 0 });
      known.add(key);
    }

    // A source on FRIEND rows whose import is gone (rolled back, or the friend enriched from a
    // later import) has no entry above and no upload counting it — but its people are still on
    // file and still comparable, so the picker has to offer it or they are unreachable.
    for (const [key, friendCount] of Object.entries(friendCounts)) {
      if (known.has(key)) continue;
      out.push({ value: key, label: key, useCount: 0, friendCount });
    }

    return out;
  }

  /**
   * Add a type, or return the one that already exists.
   *
   * Idempotent rather than conflicting: two people typing "trade show" on the same afternoon is
   * not an error state, and the caller only ever wants the value back so it can select it.
   */
  static async create(value: string, createdBy: string | null): Promise<UploadSource> {
    const db = await this.getKyselyDB();

    const existing = await db
      .selectFrom("upload_source")
      .select(["value", "label"])
      .where(sql`lower(value)`, "=", value.toLowerCase())
      .executeTakeFirst();
    if (existing) {
      return {
        value: existing.value,
        label: existing.label,
        // Both zero regardless of the truth, on the create path only. The caller is the picker
        // selecting what it just typed, and it refetches the list straight after — reporting a
        // stale zero for one render beats a second pair of aggregate queries on the write path.
        useCount: 0,
        friendCount: 0,
      };
    }

    await db
      .insertInto("upload_source")
      .values({
        value,
        // Title-cased for display while the stored value stays folded, so "trade show" reads as
        // "Trade show" beside the starting entries instead of being the one lower-case option.
        label: value.charAt(0).toUpperCase() + value.slice(1),
        created_by: createdBy,
      })
      .execute();

    return {
      value,
      label: value.charAt(0).toUpperCase() + value.slice(1),
      // Genuinely zero here: the entry did not exist a moment ago, so nothing can be using it.
      useCount: 0,
      friendCount: 0,
    };
  }

  /**
   * Remove a type from the picker. Rows already carrying it are untouched — there is no FK, so
   * there is nothing to cascade and nothing to orphan.
   *
   * Any entry, including the three the schema starts with. Returns false only when the table has
   * no row by that name — which includes a value that is only in the list because something is
   * using it, since `list` synthesises those and there is nothing to delete.
   */
  static async remove(value: string): Promise<boolean> {
    const db = await this.getKyselyDB();
    const res = await db
      .deleteFrom("upload_source")
      .where(sql`lower(value)`, "=", value.toLowerCase())
      .executeTakeFirst();
    return Number(res?.numDeletedRows ?? 0) > 0;
  }
}
