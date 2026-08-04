import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { DBModel } from "@extensions/sqldb";
import {
  DEFAULT_COMPARE_BY,
  compareByAxes,
  isScorable,
  namePartCandidates,
  namePartSpan,
  parseCompareBy,
  runRowBucket,
} from "@extensions/contract";
import { cleanOwnerName, cleanPersonName } from "../src/services/name-cleaner.service";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { importCompany, importFacebook, startCompare, truncateAll } from "./helpers";

/**
 * The 2026-07-27 change: a relationship owner per friend row, and a comparison mode per run.
 *
 * The two are here together because they are coupled through the results table — a row's bucket
 * depends on the run's mode, and the owner is what the bucket is *about* once a row matches.
 */

let app: FastifyInstance;
let mock: MockServer;

// The mock webhook is up because an import forwards its rows to the configured ingestion URL
// before /run returns, whichever matcher is on.
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
});

// ── The split, in the parts that have no database ───────────────────────────

describe("cleanOwnerName", () => {
  it("strips titles like a name, but keeps the capitalisation", () => {
    // The clean is what makes "Khun Alex" and "Alex" one roster instead of two.
    expect(cleanOwnerName("Khun Alex")).toBe("Alex");
    expect(cleanOwnerName("นายสมชาย ใจดี")).toBe("สมชาย ใจดี");
    // …and the case survives, which is the whole difference from cleanPersonName. This string is
    // never matched — it is grouped (case-insensitively, at each reader's end) and then shown to
    // somebody as the person to go and ask.
    expect(cleanOwnerName("Mint W.")).toBe("Mint W.");
    expect(cleanPersonName("Mint W.")).toBe("mint w.");
  });

  it("returns null for a name that was only a title", () => {
    expect(cleanOwnerName("  ")).toBeNull();
    expect(cleanOwnerName("Khun")).toBeNull();
  });
});

describe("compare_by vocabulary", () => {
  it("reads a stored NULL, and an unknown value, as the default", () => {
    expect(parseCompareBy(null)).toBe(DEFAULT_COMPARE_BY);
    expect(parseCompareBy(undefined)).toBe(DEFAULT_COMPARE_BY);
    // An unrecognised value on the way OUT is a renderer's problem, not a 500 — the run's rows are
    // still worth showing. The vocabulary is enforced on the way in, at the route.
    expect(parseCompareBy("nonsense_mode")).toBe(DEFAULT_COMPARE_BY);
    // `either_*` was the old default and is no longer in the vocabulary; a row still holding one
    // must not crash a reader.
    expect(parseCompareBy("either_full")).toBe(DEFAULT_COMPARE_BY);
    expect(parseCompareBy("th_surname")).toBe("th_surname");
  });

  it("splits and rebuilds its two axes", () => {
    expect(compareByAxes("th_surname")).toEqual({ language: "th", type: "surname" });
    expect(compareByAxes("en_full")).toEqual({ language: "en", type: "full" });
  });
});

describe("namePartCandidates", () => {
  it("offers a two-word surname alongside the bare final token — but only from three tokens up", () => {
    // Three tokens: both readings are scored and the trigram measure picks. Nothing is discarded,
    // so nothing can be discarded wrongly.
    expect(namePartCandidates("somchai na ayutthaya", "surname")).toEqual(["ayutthaya", "na ayutthaya"]);
    expect(namePartCandidates("maria del carmen garcia", "surname")).toEqual(["garcia", "carmen garcia"]);

    // Two tokens: the "last two" reading IS the whole name, so offering it would quietly turn
    // `last` into `full` for the commonest shape of name there is.
    expect(namePartCandidates("somchai jaidee", "surname")).toEqual(["jaidee"]);
    expect(namePartCandidates("somchai", "surname")).toEqual(["somchai"]);
  });

  it("takes the first token for `name`, and the whole string for `full`", () => {
    expect(namePartCandidates("somchai j. jaidee", "name")).toEqual(["somchai"]);
    expect(namePartCandidates("somchai j. jaidee", "full")).toEqual(["somchai j. jaidee"]);
    expect(namePartCandidates(null, "name")).toEqual([]);
  });

  it("marks the span that was in play, so a surname match doesn't read as a bug", () => {
    expect(namePartSpan("somchai jaidee", "surname")).toEqual({
      before: "somchai ",
      match: "jaidee",
      after: "",
    });
    // The widest candidate, because both were scored and the row keeps one score, not one per
    // reading. "This is the region the matcher considered" is the honest claim.
    expect(namePartSpan("somchai na ayutthaya", "surname")?.match).toBe("na ayutthaya");
    expect(namePartSpan("somchai jaidee", "full")).toEqual({ before: "", match: "somchai jaidee", after: "" });
  });
});

