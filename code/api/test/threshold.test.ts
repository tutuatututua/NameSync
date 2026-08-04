import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { regradeVerdict, rowVerdict, type RowVerdict } from "@extensions/contract";
import { DBModel } from "@extensions/sqldb";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { importCompany, importFacebook, startCompare, truncateAll } from "./helpers";

/**
 * The display threshold — reading a finished run at a bar the reader picked.
 *
 * What is actually under test is an INVARIANT rather than a number: the tally above the table, the
 * filter that pages it, the status each row carries, and the headline count all have to describe
 * the same bar. They are computed in four different places (a GROUP BY, a WHERE, a projected CASE,
 * and a TypeScript filter over the results payload), which is exactly why they are worth a test —
 * "Matches 41" over a filter that returns 18 rows is the failure this feature can produce, and it
 * is silent.
 *
 * The other half is that the default must not have moved. Every assertion about an un-thresholded
 * read is a regression test for the endpoints as they behaved before the parameter existed.
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

// ── The rule itself, with no database under it ──────────────────────────────

describe("regradeVerdict", () => {
  it("is the identity function when no bar was asked for", () => {
    // The default path, and the one every existing caller takes. A change here is a change to
    // every read of every run, which is the thing this feature promised not to be.
    for (const v of ["pending", "matched", "unmatched", "failed"] as RowVerdict[]) {
      expect(regradeVerdict(v, 0.1, null)).toBe(v);
      expect(regradeVerdict(v, 0.99, undefined)).toBe(v);
    }
  });

  it("never re-grades a row that is unfinished or broken", () => {
    // A row nobody has decided is not "not a match", and a row that broke is not one either. A
    // score — if there even is one — cannot overrule the absence of an answer.
    expect(regradeVerdict("pending", 0.99, 0.1)).toBe("pending");
    expect(regradeVerdict("failed", 0.99, 0.1)).toBe("failed");
    expect(regradeVerdict("pending", null, 0.1)).toBe("pending");
  });

  it("leaves a row with no score at its stored verdict", () => {
    // An external workflow that reports verdicts and no numbers has told us what it decided and
    // nothing about how close it was. Re-grading it would mean inventing the number.
    expect(regradeVerdict("matched", null, 0.9)).toBe("matched");
    expect(regradeVerdict("unmatched", undefined, 0.1)).toBe("unmatched");
  });

  it("grades on the bar, inclusively, in both directions", () => {
    // Both directions: a stored match can fall below a raised bar, and a stored unmatch can rise to
    // meet a lowered one. A rule that only tightened would be a filter, not a threshold.
    expect(regradeVerdict("matched", 0.62, 0.8)).toBe("unmatched");
    expect(regradeVerdict("unmatched", 0.62, 0.5)).toBe("matched");
    // `>=`, matching the matcher's own comparison — a row scoring exactly the bar is a match.
    expect(regradeVerdict("unmatched", 0.8, 0.8)).toBe("matched");
    expect(regradeVerdict("matched", 0.79, 0.8)).toBe("unmatched");
  });
});

// ── Over a real run ─────────────────────────────────────────────────────────

/**
 * Two contacts and two friends who are exact matches for them, plus one friend who is nobody.
 *
 * Exact spellings on purpose: they score 1.0, so they sit above every bar the tests raise and the
 * assertions are about the threshold rather than about the trigram measure's opinion of a typo.
 * "Zebediah Quaid" shares almost no trigrams with either contact, so it sits near 0 and only a bar
 * dropped to the floor can pull it up — which is what makes "threshold=0 matches everything scored"
 * a real assertion rather than a vacuous one.
 */
const CSV = "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\nAcme Co,อนงค์,Anong\n";
const FRIENDS: [string, number][] = [
  ["Somchai", 1700000000],
  ["Anong", 1700000100],
  ["Zebediah Quaid", 1700000200],
];

const progressAt = async (id: string, threshold?: number) => {
  const url = `/api/comparisons/${id}/progress${threshold === undefined ? "" : `?threshold=${threshold}`}`;
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};

