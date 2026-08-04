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
  it("scopes a COMPANY import's run to the friends the user picked", async () => {
    await importFacebook(app, { friends: [["somchai jaidee", 0]], owner: "Alex", type: "facebook" });
    await importFacebook(app, {
      friends: [["preecha wong", 0]],
      owner: "Mint",
      type: "linkedin",
      name: "li.csv",
    });

    // A company file has no provenance of its own — contacts came from no roster — so the ONLY
    // source on this request is the compare scope. That is the case that proves the two fields
    // are independent: there is nothing for it to have been derived from.
    const res = await importCompany(app, {
      csv: "company_name,name_en\nAcme Co,somchai jaidee\n",
      compareSources: ["linkedin"],
    });

    const comparisonId = res.json().data?.comparisonId;
    if (!comparisonId) return; // internal matcher opens no run at import

    const run = await app.inject({
      method: "GET",
      url: `/api/comparisons/${comparisonId}/progress`,
    });
    expect(run.json().data.sources).toEqual(["linkedin"]);
  });

  it("covers every friend when a company import names no compare source", async () => {
    await importFacebook(app, { friends: [["somchai jaidee", 0]], owner: "Alex", type: "facebook" });

    const res = await importCompany(app, {
      csv: "company_name,name_en\nAcme Co,somchai jaidee\n",
    });
    const comparisonId = res.json().data?.comparisonId;
    if (!comparisonId) return;

    const run = await app.inject({
      method: "GET",
      url: `/api/comparisons/${comparisonId}/progress`,
    });
    // Null, not [] — the pre-existing behaviour, unchanged by the field's arrival.
    expect(run.json().data.sources).toBeNull();
  });

  it("sends the compare scope to the company webhook, as a header and a column", async () => {
    await importFacebook(app, { friends: [["somchai jaidee", 0]], owner: "Alex", type: "linkedin" });
    mock.state.company.length = 0;

    await importCompany(app, {
      csv: "company_name,name_en\nAcme Co,somchai jaidee\n",
      compareSources: ["business card", "linkedin"],
    });

    const hit = mock.state.company.at(-1);
    expect(hit).toBeDefined();
    // Pipe-separated, folded and sorted — a comma would collide with a source value that has one
    // ("trade show, bangkok" is a legal entry), inside a cell that is already CSV-quoted.
    expect(hit!.headers["x-compare-sources"]).toBe("business card|linkedin");
    expect(hit!.body).toContain("compare_sources");
    expect(hit!.body).toContain("business card|linkedin");
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

  it("does not put a compare-scope column on the friends payload", async () => {
    mock.state.facebook.length = 0;
    await importFacebook(app, { friends: [["somchai jaidee", 0]], owner: "Alex", type: "linkedin" });

    const hit = mock.state.facebook.at(-1);
    expect(hit).toBeDefined();
    // A friends import hands over the exact rows to match, so there is no pool to narrow. The
    // column would be a key nothing reads, and its presence would invite a workflow to filter the
    // very rows it was just given.
    expect(hit!.body).not.toContain("compare_sources");
    expect(hit!.headers["x-compare-sources"]).toBeUndefined();
    // `type` is still there, and is a different fact: this file's own provenance.
    expect(hit!.body).toContain("linkedin");
  });

  it("ignores a compare scope sent on a friends import rather than applying it", async () => {
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
  return res.json().data as { run: { id: string } | null; runCount: number };
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
    const second = await startCompare(app, "Acme Co", "en_full", ["linkedin"]);

    const dup = await duplicate(["Acme Co"], "en_full", ["linkedin"]);
    expect(dup.runCount).toBe(2);
    // The freshest run is the one whose numbers someone deciding whether to repeat would want.
    expect(dup.run?.id).toBe(second);
  });

  it("never blocks the run it warns about", async () => {
    await seedTwoSources();
    const first = await startCompare(app, "Acme Co", "en_full", ["linkedin"]);
    const again = await startCompare(app, "Acme Co", "en_full", ["linkedin"]);

    // Advisory, by design: re-running after importing more friends is the case that must keep
    // working, and nothing here can tell that time from a misclick.
    expect(again).not.toBe(first);
  });
});
