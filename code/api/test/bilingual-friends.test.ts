import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import FormData from "form-data";
import { sql } from "kysely";
import { DBModel } from "@extensions/sqldb";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { truncateAll, importCompany, startCompare } from "./helpers";

/**
 * Bilingual friends — `friend` carries a column per language, symmetric with `company_contact`.
 *
 * Three things are pinned here, in rising order of how quietly they would break:
 *
 *   1. THE IMPORT GATE. A run's mode decides what is SCORED, never what is STORED. This is the
 *      regression test that stops a language filter from drifting into the parser or the gate —
 *      the failure mode is silent, flattering, and would take the "Not compared" bucket with it.
 *   2. COUNTING BY FRIEND, NOT BY NAME STRING. One person matched by a Thai run and an English run
 *      is ONE matched friend. Counting strings reports two, and `friends − matched = noMatch`
 *      breaks over a `matched` that can exceed `friends`.
 *   3. ENRICHMENT. An import may fill a null spelling and may never overwrite one, because result
 *      rows without `friend_id` resolve back to their friend BY NAME and an overwrite orphans them.
 */

let app: FastifyInstance;
let mock: MockServer;

const db = async () => (await DBModel.getPool()).connect();

/** Somchai at ACME, in both spellings — matchable by an English run and a Thai run alike. */
const CO_CSV = "company_name,thai_name,eng_name\nACME,สมชาย ใจดี,Somchai Jaidee\n";

/** A friends file with whichever columns the case needs. */
async function importFriends(
  headers: string,
  rows: string[],
  opts: { owner?: string; compareBy?: string } = {}
) {
  const form = new FormData();
  form.append("name", "Friends");
  form.append("uploadPersonName", opts.owner ?? "Alex");
  if (opts.compareBy) form.append("compareBy", opts.compareBy);
  form.append("facebookFile", Buffer.from(`${headers}\n${rows.join("\n")}\n`, "utf8"), {
    filename: "friends.csv",
    contentType: "text/csv",
  });
  return app.inject({ method: "POST", url: "/api/comparisons/run", payload: form, headers: form.getHeaders() });
}

const storedFriends = async (): Promise<
  { en: string | null; th: string | null; owner: string | null }[]
> => {
  const rows = await sql<{ en: string | null; th: string | null; owner: string | null }>`
    select friend_name_en as en, friend_name_th as th, relationship_owner as owner
      from lakeshore.friend order by id asc
  `.execute(await db());
  return rows.rows;
};

const overview = async (uploader?: string) => {
  const url = uploader
    ? `/api/network/overview?uploader=${encodeURIComponent(uploader)}`
    : "/api/network/overview";
  return (await app.inject({ method: "GET", url })).json().data;
};

const uploaderDetail = async (name: string) =>
  (await app.inject({ method: "GET", url: `/api/network/uploader?name=${encodeURIComponent(name)}` })).json()
    .data;

beforeAll(async () => {
  mock = await startMockWebhook(MOCK_PORT);
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  await mock?.close();
});

beforeEach(async () => {
  await truncateAll();
  mock.state.company.length = 0;
  mock.state.facebook.length = 0;
  mock.state.compare.length = 0;
});

describe("the import stores every friend, whatever the run's mode", () => {
  it("stores English-only friends on a th_full import — the mode scores, it does not filter", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    const res = await importFriends(
      "name",
      ["สมชาย ใจดี", "Preecha Wong", "Malee Srisai"],
      { compareBy: "th_full" }
    );
    expect(res.statusCode, res.body).toBe(200);

    // ALL THREE are on file. Two of them have no Thai name and could not be scored by this run —
    // that is a fact about the run, and it must not become a fact about the database.
    const friends = await storedFriends();
    expect(friends).toHaveLength(3);
    expect(friends.filter((f) => f.th !== null)).toHaveLength(1);
    expect(friends.filter((f) => f.en !== null)).toHaveLength(2);

    // The roster reports all three, so `friends − matched = noMatch` is computed over the whole
    // roster rather than over the subset this run happened to be able to look at.
    const ov = await overview("Alex");
    expect(ov.friends).toBe(3);
  });

  it("drops a row only when it has no name in EITHER language", async () => {
    const res = await importFriends("name,thai_name", ['"Preecha Wong",', '"",""', ',สมชาย ใจดี']);
    expect(res.statusCode).toBe(200);

    const friends = await storedFriends();
    expect(friends).toHaveLength(2); // the empty row, and only it, was dropped
    expect(friends.map((f) => f.en)).toEqual(["preecha wong", null]);
    expect(friends.map((f) => f.th)).toEqual([null, "สมชาย ใจดี"]);
  });

  it("routes an unlabelled name column by script, and believes a labelled one", async () => {
    await importFriends("name", ["สมชาย ใจดี", "Preecha Wong"]);
    // The bare `name` column says nothing about its language, so its script decides — the same
    // rule the 2026-07-28 backfill applied. Routing it all to English would have filed a
    // Thai-script export where no Thai run could ever see it.
    expect(await storedFriends()).toEqual([
      { en: null, th: "สมชาย ใจดี", owner: "Alex" },
      { en: "preecha wong", th: null, owner: "Alex" },
    ]);

    await truncateAll();
    // A labelled column is believed on its own terms, not re-read from its characters.
    await importFriends("eng_name,thai_name", ['"Somchai Jaidee",สมชาย ใจดี']);
    expect(await storedFriends()).toEqual([
      { en: "somchai jaidee", th: "สมชาย ใจดี", owner: "Alex" },
    ]);
  });
});