const rowsAt = async (
  id: string,
  opts: { threshold?: number; filter?: string; limit?: number } = {}
) => {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
  if (opts.threshold !== undefined) params.set("threshold", String(opts.threshold));
  if (opts.filter) params.set("filter", opts.filter);
  const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/rows?${params}` });
  expect(res.statusCode).toBe(200);
  return res.json();
};

const resultsAt = async (id: string, threshold?: number) => {
  const url = `/api/comparisons/${id}/results${threshold === undefined ? "" : `?threshold=${threshold}`}`;
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};

/** One compare run over the fixture above — the internal matcher, so every row carries a score. */
async function seedCompare(): Promise<string> {
  await importCompany(app, { csv: CSV });
  await importFacebook(app, { friends: FRIENDS });
  return startCompare(app, "Acme Co");
}

describe("reading a run at a chosen threshold", () => {
  it("changes nothing when no threshold is asked for", async () => {
    const id = await seedCompare();
    const p = await progressAt(id);

    // The matcher's own answer: two exact names matched at 1.0, the stranger did not.
    expect(p.total).toBe(3);
    expect(p.matched).toBe(2);
    expect(p.unmatched).toBe(1);
    // Echoed as null, not as the matcher's bar — "nobody asked for one" is a different fact from
    // "one was asked for and it happened to be 0.8".
    expect(p.threshold).toBeNull();
    // A compare run was decided in-process, so its bar is knowable and is reported for the control
    // to return to.
    expect(p.matcherThreshold).toBe(0.8);
    expect(p.hasSimilarity).toBe(true);
  });

  it("re-grades the tally without moving the population", async () => {
    const id = await seedCompare();

    // At the ceiling: the exact names score 1.0 and the bar is inclusive, so they still clear it —
    // and the stranger, who is nowhere near, still does not.
    const strict = await progressAt(id, 1);
    expect(strict.matched).toBe(2);
    expect(strict.unmatched).toBe(1);

    // Dropped to the floor: everything the run actually scored is a match.
    const loose = await progressAt(id, 0);
    expect(loose.matched).toBe(3);
    expect(loose.unmatched).toBe(0);
    expect(loose.threshold).toBe(0);

    // The bar moves the SPLIT and never the population. A threshold that changed `total` would be
    // filtering rows out of the run rather than re-grading them, and every "x of y" on the page
    // would quietly start reporting a different y.
    for (const p of [strict, loose, await progressAt(id)]) {
      expect(p.total).toBe(3);
      expect(p.matched + p.unmatched + p.pending + p.failed + p.unscored).toBe(3);
    }
  });

  it("keeps the filter, the count and each row's badge on the same bar", async () => {
    const id = await seedCompare();

    for (const threshold of [undefined, 0, 0.5, 0.999]) {
      const p = await progressAt(id, threshold);
      const matched = await rowsAt(id, { threshold, filter: "matched" });
      const unmatched = await rowsAt(id, { threshold, filter: "unmatched" });

      // The tab's number is the filter's answer. These come from a GROUP BY and a WHERE over two
      // separately-built expressions; "Matches 41" above a page of 18 is what it looks like when
      // they drift.
      expect(matched.pagination.total).toBe(p.matched);
      expect(unmatched.pagination.total).toBe(p.unmatched);

      // And each returned row badges itself the way the filter that returned it claims. The client
      // draws the badge from `status` alone, so a row in the `matched` bucket carrying the stamp
      // the matcher originally left would render "No match" inside the Matches tab.
      for (const row of matched.data) expect(rowVerdict(row.status)).toBe("matched");
      for (const row of unmatched.data) expect(rowVerdict(row.status)).toBe("unmatched");
    }
  });

  it("agrees with the headline count on the results payload", async () => {
    const id = await seedCompare();
    // Three readers of one run — a SQL tally, a SQL filter and a TypeScript pass over the results
    // payload. The page shows all three at once, so they have to be one answer.
    for (const threshold of [undefined, 0, 0.9]) {
      const p = await progressAt(id, threshold);
      const r = await resultsAt(id, threshold);
      expect(r.matchCount).toBe(p.matched);
    }
  });

  it("does not let a bar decide a row the run never looked at", async () => {
    await importCompany(app, { csv: CSV });
    await importFacebook(app, { friends: FRIENDS });
    // A Thai run over Latin-script friends: nobody has a Thai name on file, so every friend is
    // "not compared" — a question that was never asked, which no threshold is entitled to answer.
    const id = await startCompare(app, "Acme Co", "th_full");

    const base = await progressAt(id);
    expect(base.unscored).toBe(3);

    for (const threshold of [0, 0.5, 1]) {
      const p = await progressAt(id, threshold);
      expect(p.unscored).toBe(3);
      expect(p.matched).toBe(0);
      expect(p.total).toBe(base.total);
    }
  });

  it("refuses a bar outside [0, 1] rather than clamping it", async () => {
    const id = await seedCompare();
    // `threshold=8` is somebody who meant 0.8. Clamped to 1 it would silently answer a question
    // they did not ask, with every row reading "No match" and nothing saying why.
    for (const bad of ["8", "-0.1", "banana"]) {
      const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/progress?threshold=${bad}` });
      expect(res.statusCode).toBe(400);
    }
  });

  it("holds the run's rows still when only the bar moved", async () => {
    const id = await seedCompare();
    // Re-grading must not add, drop or reorder the run's rows — it relabels them. The unfiltered
    // list at two bars is the same list, or the "threshold" is quietly a filter with a bad name.
    const before = await rowsAt(id);
    const after = await rowsAt(id, { threshold: 0.2 });
    expect(after.pagination.total).toBe(before.pagination.total);
    expect(after.data.map((r: { id: string }) => r.id).sort()).toEqual(
      before.data.map((r: { id: string }) => r.id).sort()
    );
    // The scores are the run's own and are untouched by the bar — it is the verdict beside them
    // that moved. A threshold that rewrote `similarity` would have re-scored the run, not re-read it.
    const scoreOf = (rows: { id: string; similarity: number | null }[]) =>
      Object.fromEntries(rows.map((r) => [r.id, r.similarity]));
    expect(scoreOf(after.data)).toEqual(scoreOf(before.data));
  });
});

