/**
 * Fill the `*_clean` name columns on rows imported before name cleaning existed.
 *
 *   cd code/api && npm run backfill:clean-names          # write
 *   cd code/api && npm run backfill:clean-names -- --dry  # show what it would write
 *
 * The cleaning rules live in TypeScript, not SQL, so this runs the existing rows through
 * the very same function the import uses (name-cleaner.service.ts) rather than trying to
 * re-express it as an UPDATE. Idempotent: it only touches rows whose clean column is still
 * null, so running it twice is a no-op, and it never modifies a raw name.
 *
 * Nothing depends on it having run — every reader falls back to cleaning the raw name on
 * the fly. This just makes that fallback unnecessary (and the clean columns indexable).
 */

import { DBModel } from "@extensions/sqldb";
import { cleanPersonName } from "../services/name-cleaner.service";

/** `getKyselyDB` is protected on DBModel — a subclass is how everything else reaches it. */
class Backfill extends DBModel {
  static db() {
    return this.getKyselyDB();
  }
}

const DRY = process.argv.includes("--dry");

/** Rows are updated one at a time, but the reads are chunked — a friend table can be big. */
const CHUNK = 500;

async function backfillFriends(): Promise<{ scanned: number; updated: number }> {
  const db = await Backfill.db();
  let scanned = 0;
  let updated = 0;

  for (;;) {
    const rows = await db
      .selectFrom("friend")
      .select(["id", "friend_name"])
      .where("friend_name_clean", "is", null)
      .where("friend_name", "is not", null)
      .orderBy("id", "asc")
      .limit(CHUNK)
      .execute();
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const clean = cleanPersonName(row.friend_name);
      if (clean === null) continue; // a "name" that was only a title — leave it null
      if (DRY) {
        console.log(`friend ${row.id}: ${JSON.stringify(row.friend_name)} -> ${JSON.stringify(clean)}`);
      } else {
        await db.updateTable("friend").set({ friend_name_clean: clean }).where("id", "=", row.id).execute();
      }
      updated += 1;
    }

    // A dry run writes nothing, so the same rows would come back forever.
    if (DRY || rows.length < CHUNK) break;
  }
  return { scanned, updated };
}

async function backfillContacts(): Promise<{ scanned: number; updated: number }> {
  const db = await Backfill.db();
  let scanned = 0;
  let updated = 0;

  for (;;) {
    const rows = await db
      .selectFrom("company_contact")
      .select(["id", "person_name_th", "person_name_en"])
      .where((eb) =>
        eb.or([
          eb.and([eb("person_name_th_clean", "is", null), eb("person_name_th", "is not", null)]),
          eb.and([eb("person_name_en_clean", "is", null), eb("person_name_en", "is not", null)]),
        ])
      )
      .orderBy("id", "asc")
      .limit(CHUNK)
      .execute();
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const th = cleanPersonName(row.person_name_th);
      const en = cleanPersonName(row.person_name_en);
      if (th === null && en === null) continue;

      if (DRY) {
        console.log(
          `company_contact ${row.id}: th ${JSON.stringify(row.person_name_th)} -> ${JSON.stringify(th)} | ` +
            `en ${JSON.stringify(row.person_name_en)} -> ${JSON.stringify(en)}`
        );
      } else {
        await db
          .updateTable("company_contact")
          .set({ person_name_th_clean: th, person_name_en_clean: en })
          .where("id", "=", row.id)
          .execute();
      }
      updated += 1;
    }

    if (DRY || rows.length < CHUNK) break;
  }
  return { scanned, updated };
}

async function main(): Promise<void> {
  console.log(DRY ? "Dry run — nothing will be written.\n" : "Backfilling clean names…\n");

  const friends = await backfillFriends();
  const contacts = await backfillContacts();

  console.log(
    `\nfriend:          ${friends.updated}/${friends.scanned} rows ${DRY ? "would be " : ""}cleaned` +
      `\ncompany_contact: ${contacts.updated}/${contacts.scanned} rows ${DRY ? "would be " : ""}cleaned`
  );
  if (DRY) console.log("\nRe-run without --dry to write.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