describe("a friend matched in both languages counts ONCE", () => {
  it("does not double-count across a Thai run and an English run", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFriends("eng_name,thai_name", ['"Somchai Jaidee",สมชาย ใจดี']);

    // Two runs, two languages, one person. Each writes its own result row with its own spelling.
    await startCompare(app, ["ACME"], "en_full");
    await startCompare(app, ["ACME"], "th_full");

    const rows = await sql<{ n: string }>`select count(*)::text as n from lakeshore.comparison_result`.execute(
      await db()
    );
    expect(Number(rows.rows[0].n)).toBe(2); // two result rows — the runs really did both match

    const ov = await overview("Alex");
    // …and ONE matched friend. Counting distinct name strings would say 2 here, which would make
    // `matched` exceed `friends` and report the roster as more placed than it is.
    expect(ov.friends).toBe(1);
    expect(ov.friendsMatched).toBe(1);
    expect(ov.friends - ov.friendsMatched).toBe(0);
    expect(ov.connected).toEqual([{ company: "ACME", connections: 1, confirmed: 1 }]);

    const detail = await uploaderDetail("Alex");
    expect(detail.friends).toBe(1);
    expect(detail.matched).toBe(1);
    expect(detail.noMatch).toBe(0);
    // One company section, one person in it — not the same person twice under their two names.
    expect(detail.matchedByCompany).toHaveLength(1);
    expect(detail.matchedByCompany[0].people).toHaveLength(1);
  });

  it("still counts a friend whose result row carries no friend_id — the external-workflow path", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFriends("eng_name,thai_name", ['"Somchai Jaidee",สมชาย ใจดี']);
    await startCompare(app, ["ACME"], "en_full");

    // Strip the identity column the internal matcher wrote, and the spelling this run did not
    // score — leaving exactly what an external workflow is obliged to send: one name, no id. The
    // count has to survive on that name alone.
    //
    // This nulled BOTH spellings until 2026-08-03c, and passed, because a third column
    // (`friend_name`) still carried the scored name for `sameFriendSql` to fall back to. That
    // column is gone. A row naming neither spelling now names nobody at all, which is a different
    // scenario from this one — see the test below.
    await sql`update lakeshore.comparison_result
                 set friend_id = null, friend_name_th = null`.execute(await db());

    const ov = await overview("Alex");
    expect(ov.friendsMatched).toBe(1);
    expect(ov.friendsConfirmed).toBe(1);
  });

  it("counts no friend for a result row carrying neither spelling", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFriends("eng_name,thai_name", ['"Somchai Jaidee",สมชาย ใจดี']);
    await startCompare(app, ["ACME"], "en_full");

    await sql`update lakeshore.comparison_result
                 set friend_id = null, friend_name_en = null, friend_name_th = null`.execute(await db());

    // Nothing on the row points at a friend, so nothing is attributed to one. Zero rather than a
    // guess: the alternative is resolving by some other column, and every candidate for that
    // (`upload_name`, the contact's name) is about a different person than the friend.
    //
    // The friend is still on file and still uncounted as matched, so the roster reads
    // `friends 1 · matched 0`, which is the honest reading of a result we cannot attribute.
    const ov = await overview("Alex");
    expect(ov.friends).toBe(1);
    expect(ov.friendsMatched).toBe(0);
  });
});