// ── Over the whole Network workspace ────────────────────────────────────────

/**
 * The same overlay, applied where it now lives: the pooled answer rather than one run.
 *
 * The bar moved off the run page on 2026-07-31 because tuning a historical event moved nothing
 * anybody acts on. What people read is `/api/network/*` — how many of a roster's friends were
 * placed, which companies they reach, who knows a contact — and every one of those numbers is a
 * count over `comparison_result` computed in a DIFFERENT query, several of them in hand-written SQL
 * subqueries rather than through the builder. That is the whole risk this block exists for: a bar
 * honoured by the Overview and forgotten by one subquery in `search` produces a workspace that
 * contradicts itself one click deep, and nothing errors.
 */

const overviewAt = async (threshold?: number) => {
  const res = await app.inject({
    method: "GET",
    url: `/api/network/overview${threshold === undefined ? "" : `?threshold=${threshold}`}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};

const uploadersAt = async (threshold?: number) => {
  const res = await app.inject({
    method: "GET",
    url: `/api/network/uploaders${threshold === undefined ? "" : `?threshold=${threshold}`}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.uploaders;
};

const rosterAt = async (name: string, threshold?: number) => {
  const params = new URLSearchParams({ name });
  if (threshold !== undefined) params.set("threshold", String(threshold));
  const res = await app.inject({ method: "GET", url: `/api/network/uploader?${params}` });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};

const searchAt = async (q: string, threshold?: number) => {
  const params = new URLSearchParams({ q, limit: "50" });
  if (threshold !== undefined) params.set("threshold", String(threshold));
  const res = await app.inject({ method: "GET", url: `/api/network/search?${params}` });
  expect(res.statusCode).toBe(200);
  return res.json();
};

describe("reading the network at a chosen threshold", () => {
  it("changes nothing when no threshold is asked for", async () => {
    await seedCompare();

    // The matchers' own answer, byte for byte what these endpoints returned before the parameter
    // existed: two exact names placed, the stranger not.
    const ov = await overviewAt();
    expect(ov.friends).toBe(3);
    expect(ov.friendsMatched).toBe(2);
    expect(ov.connected).toHaveLength(1);
    expect(ov.connected[0]).toMatchObject({ company: "Acme Co", connections: 2 });

    const [roster] = await uploadersAt();
    expect(roster).toMatchObject({ uploader: "Tester", friends: 3, matched: 2, noMatch: 1 });
  });

  it("re-grades every tally on the workspace from one bar", async () => {
    await seedCompare();

    // Dropped to the floor, the stranger's row clears it and he becomes a connection — in the
    // headline, in the company's reach, and in the roster tab, which are three separate queries.
    const loose = await overviewAt(0);
    expect(loose.friendsMatched).toBe(3);
    expect(loose.connected[0].connections).toBe(3);
    expect((await uploadersAt(0))[0]).toMatchObject({ matched: 3, noMatch: 0 });

    // At the ceiling the exact names still clear an inclusive bar, and nothing else does.
    const strict = await overviewAt(1);
    expect(strict.friendsMatched).toBe(2);
    expect((await uploadersAt(1))[0]).toMatchObject({ matched: 2, noMatch: 1 });

    // The roster itself never moves. `friends` counts friend rows, so it is the fixed denominator
    // the split is taken out of — a bar that shrank it too would hold the ratio suspiciously still
    // and hide what tightening actually costs.
    for (const ov of [loose, strict, await overviewAt(0.5)]) expect(ov.friends).toBe(3);
  });

  it("keeps `confirmed` a fact about the run, not about the bar", async () => {
    await seedCompare();
    // Confirmed means the run compared WHOLE names — a property of `comparison.compare_by`. No bar
    // may promote a lead, and the subset relation has to survive both directions of re-grading or
    // a tile could read "2 matched · 3 confirmed".
    for (const t of [undefined, 0, 0.5, 1]) {
      const ov = await overviewAt(t);
      expect(ov.friendsConfirmed).toBeLessThanOrEqual(ov.friendsMatched);
      for (const c of ov.connected) expect(c.confirmed).toBeLessThanOrEqual(c.connections);
    }
  });

  it("moves a roster's two lists together, so a friend is never in both or neither", async () => {
    await seedCompare();

    for (const t of [undefined, 0, 0.5, 1]) {
      const roster = await rosterAt("Tester", t);
      const placed = new Set(
        roster.matchedByCompany.flatMap((g: { people: { friend: string }[] }) =>
          g.people.map((p) => p.friend)
        )
      );
      // The matched fold and the near-miss fold are separate queries over the same rows, and they
      // partition the roster between them. A bar honoured by one and not the other leaves a friend
      // listed as placed and unplaced at once — or, at a raised bar, missing from both lists.
      for (const p of roster.noMatchPeople) expect(placed.has(p.friend)).toBe(false);
      expect(roster.matched + roster.noMatch).toBe(roster.friends);
      expect(roster.noMatchPeople).toHaveLength(roster.noMatch);
    }

    // And it agrees with the tab that links to it — the drill-down is the same answer, spelled out.
    for (const t of [undefined, 0, 1]) {
      expect((await rosterAt("Tester", t)).matched).toBe((await uploadersAt(t))[0].matched);
    }
  });

  it("grades who reaches a company without changing who works there", async () => {
    await seedCompare();

    const base = await searchAt("Somchai");
    const loose = await searchAt("Somchai", 0);
    const strict = await searchAt("Somchai", 1);

    // Who is ON FILE at a company is a fact about `company_contact` and no bar may touch it. A
    // threshold that emptied this list would make the page say "nobody is here" when it means
    // "nobody you know is here" — two very different answers.
    expect(base.data.length).toBeGreaterThan(0);
    expect(loose.pagination.total).toBe(base.pagination.total);
    expect(strict.pagination.total).toBe(base.pagination.total);

    // What DOES move is the network fact on the row. This one goes through the hand-written
    // subqueries rather than the builder, so it is the one most able to be forgotten.
    expect(loose.data[0].companyConnections).toBe(3);
    expect(base.data[0].companyConnections).toBe(2);
    expect(strict.data[0].companyConnections).toBe(2);

    // And it agrees with the Overview's count for the same company, which is computed by an
    // entirely different query — the number the reader sees before and after clicking through.
    for (const [t, res] of [
      [undefined, base],
      [0, loose],
      [1, strict],
    ] as const) {
      const ov = await overviewAt(t);
      const company = ov.connected.find((c: { company: string }) => c.company === "Acme Co");
      expect(res.data[0].companyConnections).toBe(company.connections);
    }
  });

  it("refuses a bar outside [0, 1] on every endpoint rather than clamping it", async () => {
    await seedCompare();
    const urls = [
      "/api/network/overview",
      "/api/network/uploaders",
      "/api/network/uploader?name=Tester",
      "/api/network/search?q=Somchai",
    ];
    for (const url of urls) {
      for (const bad of ["8", "-0.1", "banana"]) {
        const sep = url.includes("?") ? "&" : "?";
        const res = await app.inject({ method: "GET", url: `${url}${sep}threshold=${bad}` });
        expect(res.statusCode).toBe(400);
      }
    }
  });
});

// ── What the bar can actually move ──────────────────────────────────────────

/**
 * The fact that stops the control reading as broken.
 *
 * `regradeVerdict` leaves a row with no `similarity` at its stored verdict — right, and severe in
 * practice: on the live database 253 of 300 result rows are `no_match` with a null score, so the
 * bar re-grades 47 rows and the headline moves by three across its whole travel. From the outside
 * "the bar does nothing" and "the bar has nothing to work on" are the same picture, which is why
 * the workspace reports the difference rather than leaving the reader to infer it.
 */
describe("what the threshold can move", () => {
  const gradingCoverage = async () => {
    const res = await app.inject({ method: "GET", url: "/api/network/grading" });
    expect(res.statusCode).toBe(200);
    return res.json().data;
  };

  it("counts the rows carrying a score against the rows on file", async () => {
    await seedCompare();
    const { results, scored } = await gradingCoverage();
    // The internal matcher scores every row it looks at, so a compare run is fully gradable —
    // which is exactly the case that must NOT show the caveat.
    expect(results).toBe(3);
    expect(scored).toBe(3);
  });

  it("reports the shortfall when a matcher recorded verdicts without scores", async () => {
    // The external-workflow shape, which is what the live database looks like: a verdict and no
    // number. Written straight to `comparison_result` because that is how the callback route
    // stores what the workflow posts — a score is optional on the way in, and this is the row it
    // produces when the workflow does not send one.
    const id = await seedCompare();
    const db = await DBModel.getKyselyDB();
    await db
      .insertInto("comparison_result")
      .values({
        comparison_id: Number(id),
        status: "no_match",
        similarity: null,
        company_name: "Acme Co",
        friend_name_en: "unscored person",
      } as never)
      .execute();

    const { results, scored } = await gradingCoverage();
    expect(results).toBe(4);
    expect(scored).toBe(3);
    // The invariant the panel's sentence rests on — it prints "N of M", and N > M would be
    // nonsense on screen.
    expect(scored).toBeLessThanOrEqual(results);

    // And the unscored row is genuinely immovable: it stays a non-match at the floor, where every
    // scored row on file has been promoted.
    const loose = await overviewAt(0);
    const strict = await overviewAt(1);
    expect(loose.friendsMatched).toBe(3);
    expect(strict.friendsMatched).toBe(2);
  });

  it("says nothing is gradable when no run kept a score", async () => {
    // Zero is the case the control disables itself for, and it has to be reachable: an empty
    // database is one, and so is a workspace fed entirely by a workflow that reports bare verdicts.
    const { results, scored } = await gradingCoverage();
    expect(results).toBe(0);
    expect(scored).toBe(0);
  });
});
