import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import FormData from "form-data";
import {
  normalizeSources,
  sourceInRun,
  sourcesEqual,
  sourcesLabel,
  ALL_SOURCES_LABEL,
} from "@extensions/contract";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { importCompany, importFacebook, startCompare, truncateAll } from "./helpers";

/**
 * The 2026-08-03d change: WHICH FRIENDS a run covers.
 *
 * `compare_by` said how much of a name to score and in which language; nothing said whose names.
 * The matcher read every friend on file, so "compare my LinkedIn connections against this company"
 * could not be asked. `comparison.sources` is the answer and this is its contract.
 *
 * The two halves worth keeping apart, and the reason most of these tests exist:
 *
 *   · NULL means EVERY source. Not "none", not "unknown". Every assertion about a default run is
 *     really an assertion that nobody has quietly started reading it as an empty set.
 *   · A source filter EXCLUDES rows from the run, where the language axis INCLUDES them and marks
 *     them "Not compared". Two different narrowings that must not converge.
 */

let app: FastifyInstance;
let mock: MockServer;

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

// ── The vocabulary, with no database in the way ─────────────────────────────

describe("normalizeSources", () => {
  it("collapses every spelling of 'no opinion' to null", () => {
    // All four reach the same column value, which is what stops '{}' and NULL from both existing
    // and meaning opposite things.
    expect(normalizeSources(undefined)).toBeNull();
    expect(normalizeSources(null)).toBeNull();
    expect(normalizeSources([])).toBeNull();
    expect(normalizeSources(["", "   "])).toBeNull();
  });

  it("folds, trims and de-duplicates", () => {
    expect(normalizeSources([" LinkedIn ", "linkedin", "FACEBOOK"])).toEqual([
      "facebook",
      "linkedin",
    ]);
  });

  it("sorts, so two orders of the same ticks are one value", () => {
    // Load-bearing for the duplicate check, which compares arrays element-wise.
    expect(normalizeSources(["linkedin", "facebook"])).toEqual(
      normalizeSources(["facebook", "linkedin"])
    );
  });
});

describe("sourcesEqual", () => {
  it("treats two 'all sources' runs as the same question", () => {
    expect(sourcesEqual(null, null)).toBe(true);
  });

  it("does not treat 'all sources' as equal to a list that happens to name them all", () => {
    // Deliberate. They cover the same friends TODAY, but they are different questions: the null
    // run follows the data as new sources arrive, and the explicit one does not.
    expect(sourcesEqual(null, ["facebook", "linkedin"])).toBe(false);
  });

  it("compares lists element-wise once normalised", () => {
    expect(sourcesEqual(["facebook", "linkedin"], ["facebook", "linkedin"])).toBe(true);
    expect(sourcesEqual(["facebook"], ["linkedin"])).toBe(false);
    expect(sourcesEqual(["facebook"], ["facebook", "linkedin"])).toBe(false);
  });
});

describe("sourceInRun", () => {
  it("puts every friend in a null run", () => {
    expect(sourceInRun("linkedin", null)).toBe(true);
    // Even one whose source we somehow do not hold — a null run excludes nobody.
    expect(sourceInRun(null, null)).toBe(true);
  });

  it("matches case-insensitively, because the console writes this column too", () => {
    expect(sourceInRun("Facebook", ["facebook"])).toBe(true);
    expect(sourceInRun("linkedin", ["facebook"])).toBe(false);
  });
});

describe("sourcesLabel", () => {
  it("names a null run rather than leaving it blank", () => {
    expect(sourcesLabel(null)).toBe(ALL_SOURCES_LABEL);
    expect(sourcesLabel([])).toBe(ALL_SOURCES_LABEL);
  });

  it("names one and two, and counts three", () => {
    expect(sourcesLabel(["linkedin"])).toBe("LinkedIn");
    expect(sourcesLabel(["facebook", "linkedin"])).toBe("Facebook + LinkedIn");
    expect(sourcesLabel(["business card", "facebook", "linkedin"])).toBe("3 sources");
  });

  it("prefers the pick-list's own label over title-casing", () => {
    // 'LinkedIn' has an inner capital that no generic rule recovers.
    expect(sourcesLabel(["linkedin"], new Map([["linkedin", "LinkedIn"]]))).toBe("LinkedIn");
  });
});

