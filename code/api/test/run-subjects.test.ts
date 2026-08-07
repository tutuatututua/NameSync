import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { importCompany, importFacebook, startCompare, truncateAll } from "./helpers";
import { ComparisonModel } from "../src/models/comparison.model";

/**
 * `GET /api/comparisons/subjects` — the run list folded by SUBJECT, searched and paged.
 *
 * ── WHAT IS ACTUALLY AT RISK HERE ──
 *
 * The grouping rule is written twice: once in SQL (`ComparisonModel.SUBJECT_KEY`) because the
 * server decides where page boundaries fall, and once in TypeScript (`frontend/lib/run-groups.ts`)
 * for the unpaged readers. Two implementations of one rule is the whole hazard, and it is not a
 * hazard the type system can see — a drift shows up as a row that splits in two, or a page that
 * silently contains nineteen subjects instead of twenty.
 *
 * So this suite tests the rules the SQL is responsible for, at the boundaries where a drift would
 * bite: `upload` and `file` folding into one subject, case-folding on the scope value, unscoped
 * runs keying on their sorted company list, and the page boundary falling between subjects rather
 * than through one.
 *
 * The internal matcher, like `scoped-compare.test.ts` — the endpoint reads stored `comparison` rows
 * and does not care which matcher wrote them, so the cheaper path is the honest one to test on.
 */

let app: FastifyInstance;
let mock: MockServer;

const CO_CSV =
  "company_name,thai_name,eng_name\n" +
  "BLUEBRICK,สมชาย ใจดี,Somchai Jaidee\n" +
  "PTT,อนงค์ สุข,Anong Suk\n";

const FRIENDS =
  'name,relationship_owner\n"Somchai Jaidee","Alex"\n"Anong Suk","Mint"\n';

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
});

