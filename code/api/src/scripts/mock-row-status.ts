/**
 * Stand in for the external matcher workflow: stamp a verdict on every data row.
 *
 *   cd code/api && npm run mock:row-status              # write
 *   cd code/api && npm run mock:row-status -- --dry     # show the tally, write nothing
 *   cd code/api && npm run mock:row-status -- --settled # leave no row at 'processing'
 *
 * The real workflow decides `friend.status` / `company_contact.status` per row and NameSync
 * only ever reads them (docs/EXTERNAL-MATCHER.md). Until that workflow is wired up, every row
 * sits at the column's default — 'processing' — and the Database console is a wall of one
 * value. This fills it in with plausible ones so the column can actually be looked at.
 *
 * It is a *mock*, and it is honest about the two ways it is not the workflow:
 *
 *   · It writes no `comparison_result` rows. A row it stamps 'match' has no pair and no score
 *     behind it, so the Uploads page ("5 of 12 matched", counted from these rows) and the
 *     results table (rendered from `comparison_result`) will disagree. That is fine for looking
 *     at the grid and wrong for anything else — don't read the match rate off a mocked table.
 *   · Rows it leaves at 'processing' are indistinguishable from a live import that is still
 *     running: NameSync finishes an upload by counting rows that are *not* 'processing', so a
 *     mocked 'processing' row keeps its upload spinning forever. That is what --settled is for.
 *
 * Requires the `status` column — docs/migrations/2026-07-14-row-status.sql, applied by hand.
 */

import { DBModel } from "@extensions/sqldb";

/** `getKyselyDB` is protected on DBModel — a subclass is how everything else reaches it. */
class Mock extends DBModel {
  static db() {
    return this.getKyselyDB();
  }
}

const DRY = process.argv.includes("--dry");
const SETTLED = process.argv.includes("--settled");

const TABLES = ["friend", "company_contact"] as const;
type Table = (typeof TABLES)[number];

/**
 * The verdicts, and how often to hand each one out.
 *
 * 'complete' is deliberately absent: it exists in the data, but only the migration's backfill
 * writes it (it means "finished before the workflow existed"). A workflow never produces one,
 * so neither does its mock.
 */
const WEIGHTS: Record<string, number> = SETTLED
  ? { match: 0.5, unmatch: 0.5 }
  : { match: 0.45, unmatch: 0.45, processing: 0.1 };

/** Pick a status against WEIGHTS. */
function roll(): string {
  let r = Math.random();
  for (const [status, weight] of Object.entries(WEIGHTS)) {
    if ((r -= weight) < 0) return status;
  }
  return "unmatch"; // float dust at the very top of the range
}

/** Postgres caps a statement's parameters, and an id list is one parameter each. */
const CHUNK = 1000;

async function stamp(table: Table): Promise<Record<string, number>> {
  const db = await Mock.db();
  const rows = await db.selectFrom(table).select("id").execute();

  // Decide every row's verdict first, then write one UPDATE per distinct verdict rather than
  // one per row — 600 rows is 3 statements, not 600 round trips.
  const byStatus = new Map<string, string[]>();
  for (const { id } of rows) {
    const status = roll();
    const ids = byStatus.get(status) ?? [];
    ids.push(id);
    byStatus.set(status, ids);
  }

  if (!DRY) {
    for (const [status, ids] of byStatus) {
      for (let i = 0; i < ids.length; i += CHUNK) {
        await db
          .updateTable(table)
          .set({ status })
          .where("id", "in", ids.slice(i, i + CHUNK))
          .execute();
      }
    }
  }

  return Object.fromEntries([...byStatus].map(([status, ids]) => [status, ids.length]));
}

/** `match 12 · unmatch 9 · processing 2` — in WEIGHTS order, so the columns line up. */
const format = (tally: Record<string, number>): string =>
  Object.keys(WEIGHTS)
    .filter((s) => tally[s])
    .map((s) => `${s} ${tally[s]}`)
    .join(" · ") || "no rows";

async function main(): Promise<void> {
  console.log(DRY ? "Dry run — nothing will be written.\n" : "Stamping row statuses…\n");

  for (const table of TABLES) {
    const tally = await stamp(table);
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    console.log(`${table.padEnd(16)} ${String(total).padStart(4)} rows   ${format(tally)}`);
  }

  if (DRY) console.log("\nRe-run without --dry to write.");
  else if (!SETTLED) {
    console.log("\nSome rows were left at 'processing' — their uploads will read as still running.");
    console.log("Re-run with --settled to give every row a final verdict.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (String(err?.message).includes("status")) {
      console.error("Failed naming `status`. Has docs/migrations/2026-07-14-row-status.sql been applied?\n");
    }
    console.error(err);
    process.exit(1);
  });