// ── The run itself ──────────────────────────────────────────────────────────

/**
 * Two friends lists from two sources, against one company that has a contact matching each.
 *
 * Both friends are exact full-name matches for a contact, so every run below either finds a friend
 * or excluded them — there is no near-miss to explain an absence, which is what makes the counts
 * here read as statements about the filter rather than about the scorer.
 */
async function seedTwoSources(): Promise<void> {
  await importCompany(app, {
    csv: "company_name,name_en\nAcme Co,somchai jaidee\nAcme Co,preecha wong\n",
  });
  await importFacebook(app, {
    friends: [["somchai jaidee", 0]],
    owner: "Alex",
    type: "facebook",
    name: "fb.csv",
  });
  await importFacebook(app, {
    friends: [["preecha wong", 0]],
    owner: "Mint",
    type: "linkedin",
    name: "li.csv",
  });
}

const rowsOf = async (id: string) => {
  const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/rows?limit=100` });
  return res.json().data as { name: string; verdict: string }[];
};

describe("a run narrowed by source", () => {
  it("scores only the friends from the sources it names", async () => {
    await seedTwoSources();

    const id = await startCompare(app, "Acme Co", undefined, ["linkedin"]);
    const rows = await rowsOf(id);

    // The LinkedIn friend is in the run and matched. The Facebook friend is ABSENT — not present
    // and unmatched, and not present as "Not compared" either. A source filter decides who is in
    // the run; the language axis decides what happens to someone already in it.
    expect(rows.map((r) => r.name)).toEqual(["preecha wong"]);
  });

  it("covers everyone when no source is named", async () => {
    await seedTwoSources();

    const id = await startCompare(app, "Acme Co");
    const rows = await rowsOf(id);

    expect(rows.map((r) => r.name).sort()).toEqual(["preecha wong", "somchai jaidee"]);
  });

  it("treats an explicit list of every source the same way a null run does, in coverage", async () => {
    await seedTwoSources();

    const id = await startCompare(app, "Acme Co", undefined, ["facebook", "linkedin"]);
    const rows = await rowsOf(id);

    expect(rows.map((r) => r.name).sort()).toEqual(["preecha wong", "somchai jaidee"]);
  });

  it("unions the sources it names rather than intersecting them", async () => {
    await seedTwoSources();
    await importFacebook(app, {
      friends: [["nok srisai", 0]],
      owner: "Win",
      type: "business card",
      name: "cards.csv",
    });

    const id = await startCompare(app, "Acme Co", undefined, ["facebook", "linkedin"]);
    const rows = await rowsOf(id);

    // Both named sources are in; the third is out. "Facebook AND LinkedIn" is a set of rosters,
    // not a condition each friend has to satisfy twice.
    expect(rows.map((r) => r.name).sort()).toEqual(["preecha wong", "somchai jaidee"]);
  });

  it("stores the sources on the run, folded and sorted", async () => {
    await seedTwoSources();

    const id = await startCompare(app, "Acme Co", undefined, [" LinkedIn ", "FACEBOOK"]);
    const progress = await app.inject({ method: "GET", url: `/api/comparisons/${id}/progress` });

    expect(progress.json().data.sources).toEqual(["facebook", "linkedin"]);
  });

  it("reports a run that named no source as null, not as an empty list", async () => {
    await seedTwoSources();

    const id = await startCompare(app, "Acme Co");
    const progress = await app.inject({ method: "GET", url: `/api/comparisons/${id}/progress` });

    // The single most important assertion in this file. `[]` here would render as "no sources" on
    // every screen that shows the chip, turning the commonest run into one that claims to have
    // compared nobody.
    expect(progress.json().data.sources).toBeNull();
  });

  it("refuses a source nobody has imported under, before creating a run", async () => {
    await seedTwoSources();

    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: JSON.stringify({ company_names: ["Acme Co"], sources: ["trade show"] }),
      headers: { "content-type": "application/json" },
    });

    // A 400 rather than an empty run: it could only ever come back with nothing in it, and saying
    // so up front is cheaper than letting someone read a zero and wonder which half was wrong.
    expect(res.statusCode).toBe(400);
    expect(res.json().message ?? res.json().error).toMatch(/trade show/i);
  });

  it("still runs when only some of the named sources have friends", async () => {
    await seedTwoSources();

    // 'trade show' is empty, 'linkedin' is not. The run is meaningful, so it proceeds — the guard
    // is against a run with NOTHING in it, not against a selection with a gap in it.
    const id = await startCompare(app, "Acme Co", undefined, ["linkedin", "trade show"]);
    expect((await rowsOf(id)).map((r) => r.name)).toEqual(["preecha wong"]);
  });
});

describe("the source axis and the language axis are different narrowings", () => {
  it("excludes a filtered-out friend entirely, where a language mismatch keeps them as 'Not compared'", async () => {
    await importCompany(app, {
      csv: "company_name,name_en,name_th\nAcme Co,somchai jaidee,สมชาย ใจดี\n",
    });
    // The friend under test: Latin-only, imported from Facebook.
    await importFacebook(app, {
      friends: [["somchai jaidee", 0]],
      owner: "Alex",
      type: "facebook",
    });
    // A LinkedIn friend exists only so the source-narrowed run below is a legal one — the API
    // refuses a run whose sources hold nobody, which is itself asserted above. They match no
    // contact, so their presence cannot be mistaken for the fact under test.
    await importFacebook(app, {
      friends: [["nok srisai", 0]],
      owner: "Mint",
      type: "linkedin",
      name: "li.csv",
    });

    // The SAME Facebook friend, put through two different narrowings.
    const byLanguage = await startCompare(app, "Acme Co", "th_full", ["facebook"]);
    const bySource = await startCompare(app, "Acme Co", "en_full", ["linkedin"]);

    /**
     * The distinction lives in the COUNTS, not the row list, for a compare run.
     *
     * The internal matcher writes no `comparison_result` row for a friend its language could not
     * score — storing an `unmatch` would be claiming nobody at this company is called that, which
     * a run that never looked cannot claim. So the "Not compared" tally is counted off `friend`
     * instead (see `ComparisonResultModel.statusCounts`), and that is where the two narrowings
     * visibly differ.
     */
    const countsOf = async (id: string) =>
      (await app.inject({ method: "GET", url: `/api/comparisons/${id}/progress` })).json().data;

    // Language: the friend is IN the run and accounted for — counted as one the run could not
    // score, and part of its denominator.
    const lang = await countsOf(byLanguage);
    expect(lang.unscored).toBe(1);
    expect(lang.total).toBe(1);

    // Source: the friend is not in the run at all. They are in neither the rows nor the counts,
    // and the denominator is about the LinkedIn friend alone.
    const src = await countsOf(bySource);
    expect(src.unscored).toBe(0);
    expect(src.total).toBe(1);
    expect((await rowsOf(bySource)).map((r) => r.name)).toEqual(["nok srisai"]);
  });

  it("does not count friends from other sources as this run's 'Not compared'", async () => {
    await importCompany(app, {
      csv: "company_name,name_en,name_th\nAcme Co,somchai jaidee,สมชาย ใจดี\n",
    });
    // Three Facebook friends with no Thai name, and one LinkedIn friend, also with no Thai name.
    await importFacebook(app, {
      friends: [["a one", 0], ["b two", 0], ["c three", 0]],
      owner: "Alex",
      type: "facebook",
    });
    await importFacebook(app, {
      friends: [["d four", 0]],
      owner: "Mint",
      type: "linkedin",
      name: "li.csv",
    });

    // A Thai run over LinkedIn alone. Every friend on file is unscorable under `th_full`, so a
    // count that ignored the source filter would report all four.
    const id = await startCompare(app, "Acme Co", "th_full", ["linkedin"]);
    const counts = (
      await app.inject({ method: "GET", url: `/api/comparisons/${id}/progress` })
    ).json().data;

    // One, not four. The run covered one person and says so — a denominator of 4 over a row list
    // of 1 would read as a broken table rather than as a wrong count.
    expect(counts.unscored).toBe(1);
    expect(counts.total).toBe(1);
  });
});

describe("upload source and compare source are different fields", () => {
  /**
   * ── AN IMPORT NO LONGER CARRIES A COMPARE SCOPE AT ALL (2026-08-05) ──
   *
   * The company path took one until the import screen's "Whose friends" picker was removed. It went
   * for the reason `compareBy` went: narrowing the sources changes the ANSWER and nothing else, so a
   * reader who wanted a different answer had to upload their contacts a second time to ask for it —
   * writing a complete duplicate row set to change one column on the run above it.
   *
   * What the two fields MEAN is unchanged and is still worth pinning down, which is what the rest of
   * this suite does: `sourceType` is the file's permanent provenance, `sources` on a run is which
   * friends it covered. They are simply no longer answered on the same screen.
   *
   * The picked scope lives on `POST /compare` now, where it composes with a run scope — see
   * scoped-compare.test.ts.
   */
  it("covers every friend on file, whatever a caller asks for", async () => {
    await importFacebook(app, { friends: [["somchai jaidee", 0]], owner: "Alex", type: "facebook" });
    await importFacebook(app, {
      friends: [["preecha wong", 0]],
      owner: "Mint",
      type: "linkedin",
      name: "li.csv",
    });

    // A caller that predates the change, still sending the field. It is stripped by
    // `ImportFieldsSchema` rather than honoured or refused — a 400 would break a scripted importer
    // over a value that no longer decides anything.
    const form = new FormData();
    form.append("name", "Company import");
    form.append("uploadPersonName", "Tester");
    form.append("compareSources", JSON.stringify(["linkedin"]));
    form.append("companyFile", Buffer.from("company_name,name_en\nAcme Co,somchai jaidee\n", "utf8"), {
      filename: "company.csv",
      contentType: "text/csv",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons/run",
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode, res.body).toBe(200);

    const comparisonId = res.json().data?.comparisonId;
    if (!comparisonId) return; // internal matcher opens no run at import

    const run = await app.inject({
      method: "GET",
      url: `/api/comparisons/${comparisonId}/progress`,
    });
    // NULL — every source. Not `['linkedin']`, which is the whole assertion: the run describes what
    // it actually covered, and an import covers every friend on file.
    expect(run.json().data.sources).toBeNull();
  });

  it("sends no compare-source header or value on an import", async () => {
    await importFacebook(app, { friends: [["somchai jaidee", 0]], owner: "Alex", type: "linkedin" });
    mock.state.company.length = 0;

    await importCompany(app, { csv: "company_name,name_en\nAcme Co,somchai jaidee\n" });

    const hit = mock.state.company.at(-1);
    expect(hit).toBeDefined();
    // Absent, and now that is the only way it can be said — there is no body, so there is no empty
    // cell to also mean "every source". One spelling of the default instead of two.
    expect(hit!.headers["x-compare-sources"]).toBeUndefined();
    expect(hit!.body).toBe("");
  });

  it("omits the header entirely when the run covers every source", async () => {
    await importFacebook(app, { friends: [["somchai jaidee", 0]], owner: "Alex", type: "facebook" });
    mock.state.company.length = 0;

    await importCompany(app, { csv: "company_name,name_en\nAcme Co,somchai jaidee\n" });

    const hit = mock.state.company.at(-1);
    expect(hit).toBeDefined();
    // Absent, not empty: a workflow that never implements this header then behaves exactly as it
    // does today, which is correct for an unscoped run.
    expect(hit!.headers["x-compare-sources"]).toBeUndefined();
  });

  it("sends no source narrowing on a friends IMPORT either", async () => {
    mock.state.facebook.length = 0;
    await importFacebook(app, { friends: [["somchai jaidee", 0]], owner: "Alex", type: "linkedin" });

    const hit = mock.state.facebook.at(-1);
    expect(hit).toBeDefined();
    /**
     * An import names its rows exactly, by upload id, and every one of them carries the single
     * `type` the review screen collected. Narrowing that selection by the property all of its
     * members already share would narrow nothing.
     *
     * The friends direction DOES carry the header when a run genuinely narrows — an owner-scoped
     * compare against LinkedIn friends only. It used to be suppressed there too, and the run came
     * back matched against every source while the page chipped it "LinkedIn". See
     * scoped-compare-webhook.test.ts.
     */
    expect(hit!.headers["x-compare-sources"]).toBeUndefined();
    expect(hit!.body).toBe("");
  });

  it("ignores a compare scope sent on a friends import rather than applying it", async () => {
    // Still true, and now true on BOTH paths — the field is off the schema entirely. This one is
    // kept because the friends path has a second, stronger reason: its run must report the source
    // its rows actually carry, so a scope reaching it would make the run lie about itself.
    const form = new FormData();
    form.append("name", "friends.csv");
    form.append("uploadPersonName", "Alex");
    form.append("sourceType", "facebook");
    // A caller sending this on the wrong path: the run must describe what it actually covered,
    // which is this file's own rows, not the scope somebody asked for.
    form.append("compareSources", JSON.stringify(["linkedin"]));
    form.append("facebookFile", Buffer.from("name\nsomchai jaidee\n", "utf8"), {
      filename: "friends.csv",
      contentType: "text/csv",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons/run",
      payload: form,
      headers: form.getHeaders(),
    });

    const comparisonId = res.json().data?.comparisonId;
    if (!comparisonId) return;

    const run = await app.inject({
      method: "GET",
      url: `/api/comparisons/${comparisonId}/progress`,
    });
    // 'facebook' — the file's own type — and NOT the 'linkedin' scope that was sent.
    expect(run.json().data.sources).toEqual(["facebook"]);
  });
});

describe("an import-driven run describes its own source", () => {
  it("stamps the friends import's type on the run it opens", async () => {
    await importCompany(app, { csv: "company_name,name_en\nAcme Co,somchai jaidee\n" });
    const res = await importFacebook(app, {
      friends: [["somchai jaidee", 0]],
      owner: "Alex",
      type: "linkedin",
    });

    const comparisonId = res.json().data?.comparisonId;
    // Only the external matcher opens a run at import; with the internal one there is nothing to
    // assert here and the test is vacuous rather than wrong.
    if (!comparisonId) return;

    const progress = await app.inject({
      method: "GET",
      url: `/api/comparisons/${comparisonId}/progress`,
    });
    // Observed, not chosen: every row of this import carries 'linkedin', so the run really did
    // cover exactly that source.
    expect(progress.json().data.sources).toEqual(["linkedin"]);
  });
});

// ── The duplicate check ─────────────────────────────────────────────────────

const duplicate = async (companies: string[], compareBy?: string, sources?: string[]) => {
  const sp = new URLSearchParams();
  for (const c of companies) sp.append("company", c);
  if (compareBy) sp.set("compare_by", compareBy);
  for (const s of sources ?? []) sp.append("source", s);
  const res = await app.inject({ method: "GET", url: `/api/comparisons/duplicate?${sp}` });
  return res.json().data as { run: { id: string } | null; runCount: number; blocked: boolean };
};

describe("the duplicate-run check", () => {
  it("finds a run that asked the same question on all three axes", async () => {
    await seedTwoSources();
    const id = await startCompare(app, "Acme Co", "en_full", ["linkedin"]);

    const dup = await duplicate(["Acme Co"], "en_full", ["linkedin"]);
    expect(dup.run?.id).toBe(id);
    expect(dup.runCount).toBe(1);
  });

  it("reports nothing when the SOURCE differs — which is the whole point of the feature", async () => {
    await seedTwoSources();
    await startCompare(app, "Acme Co", "en_full", ["linkedin"]);

    // Same companies, same mode, different friends. A different question, so it may be asked.
    expect((await duplicate(["Acme Co"], "en_full", ["facebook"])).run).toBeNull();
    // And "all sources" is different again from either list.
    expect((await duplicate(["Acme Co"], "en_full")).run).toBeNull();
  });

  it("reports nothing when the COMPARE TYPE differs", async () => {
    await seedTwoSources();
    await startCompare(app, "Acme Co", "en_full", ["linkedin"]);

    expect((await duplicate(["Acme Co"], "en_surname", ["linkedin"])).run).toBeNull();
    expect((await duplicate(["Acme Co"], "th_full", ["linkedin"])).run).toBeNull();
  });

  it("ignores the order companies were picked in", async () => {
    await importCompany(app, {
      csv: "company_name,name_en\nAcme Co,somchai jaidee\nBeta Ltd,preecha wong\n",
    });
    await importFacebook(app, { friends: [["somchai jaidee", 0]], owner: "Alex", type: "facebook" });

    const id = await startCompare(app, ["Acme Co", "Beta Ltd"], "en_full");
    expect((await duplicate(["Beta Ltd", "Acme Co"], "en_full")).run?.id).toBe(id);
  });

  it("does not report a run against a different set of companies", async () => {
    await importCompany(app, {
      csv: "company_name,name_en\nAcme Co,somchai jaidee\nBeta Ltd,preecha wong\n",
    });
    await importFacebook(app, { friends: [["somchai jaidee", 0]], owner: "Alex", type: "facebook" });

    await startCompare(app, ["Acme Co", "Beta Ltd"], "en_full");
    // A subset is not the same question — it scores against a smaller contact pool.
    expect((await duplicate(["Acme Co"], "en_full")).run).toBeNull();
  });

  it("counts repeats, and hands back the newest", async () => {
    await seedTwoSources();
    await startCompare(app, "Acme Co", "en_full", ["linkedin"]);
    // A repeat has to be EARNED now — see the block tests below. The import is what makes the
    // second run a legal question rather than a copy of the first, and it has to bring somebody
    // NEW: a file whose every row is already on file is refused by the import pre-check, so
    // re-importing "preecha wong" would land nothing and the run would still be a copy.
    await importFacebook(app, {
      friends: [["anong pat", 0]],
      owner: "Mint",
      type: "linkedin",
      name: "li2.csv",
    });
    const second = await startCompare(app, "Acme Co", "en_full", ["linkedin"]);

    const dup = await duplicate(["Acme Co"], "en_full", ["linkedin"]);
    expect(dup.runCount).toBe(2);
    // The freshest run is the one whose numbers someone deciding whether to repeat would want.
    expect(dup.run?.id).toBe(second);
  });
});

/**
 * ── The block ───────────────────────────────────────────────────────────────
 *
 * The duplicate check stopped being advisory on 2026-08-06. What is asserted here is the SHAPE of
 * the rule rather than merely its refusal: a run is refused when repeating it could only reproduce
 * an answer already on file, and it becomes askable again the moment that stops being true.
 *
 * The second half is the half worth guarding. A flat "you already ran this" would be one line of
 * code and would trap somebody who has just imported the exact friends they were told to import —
 * with no way out but deleting a good run.
 */
describe("a run that would read the same rows is refused", () => {
  /** The raw POST, because `startCompare` throws on anything that is not a 200. */
  const compare = (body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

  const sameQuestion = { company_names: ["Acme Co"], compare_by: "en_full", sources: ["linkedin"] };

  it("409s the immediate repeat, and says what would make it askable", async () => {
    await seedTwoSources();
    await startCompare(app, "Acme Co", "en_full", ["linkedin"]);

    const again = await compare(sameQuestion);
    expect(again.statusCode).toBe(409);
    // The way out is named IN THE REFUSAL. A 409 whose message stops at "you already ran this"
    // reads as a broken feature — this one has to say that importing lifts it.
    expect(again.json().message).toMatch(/already run this/i);
    expect(again.json().message).toMatch(/imported since/i);

    // …and the dialog is told the same thing before anybody presses anything.
    const dup = await duplicate(["Acme Co"], "en_full", ["linkedin"]);
    expect(dup.blocked).toBe(true);
    expect(dup.run).not.toBeNull();
  });

  it("lifts as soon as a friend the run covers lands — no deletion, nothing to undo", async () => {
    await seedTwoSources();
    await startCompare(app, "Acme Co", "en_full", ["linkedin"]);
    expect((await compare(sameQuestion)).statusCode).toBe(409);

    await importFacebook(app, {
      friends: [["anong pat", 0]],
      owner: "Mint",
      type: "linkedin",
      name: "li2.csv",
    });

    // The run is still reported as a duplicate while it is no longer a refusal: "you ran this, and
    // the data has moved since" is worth saying, it is just not worth blocking.
    const dup = await duplicate(["Acme Co"], "en_full", ["linkedin"]);
    expect(dup.run).not.toBeNull();
    expect(dup.blocked).toBe(false);

    // THE CASE THE WHOLE RULE EXISTS FOR. Same four axes, genuinely different answer waiting.
    expect((await compare(sameQuestion)).statusCode).toBe(200);
    // …and the block is back immediately after it, anchored on the run that has now read those
    // rows. The rule is per-ANSWER, not per-import: one import buys one re-run, not a licence.
    expect((await duplicate(["Acme Co"], "en_full", ["linkedin"])).blocked).toBe(true);
  });

  it("lifts on a CONTACT landing too — a run has two sides", async () => {
    await seedTwoSources();
    await startCompare(app, "Acme Co", "en_full", ["linkedin"]);
    expect((await compare(sameQuestion)).statusCode).toBe(409);

    // Nobody new to compare, but somebody new to compare them AGAINST. Asking only about friends
    // would leave a fresh company import uncomparable.
    await importCompany(app, { csv: "company_name,name_en\nAcme Co,niran srisuk\n", name: "co2.csv" });

    expect((await compare(sameQuestion)).statusCode).toBe(200);
  });

  it("is not lifted by rows the run does not read", async () => {
    await seedTwoSources();
    await startCompare(app, "Acme Co", "en_full", ["linkedin"]);

    // A FACEBOOK friend, for a LINKEDIN run. The run cannot see them, so its answer cannot have
    // changed — a table-wide "has anything been imported?" would unblock every run in the product
    // on any import at all, which is the feature not existing.
    await importFacebook(app, {
      friends: [["anong pat", 0]],
      owner: "Alex",
      type: "facebook",
      name: "fb2.csv",
    });

    expect((await compare(sameQuestion)).statusCode).toBe(409);
    expect((await duplicate(["Acme Co"], "en_full", ["linkedin"])).blocked).toBe(true);
  });

  it("does not touch a DIFFERENT question", async () => {
    await seedTwoSources();
    await startCompare(app, "Acme Co", "en_full", ["linkedin"]);

    // One axis moved on each. None of them is the run that was already asked, so none is refused —
    // this is the "run again if the compare type or the source differs" rule, enforced rather than
    // merely reported.
    expect((await compare({ ...sameQuestion, compare_by: "th_full" })).statusCode).toBe(200);
    expect((await compare({ ...sameQuestion, sources: ["facebook"] })).statusCode).toBe(200);
    expect((await compare({ ...sameQuestion, company_names: null })).statusCode).toBe(200);
  });
});