describe("isScorable / runRowBucket", () => {
  it("rules out a name with no text in the run's language — every run now has some", () => {
    expect(isScorable("somchai jaidee", "th")).toBe(false);
    expect(isScorable("สมชาย ใจดี", "th")).toBe(true);
    expect(isScorable("สมชาย ใจดี", "en")).toBe(false);
    expect(isScorable("somchai jaidee", "en")).toBe(true);
    // There is no `either` to fall back on since 2026-07-27, so a nameless row is scorable under
    // nothing at all.
    expect(isScorable(null, "en")).toBe(false);
    expect(isScorable(null, "th")).toBe(false);
  });

  it("lets the evidence beat the inference, and keeps unfinished rows out of it", () => {
    expect(runRowBucket("unmatched", false)).toBe("unscored");
    expect(runRowBucket("unmatched", true)).toBe("unmatched");
    // A match is proof the row WAS compared, whatever our reading of its script says — reachable
    // on an external run whose workflow ignored compare_by.
    expect(runRowBucket("matched", false)).toBe("matched");
    // A row still being worked on has not been "not compared", it has not been anything yet.
    expect(runRowBucket("pending", false)).toBe("pending");
    expect(runRowBucket("failed", false)).toBe("failed");
  });
});

// ── The owner, per row ──────────────────────────────────────────────────────

const owners = async (): Promise<{ name: string | null; owner: string | null }[]> => {
  const pool = await DBModel.getPool();
  const db = await pool.connect();
  const res = await sql<{ name: string | null; owner: string | null }>`
    select coalesce(friend_name_en, friend_name_th) as name, relationship_owner as owner
    from lakeshore.friend order by id asc
  `.execute(db);
  return res.rows;
};