/** The endpoint, as the frontend calls it. */
async function subjects(query: string = "") {
  const res = await app.inject({
    method: "GET",
    url: `/api/comparisons/subjects${query ? `?${query}` : "?page=1&limit=20"}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    data: { key: string; filterBy: string | null; filterValue: string | null; runs: unknown[] }[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  };
}

/** Seed enough for a run to have something to score. */
async function seed() {
  await importCompany(app, { csv: CO_CSV, uploader: "Importer" });
  await importFacebook(app, { friendsCsv: FRIENDS, uploader: "Importer" });
}

describe("folding — which runs are one subject", () => {
  it("puts every run of one company on a single row, newest first", async () => {
    await seed();
    await startCompare(app, null, "en_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });
    await startCompare(app, null, "th_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });

    const page = await subjects("filter_by=company&page=1&limit=20");
    expect(page.data).toHaveLength(1);
    expect(page.pagination.total).toBe(1);
    const [group] = page.data;
    expect(group.runs).toHaveLength(2);
    expect(group.filterBy).toBe("company");
    expect(group.filterValue).toBe("BLUEBRICK");
  });

  it("folds a company's runs together across CASE, the way every other query matches them", async () => {
    await seed();
    await startCompare(app, null, "en_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });
    // A second run naming the same company as a human typed it. `filter_value` is stored unfolded,
    // so an exact-match key would file these as two subjects and leave each looking incomplete.
    await startCompare(app, null, "th_full", null, {
      filterBy: "company",
      filterValue: "BlueBrick",
    });

    const page = await subjects("filter_by=company&page=1&limit=20");
    expect(page.data).toHaveLength(1);
    expect(page.data[0].runs).toHaveLength(2);
  });

  it("treats an import's own run and a later re-run of it as ONE subject", async () => {
    await importCompany(app, { csv: CO_CSV, uploader: "Importer" });
    const upload = await importFacebook(app, { friendsCsv: FRIENDS, uploader: "Importer" });
    const uploadId = upload.json().data.sessionId as string;

    /**
     * The `upload`-scoped run is WRITTEN DIRECTLY, and it has to be.
     *
     * That row is what an import opens for itself — but only under the EXTERNAL matcher. This suite
     * runs on the internal one (see the header), where an import's status is final before the
     * response returns and no run is opened at all. So the alternative to writing the row here is
     * running this one case under a different matcher to obtain a row this endpoint reads out of
     * the `comparison` table either way.
     *
     * `upload` is also not requestable through `POST /compare` (`REQUESTABLE_FILTER_BY` excludes
     * it, which is the very asymmetry being tested), so there is no API path to it by design.
     */
    await ComparisonModel.create({
      name: "facebook-friends.xlsx",
      scope: { filterBy: "upload", filterValue: uploadId },
      status: "completed",
    });

    // Re-running those rows is filed as `file`, because an import that already happened cannot be
    // requested again as itself. Same rows, same id, different axis.
    await startCompare(app, null, "th_full", null, { filterBy: "file", filterValue: uploadId });

    const page = await subjects("filter_by=upload&filter_by=file&page=1&limit=20");
    // One row, not two — this is the commonest re-run in the product, and without the
    // normalisation it would land directly beneath the run it repeats as a near-duplicate.
    expect(page.data).toHaveLength(1);
    // Normalised to the requestable half of the vocabulary — a client drawing a chip from this
    // must not get a different answer depending on which of the two happens to be newest.
    expect(page.data[0].filterBy).toBe("file");
    expect(page.data[0].filterValue).toBe(uploadId);
    expect(page.data[0].runs).toHaveLength(2);
  });

  it("keys an unscoped run on its company list, regardless of the order it was given in", async () => {
    await seed();
    await startCompare(app, ["BLUEBRICK", "PTT"], "en_full", null);
    await startCompare(app, ["PTT", "BLUEBRICK"], "th_full", null);

    const page = await subjects("unscoped=true&page=1&limit=20");
    // Same two companies, named in two orders — one question asked twice, so one row.
    expect(page.data).toHaveLength(1);
    expect(page.data[0].runs).toHaveLength(2);
    expect(page.data[0].filterBy).toBeNull();
  });

  it("keeps two DIFFERENT company sets apart", async () => {
    await seed();
    await startCompare(app, ["BLUEBRICK"], "en_full", null);
    await startCompare(app, ["PTT"], "en_full", null);

    const page = await subjects("unscoped=true&page=1&limit=20");
    expect(page.data).toHaveLength(2);
  });
});

describe("paging — the boundary falls between subjects, never through one", () => {
  it("keeps a subject whole when its runs straddle the page size", async () => {
    await seed();
    // Three runs on ONE subject, and a page of one subject. Paging by RUN would put two of these
    // on page 1 and one on page 2; paging by subject puts all three on page 1 as a single row.
    for (const mode of ["en_full", "th_full", "en_surname"] as const) {
      await startCompare(app, null, mode, null, {
        filterBy: "company",
        filterValue: "BLUEBRICK",
      });
    }
    await startCompare(app, null, "en_full", null, { filterBy: "company", filterValue: "PTT" });

    const first = await subjects("filter_by=company&page=1&limit=1");
    expect(first.data).toHaveLength(1);
    expect(first.pagination.total).toBe(2);
    expect(first.pagination.totalPages).toBe(2);
    // PTT was asked about last, so it leads — the order is by each subject's NEWEST run.
    expect(first.data[0].filterValue).toBe("PTT");
    expect(first.data[0].runs).toHaveLength(1);

    const second = await subjects("filter_by=company&page=2&limit=1");
    expect(second.data).toHaveLength(1);
    expect(second.data[0].filterValue).toBe("BLUEBRICK");
    // All three, on one row, on one page. This is the assertion the whole endpoint exists for.
    expect(second.data[0].runs).toHaveLength(3);
  });

  it("counts SUBJECTS in `total`, not runs", async () => {
    await seed();
    await startCompare(app, null, "en_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });
    await startCompare(app, null, "th_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });

    const page = await subjects("filter_by=company&page=1&limit=20");
    // Two runs, one subject. A run count here would promise a second page that does not exist.
    expect(page.pagination.total).toBe(1);
    expect(page.pagination.totalPages).toBe(1);
    expect(page.data[0].runs).toHaveLength(2);
  });

  it("returns an empty page rather than every run when the page is past the end", async () => {
    await seed();
    await startCompare(app, null, "en_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });

    const page = await subjects("filter_by=company&page=5&limit=20");
    expect(page.data).toHaveLength(0);
    // The count still describes the whole answer, so the pager can send the reader back.
    expect(page.pagination.total).toBe(1);
  });
});

describe("search — a subject survives if any of its runs matches", () => {
  it("finds a subject by its scope value, case-insensitively", async () => {
    await seed();
    await startCompare(app, null, "en_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });
    await startCompare(app, null, "en_full", null, { filterBy: "company", filterValue: "PTT" });

    const page = await subjects("filter_by=company&q=bluebrick&page=1&limit=20");
    expect(page.data).toHaveLength(1);
    expect(page.data[0].filterValue).toBe("BLUEBRICK");
    expect(page.pagination.total).toBe(1);
  });

  it("finds a subject by its owner, and by the axis word", async () => {
    await seed();
    await startCompare(app, null, "en_full", null, { filterBy: "owner", filterValue: "Mint" });

    expect((await subjects("q=mint&page=1&limit=20")).data).toHaveLength(1);
    // The chip reads "Owner · Mint"; typing the axis has to find it.
    expect((await subjects("q=owner&page=1&limit=20")).data).toHaveLength(1);
  });

  it("returns a matched subject with ALL of its runs, not just the matching ones", async () => {
    await seed();
    await startCompare(app, null, "en_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });
    await startCompare(app, null, "th_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });

    const page = await subjects("filter_by=company&q=bluebrick&page=1&limit=20");
    // Both runs match here anyway (they share the scope value), but the guarantee is the point:
    // a row claiming a history must open onto that whole history, not onto the search's leftovers.
    expect(page.data[0].runs).toHaveLength(2);
  });

  it("treats LIKE metacharacters as ordinary text", async () => {
    await seed();
    await startCompare(app, null, "en_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });

    // `%` is a wildcard to LIKE and nothing at all to a substring test. If this ever returns the
    // BLUEBRICK row, the search has been rewritten with `ilike` and lost its escaping.
    const page = await subjects("filter_by=company&q=%25&page=1&limit=20");
    expect(page.data).toHaveLength(0);
  });

  it("finds nothing without erroring when nothing matches", async () => {
    await seed();
    await startCompare(app, null, "en_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });

    const page = await subjects("q=nothingatall&page=1&limit=20");
    expect(page.data).toHaveLength(0);
    expect(page.pagination.total).toBe(0);
  });
});

describe("the querystring's refusals are the list endpoint's", () => {
  it("400s a filter_value with no axis", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/comparisons/subjects?filter_value=BLUEBRICK&page=1&limit=20",
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s unscoped beside a filter_value", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/comparisons/subjects?filter_by=company&filter_value=X&unscoped=true&page=1&limit=20",
    });
    expect(res.statusCode).toBe(400);
  });
});