describe("enrichment — fill a null spelling, never overwrite one", () => {
  it("fills the missing spelling instead of filing the same person twice", async () => {
    // English-only, as a Facebook export gives it.
    await importFriends("name", ["Somchai Jaidee"]);
    expect(await storedFriends()).toEqual([{ en: "somchai jaidee", th: null, owner: "Alex" }]);

    // The same person from a business card, which prints both. A strict key over the pair would
    // make this a second roster entry — a visible regression, and the reason the key is "either
    // spelling" rather than "both".
    const res = await importFriends("eng_name,thai_name", ['"Somchai Jaidee",สมชาย ใจดี']);
    expect(res.statusCode).toBe(200);

    expect(await storedFriends()).toEqual([{ en: "somchai jaidee", th: "สมชาย ใจดี", owner: "Alex" }]);
    const ov = await overview("Alex");
    expect(ov.friends).toBe(1); // one person, not two
  });

  it("keeps a conflicting spelling and reports it rather than applying it", async () => {
    await importFriends("eng_name,thai_name", ['"Somchai Jaidee",สมชาย ใจดี']);
    // A file that disagrees about the Thai spelling. History resolves back to friends BY NAME on
    // every row an external workflow wrote, so an overwrite would orphan those rows and break the
    // counts retroactively and silently. The stored value wins; the console is the visible way to
    // change a name on purpose.
    const res = await importFriends("eng_name,thai_name", ['"Somchai Jaidee",สมชาย ใจงาม']);
    expect(res.statusCode).toBe(200);

    expect(await storedFriends()).toEqual([{ en: "somchai jaidee", th: "สมชาย ใจดี", owner: "Alex" }]);
  });

  it("enriches one person per file even when the same friend appears twice in it", async () => {
    // First line English-only, second bilingual — the same person, within one file. The row is
    // still pending insert when the second line is read, so it must be FILLED rather than
    // inserted alongside.
    await importFriends("eng_name,thai_name", ['"Somchai Jaidee",', '"Somchai Jaidee",สมชาย ใจดี']);
    expect(await storedFriends()).toEqual([{ en: "somchai jaidee", th: "สมชาย ใจดี", owner: "Alex" }]);
  });

  it("keeps two owners' copies of one person apart — enrichment is per roster", async () => {
    await importFriends("name", ["Somchai Jaidee"], { owner: "Alex" });
    await importFriends("eng_name,thai_name", ['"Somchai Jaidee",สมชาย ใจดี'], { owner: "Bee" });

    // Two rows, because a friend is (owner, name) — one person known by two colleagues is two
    // ways to reach them, which is the product. Only Bee's gained the Thai spelling.
    expect(await storedFriends()).toEqual([
      { en: "somchai jaidee", th: null, owner: "Alex" },
      { en: "somchai jaidee", th: "สมชาย ใจดี", owner: "Bee" },
    ]);
  });

  it("an enrich-only import is not a no-op — it opens a run and reports what changed", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFriends("name", ["Somchai Jaidee"]);

    // Adds no row, but the friend now carries a Thai spelling no run has ever matched against.
    // Before bilingual friends, "an import that adds nothing sends no request at all" was correct
    // because nothing had changed; it is not correct any more.
    const res = await importFriends("eng_name,thai_name", ['"Somchai Jaidee",สมชาย ใจดี']);
    const data = res.json().data;
    expect(data.facebookAdded).toBe(0);
    expect(data.sessionId).not.toBeNull();

    // The enriched row is matchable by a Thai run, which is the point of storing it.
    await startCompare(app, ["ACME"], "th_full");
    const ov = await overview("Alex");
    expect(ov.friendsMatched).toBe(1);
  });
});

describe("corroboration — two independent spellings agreeing", () => {
  it("flags a pairing confirmed by both a Thai and an English whole-name run", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFriends("eng_name,thai_name", ['"Somchai Jaidee",สมชาย ใจดี']);

    // One language only: a strong match, but nothing has independently agreed with it.
    await startCompare(app, ["ACME"], "en_full");
    let row = (await app.inject({ method: "GET", url: "/api/network/search?q=Somchai&page=1&limit=20" }))
      .json()
      .data[0];
    expect(row.connectedUploaders[0].corroborated).toBe(false);

    // The Thai run confirms the same pairing from the other side.
    await startCompare(app, ["ACME"], "th_full");
    row = (await app.inject({ method: "GET", url: "/api/network/search?q=Somchai&page=1&limit=20" }))
      .json()
      .data[0];
    expect(row.connectedUploaders[0].corroborated).toBe(true);
    // It does NOT become a third tier: corroborated and confirmed lead to the same action, so the
    // grade is unchanged and only the tooltip gains a sentence.
    expect(row.connectedUploaders[0].mode).toBe("en_full");
  });

  it("does not flag two runs that agree only on a PARTIAL name", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFriends("eng_name,thai_name", ['"Somchai Jaidee",สมชาย ใจดี']);
    await startCompare(app, ["ACME"], "en_surname");
    await startCompare(app, ["ACME"], "th_surname");

    const row = (await app.inject({ method: "GET", url: "/api/network/search?q=Somchai&page=1&limit=20" }))
      .json()
      .data[0];
    // Two surnames agreeing in two languages is two weak claims, not one strong one.
    expect(row.connectedUploaders[0].corroborated).toBe(false);
  });
});