describe("relationship owner, per friend row", () => {
  it("reads each friend's own owner off the file, with nothing typed at all", async () => {
    const res = await importFacebook(app, {
      ownedFriends: [
        ["Somchai Jaidee", "Mint"],
        ["Anong Sri", "Nadhee"],
      ],
    });
    expect(res.statusCode).toBe(200);

    // No `uploadPersonName` on the wire, and the import is accepted: a file that names an owner
    // per row has already answered the question the field exists to ask. One file, two rosters,
    // which is the entire reason the owner moved onto the row.
    expect(await owners()).toEqual([
      { name: "somchai jaidee", owner: "Mint" },
      { name: "anong sri", owner: "Nadhee" },
    ]);
  });

  it("lets the typed owner OVERWRITE the file's own column, on every row", async () => {
    await importFacebook(app, {
      ownedFriends: [
        ["Somchai Jaidee", "Mint"],
        ["Anong Sri", "Nadhee"],
      ],
      owner: "Khun Alex",
    });

    // Not a fallback: the person importing is looking at the file's own column on the preview
    // screen when they type over it, so the typed name is the later answer and it wins outright.
    // Cleaned like any other owner (the title goes) but not lower-cased.
    expect(await owners()).toEqual([
      { name: "somchai jaidee", owner: "Alex" },
      { name: "anong sri", owner: "Alex" },
    ]);
  });

  it("refuses a file that leaves a row unowned, rather than filing it under the uploader", async () => {
    const res = await importFacebook(app, {
      ownedFriends: [
        ["Somchai Jaidee", "Mint"],
        ["Anong Sri", null],
      ],
      uploader: "Assistant",
    });

    // Filing the blank row under the ASSISTANT would invent an introduction route in the name of
    // somebody who does not know this person — the one direction it is not safe to be wrong in.
    // Storing it unowned is the other way to be wrong: the owner is half the dedup key, so it
    // would merge with every other ownerless friend. So the import is refused, and says which
    // rows are the problem.
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("1 friend in this file name no relationship owner");
    expect(await owners()).toEqual([]);
  });

  it("takes the typed owner for a file with a blank cell — for every row, not just the blank one", async () => {
    await importFacebook(app, {
      ownedFriends: [
        ["Somchai Jaidee", "Mint"],
        ["Anong Sri", null],
      ],
      owner: "Nadhee",
      uploader: "Assistant",
    });

    // The typed name covers the blank row — which is what makes this file importable at all — and
    // it covers Mint's row too, because it is an override and not a patch. The screen says so
    // before the button is pressed (see `ownerlessRows` and OwnerNote in ImportReview.tsx).
    expect(await owners()).toEqual([
      { name: "somchai jaidee", owner: "Nadhee" },
      { name: "anong sri", owner: "Nadhee" },
    ]);
  });

  it("keeps the uploader and the owner apart — the assistant case", async () => {
    await importFacebook(app, { friends: [["Somchai", 1]], owner: "Salesperson", uploader: "Assistant" });

    expect((await owners())[0]).toEqual({ name: "somchai", owner: "Salesperson" });

    const list = (await app.inject({ method: "GET", url: "/api/upload-sessions?page=1&limit=10" })).json();
    // `upload.uploaded_by` is who pressed the button; the roster belongs to somebody else.
    expect(list.data[0].uploaded_by).toBe("Assistant");
  });

  it("dedupes per owner, so two people may each know the same person", async () => {
    await importFacebook(app, {
      ownedFriends: [
        ["Somchai Jaidee", "Mint"],
        ["Somchai Jaidee", "Nadhee"],
        // A genuine duplicate: same owner, same name, cleaned to the same string.
        ["MR. SOMCHAI JAIDEE", "Mint"],
      ],
    });

    // Two rows, not one and not three. One person known by two colleagues is two ways to reach
    // them — the product's whole value — while the same person twice on one roster is a duplicate.
    expect(await owners()).toEqual([
      { name: "somchai jaidee", owner: "Mint" },
      { name: "somchai jaidee", owner: "Nadhee" },
    ]);
  });

  it("folds case on both halves of the key", async () => {
    await importFacebook(app, { ownedFriends: [["Somchai", "Alex"]] });
    await importFacebook(app, { ownedFriends: [["SOMCHAI", "alex"]] });

    // "Alex" and "alex" were two rosters to the old dedup and one to the Overview. They are one
    // roster to both now.
    expect(await owners()).toHaveLength(1);
  });

  it("groups the Network rosters by the row's owner, not by who uploaded the file", async () => {
    await importFacebook(app, {
      ownedFriends: [
        ["Somchai Jaidee", "Mint"],
        ["Anong Sri", "Mint"],
        ["Preecha Wong", "Nadhee"],
      ],
      uploader: "Assistant",
    });

    const ov = (await app.inject({ method: "GET", url: "/api/network/overview" })).json().data;
    // Two rosters out of one import. Read off `upload.uploaded_by` this would have been one
    // roster of three, filed under the assistant.
    expect(ov.uploaders.sort()).toEqual(["Mint", "Nadhee"]);

    const mint = (await app.inject({ method: "GET", url: "/api/network/overview?uploader=Mint" })).json().data;
    expect(mint.friends).toBe(2);
  });
});

// ── The mode ────────────────────────────────────────────────────────────────

const CO_TH_EN = "company_name,thai_name,eng_name\nAcme Co,สมชาย ใจดี,Somchai Jaidee\n";

