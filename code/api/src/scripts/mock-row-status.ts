/**
 * Stand in for the external matcher workflow: stamp a verdict on every data row.
 *
 *   cd code/api && npm run mock:row-status              # write
 *   cd code/api && npm run mock:row-status -- --dry     # show the tally, write nothing
 *   cd code/api && npm run mock:row-status -- --settled # leave no row unfinished
 *
 * The real workflow decides `friend.status` / `company_contact.status` per row and NameSync
 * only ever reads them (docs/EXTERNAL-MATCHER.md). Until that workflow is wired up, every row
 * sits at the column's default — 'processing' — and the Database console is a wall of one
 * value. This fills it in with plausible ones so the column can actually be looked at.
 *
 * The vocabulary is imported, never spelled out here. A mock that invented its own strings would
 * be mocking a workflow that does not exist: these are the values `rowVerdict` reads
 * (extensions/contract/src/row-status.ts), and that is the whole point of writing them.
 *
 * It is a *mock*, and it is honest about the two ways it is not the workflow:
 *
 *   · It writes no `comparison_result` rows, so a row it stamps 'match' has no pair behind it —
 *     a match to nobody. That USED to be self-correcting: the stamp was advisory, the verdict came
 *     from a score this script never wrote, and a mocked 'match' rendered as "No match" whatever
 *     the weights below said. Since 2026-07-20 the stamp IS the verdict, so a mocked 'match' now
 *     counts as one, all the way up to the headline — with no pair on screen to show for it. The
 *     match rate you read off a mocked table is this script's weights, not a matcher's judgement.
 *   · Rows it leaves unfinished are indistinguishable from a live import that is still running:
 *     NameSync finishes an upload by counting rows that are *not* unfinished, so a mocked
 *     'pending'/'processing' row keeps its upload spinning forever. That is what --settled is for.
 *
 * Requires the `status` column on both tables — declared in docs/schema-redesign.sql
 * (`text NOT NULL DEFAULT 'processing'`, no CHECK). See docs/EXTERNAL-MATCHER.md.
 */

import { DBModel } from "@extensions/sqldb";
import {
  ROW_QUEUED,
  ROW_PENDING,
  ROW_MATCH,
  ROW_UNMATCH,
  ROW_FAILED_VALUES,
} from "@extensions/contract";

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

/** One of the four spellings a workflow may use for a row it gave up on. Any of them reads as
 *  'failed'; picking one keeps the tally legible. */
const ROW_FAILED = "failed" satisfies (typeof ROW_FAILED_VALUES)[number];

/**
 * The verdicts, and how often to hand each one out.
 *
 * Both unfinished spellings appear, and not just the column default, because the workflow
 * distinguishes a row it has accepted ('pending') from a row it is working on ('processing') and
 * a mock that only ever wrote one of them would never exercise the other — they are read through
 * one set (ROW_UNFINISHED_VALUES) precisely so that both are already understood when they arrive.
 *
 * A slice of failures too: "we never managed to compare this name" is counted apart from "this
 * name matched nobody", and a mock that never produced one left that tab permanently empty.
 * A failed row is *finished* — it is never coming back — so --settled keeps writing them.
 */
const WEIGHTS: Record<string, number> = SETTLED
  ? { [ROW_MATCH]: 0.47, [ROW_UNMATCH]: 0.47, [ROW_FAILED]: 0.06 }
  : {
      [ROW_MATCH]: 0.42,
      [ROW_UNMATCH]: 0.42,
      [ROW_FAILED]: 0.06,
      [ROW_PENDING]: 0.05,
      [ROW_QUEUED]: 0.05,
    };

/** Pick a status against WEIGHTS. */
function roll(): string {
  let r = Math.random();
  for (const [status, weight] of Object.entries(WEIGHTS)) {
    if ((r -= weight) < 0) return status;
  }
  return ROW_UNMATCH; // float dust at the very top of the range
}

/** Postgres caps a statement's parameters, and an id list is one parameter each. */
const CHUNK = 1000;

async function stamp(table: Table): Promise<Record<string, number>> {
  const db = await Mock.db();
  const rows = await db.selectFrom(table).select("id").execute();

  // Decide every row's verdict first, then write one UPDATE per distinct verdict rather than
  // one per row — 600 rows is 5 statements, not 600 round trips.
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

/** `match 12 · unmatch 9 · failed 1 · processing 2` — in WEIGHTS order, so the columns line up. */
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
    console.log(
      `\nSome rows were left unfinished ('${ROW_QUEUED}'/'${ROW_PENDING}') — their uploads will read as still running.`
    );
    console.log("Re-run with --settled to give every row a final verdict.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (String(err?.message).includes("status")) {
      console.error(
        "Failed naming `status`. Both tables should carry it — see docs/schema-redesign.sql and docs/EXTERNAL-MATCHER.md.\n"
      );
    }
    console.error(err);
    process.exit(1);
  });