describe("compare_by, end to end", () => {
  it("stamps the run so a finished run can say which question it asked", async () => {
    await importCompany(app, { csv: CO_TH_EN });
    await importFacebook(app, { friends: [["Somchai Jaidee", 1]] });

    const id = await startCompare(app, "Acme Co", "th_surname");
    const progress = (await app.inject({ method: "GET", url: `/api/comparisons/${id}/progress` })).json().data;
    expect(progress.compareBy).toBe("th_surname");
  });

  it("reports the default for a run made before the column existed", async () => {
    await importCompany(app, { csv: CO_TH_EN });
    await importFacebook(app, { friends: [["Somchai Jaidee", 1]] });
    const id = await startCompare(app);

    // Simulate a legacy row: the column is nullable and those runs predate it.
    const pool = await DBModel.getPool();
    const db = await pool.connect();
    await sql`update lakeshore.comparison set compare_by = null where id = ${id}`.execute(db);

    const progress = (await app.inject({ method: "GET", url: `/api/comparisons/${id}/progress` })).json().data;
    expect(progress.compareBy).toBe(DEFAULT_COMPARE_BY);
  });

  it("matches on a shared surname under `last` where a full-name run would not", async () => {
    await importCompany(app, { csv: "company_name,thai_name,eng_name\nAcme Co,,Narong Jaidee\n" });
    await importFacebook(app, { friends: [["Somchai Jaidee", 1]] });

    const full = (
      await app.inject({ method: "GET", url: `/api/comparisons/${await startCompare(app, "Acme Co", "en_full")}/progress` })
    ).json().data;
    expect(full.matched).toBe(0);

    const last = (
      await app.inject({ method: "GET", url: `/api/comparisons/${await startCompare(app, "Acme Co", "en_surname")}/progress` })
    ).json().data;
    expect(last.matched).toBe(1);
  });

  it("counts a friend the mode could not score as `unscored`, never as `unmatched`", async () => {
    await importCompany(app, { csv: CO_TH_EN });
    // One Thai-script friend, one Latin. Under a Thai run the Latin one has nothing to be held up
    // against, and calling that "no match" would state a finding about a question never asked.
    await importFacebook(app, { friends: [["สมชาย ใจดี", 1], ["Preecha Wong", 2]] });

    const id = await startCompare(app, "Acme Co", "th_full");
    const p = (await app.inject({ method: "GET", url: `/api/comparisons/${id}/progress` })).json().data;

    expect(p.matched).toBe(1);
    expect(p.unscored).toBe(1);
    expect(p.unmatched).toBe(0);
    // The denominator still covers everybody, so "1 of 2" does not quietly become "1 of 1".
    expect(p.total).toBe(2);
  });

  it("mirrors the split: what `th` rules out, `en` scores, and back again", async () => {
    await importCompany(app, { csv: CO_TH_EN });
    await importFacebook(app, { friends: [["สมชาย ใจดี", 1], ["Preecha Wong", 2]] });

    // There is no mode that scores both any more, so the two runs partition the friends between
    // them. Each one's `unscored` is the other one's population — which is the clearest statement
    // of what removing `either` actually did.
    const en = (
      await app.inject({ method: "GET", url: `/api/comparisons/${await startCompare(app, "Acme Co", "en_full")}/progress` })
    ).json().data;
    expect(en.unscored).toBe(1); // the Thai name
    expect(en.total).toBe(2);

    const th = (
      await app.inject({ method: "GET", url: `/api/comparisons/${await startCompare(app, "Acme Co", "th_full")}/progress` })
    ).json().data;
    expect(th.unscored).toBe(1); // the Latin one
    expect(th.total).toBe(2);
  });

  it("no longer accepts an `either_*` mode", async () => {
    await importCompany(app, { csv: CO_TH_EN });
    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: JSON.stringify({ company_names: ["Acme Co"], compare_by: "either_full" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a mode outside the vocabulary — the column has no CHECK behind it", async () => {
    await importCompany(app, { csv: CO_TH_EN });
    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: JSON.stringify({ company_names: ["Acme Co"], compare_by: "sideways_middle" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("carries the owner onto the result row, so rosters can be grouped from it", async () => {
    await importCompany(app, { csv: CO_TH_EN });
    await importFacebook(app, { ownedFriends: [["Somchai Jaidee", "Mint"]], uploader: "Assistant" });

    const id = await startCompare(app, "Acme Co");
    const results = (await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` })).json().data;
    // The OWNER, not the importer. This column is what every roster in the product groups by.
    expect(results.results[0].upload_name).toBe("Mint");
  });

  it("puts the owner, the uploader and a timestamp on every run row", async () => {
    await importCompany(app, { csv: CO_TH_EN });
    await importFacebook(app, { ownedFriends: [["Somchai Jaidee", "Mint"]], uploader: "Assistant" });

    const id = await startCompare(app, "Acme Co");
    const rows = (await app.inject({ method: "GET", url: `/api/comparisons/${id}/rows?page=1&limit=10` })).json();
    const row = rows.data[0];

    expect(row.relationshipOwner).toBe("Mint");
    expect(row.scored).toBe(true);
    // `friend.updated_at` — when the RECORD last moved, not when the verdict was written.
    expect(row.updatedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(row.updatedAt))).toBe(false);
  });
});

// ── The import type pick-list ───────────────────────────────────────────────

describe("upload sources", () => {
  it("serves the three it starts with, and reports how many imports use each", async () => {
    await importFacebook(app, { friends: [["Somchai", 1]], type: "linkedin" });

    const sources = (await app.inject({ method: "GET", url: "/api/upload-sources" })).json().data.sources;
    const byValue = Object.fromEntries(sources.map((s: { value: string }) => [s.value, s]));

    expect(Object.keys(byValue).sort()).toEqual(
      expect.arrayContaining(["business card", "facebook", "linkedin"])
    );
    // The use count is what lets a typo be told from a live value before anyone deletes it.
    expect(byValue["linkedin"].useCount).toBe(1);
    expect(byValue["business card"].useCount).toBe(0);
  });

  it("adds a type that persists, and is idempotent about it", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/api/upload-sources",
      payload: JSON.stringify({ value: "Trade Show" }),
      headers: { "content-type": "application/json" },
    });
    expect(a.statusCode).toBe(200);
    // Folded on the way in, so "Trade Show" and "trade show" cannot both exist.
    expect(a.json().data.value).toBe("trade show");

    // Two people typing the same thing on the same afternoon is not an error state.
    const b = await app.inject({
      method: "POST",
      url: "/api/upload-sources",
      payload: JSON.stringify({ value: "trade show" }),
      headers: { "content-type": "application/json" },
    });
    expect(b.statusCode).toBe(200);

    const after = (await app.inject({ method: "GET", url: "/api/upload-sources" })).json().data.sources;
    expect(after.filter((s: { value: string }) => s.value === "trade show")).toHaveLength(1);

    // Removable, and removing it is cosmetic — no FK points at the value.
    const del = await app.inject({ method: "DELETE", url: "/api/upload-sources/trade%20show" });
    expect(del.statusCode).toBe(200);
  });

  it("deletes one of the starting three like any other, and the picker still offers it", async () => {
    await importFacebook(app, { friends: [["Somchai", 1]], type: "facebook" });

    const del = await app.inject({ method: "DELETE", url: "/api/upload-sources/facebook" });
    expect(del.statusCode).toBe(200);

    // Which is why it needed no protecting. No FK points at the value, so the import keeps it,
    // and `list` unions the table with the values in use — so it is still on the picker, now
    // sourced from the row that carries it rather than from the table.
    const sources = (await app.inject({ method: "GET", url: "/api/upload-sources" })).json().data.sources;
    const fb = sources.find((s: { value: string }) => s.value === "facebook");
    expect(fb).toBeDefined();
    expect(fb.useCount).toBe(1);

    // Put it back: `truncateAll` leaves `upload_source` alone, so a test that left it deleted
    // would hand the next one a database the app never boots into.
    await app.inject({
      method: "POST",
      url: "/api/upload-sources",
      payload: JSON.stringify({ value: "facebook" }),
      headers: { "content-type": "application/json" },
    });
  });

  it("404s on a type the table has never held", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/upload-sources/carrier%20pigeon" });
    expect(res.statusCode).toBe(404);
  });

  it("leaves a company import's type null — the axis is about a friends list", async () => {
    await importCompany(app, { csv: CO_TH_EN });

    const pool = await DBModel.getPool();
    const db = await pool.connect();
    const res = await sql<{ source: string | null }>`
      select source from lakeshore.upload where kind = 'company'
    `.execute(db);
    // The import screen doesn't offer the picker on this side, and the server stores nothing for
    // it either — "where did these contacts come from" is a question about a friends export, not
    // about a company file, which is company data whatever tool produced it.
    expect(res.rows[0].source).toBeNull();
  });

  it("stores the chosen type on the import and its rows", async () => {
    await importFacebook(app, { friends: [["Somchai", 1]], type: "business card" });

    const pool = await DBModel.getPool();
    const db = await pool.connect();
    const res = await sql<{ upload: string; friend: string }>`
      select u.source as upload, f.source as friend
      from lakeshore.friend f join lakeshore.upload u on u.id = f.upload_id
    `.execute(db);
    expect(res.rows[0]).toEqual({ upload: "business card", friend: "business card" });
  });
});
