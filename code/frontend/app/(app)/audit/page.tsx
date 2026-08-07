"use client";

import * as React from "react";
import { Layers } from "lucide-react";
import {
  ALL_SOURCES_LABEL,
  COMPARE_BY_VALUES,
  LANGUAGE_LABEL,
  TYPE_LABEL,
  compareByLabel,
  sourceLabel,
  type AuditSummaryData,
} from "@extensions/contract";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { StatTile, compactCount } from "@/components/stat-tile";
import { ActivityChart } from "@/components/audit/ActivityChart";
import { BreakdownBars, type BreakdownRow } from "@/components/audit/BreakdownBars";
import { AuditTrail } from "@/components/audit/AuditTrail";
import { useAuditSummary, useUploadSources } from "@/hooks/queries";
import { cn } from "@/lib/utils";

/**
 * Audit trail — what this database has been asked to do, and what it answered.
 *
 * ── WHAT IS AND IS NOT ON THIS PAGE ──
 *
 * Every number here is derived from the rows the app already writes — `comparison`,
 * `comparison_result`, `upload`, `friend`. There is no audit table, so this reports what the data
 * SAYS HAPPENED rather than what anybody DID: a deleted run leaves no trace, and a rolled-back
 * import survives only as a row stamped `rolled_back`. That limit is stated on the page rather than
 * left for a reader to discover, because a trail that quietly omits things is worse than no trail.
 * See `extensions/contract/src/audit.ts`.
 *
 * ── ONE WINDOW, AND IT MOVES ONE THING ──
 *
 * The selector above the chart windows the DAILY SERIES and nothing else. Every tile and every
 * breakdown is all-time. Windowing the headline too would be the more obvious design and the wrong
 * one: "43 runs" is a number people quote, and it must not silently mean "43 since the 5th".
 *
 * ── REVIEWERS OPEN THIS PAGE ──
 *
 * It is on `REVIEWER_PAGES` in `lib/auth/access.ts`, and its two endpoints are on the matching
 * allowlist in `api/src/lib/roles.ts`. Both halves are required — the page list decides what is
 * painted, the endpoint list is the actual boundary — so change them together or a reviewer gets a
 * page whose every request 403s. There is nothing role-gated *inside* the page: it is all reads,
 * and a reviewer sees exactly what everyone else does.
 */

/** The windows the chart offers. Capped well short of the schema's 365 on purpose — past ~90 the
 *  columns are thinner than the gaps between them and the chart stops being readable. */
const WINDOWS = [7, 30, 90] as const;
const DEFAULT_WINDOW = 30;

export default function AuditPage() {
  const [days, setDays] = React.useState<number>(DEFAULT_WINDOW);
  const { data, isLoading, isFetching } = useAuditSummary(days);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Audit trail"
        description="Every comparison run and every import on file — how many, how they were configured, and what came back."
      />

      <Headline data={data} isLoading={isLoading} />

      <Card>
        <CardContent className="space-y-4 p-5">
          <SectionHeader
            title="Activity"
            description={`Runs and imports per day, last ${days} days`}
            actions={
              <div className="flex gap-1 rounded-md border p-0.5">
                {WINDOWS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setDays(w)}
                    aria-pressed={days === w}
                    className={cn(
                      "rounded px-2.5 py-1 text-xs font-medium tabular-nums transition-colors duration-fast",
                      "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      days === w
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {w}d
                  </button>
                ))}
              </div>
            }
          />
          <ActivityChart
            days={data?.timeline ?? []}
            windowDays={days}
            // Only the first load gets skeletons. A window change refetches the whole payload to
            // move one chart, and blanking it mid-drag of the selector would read as a reset.
            isLoading={isLoading}
            className={cn(isFetching && !isLoading && "opacity-60 transition-opacity")}
          />
        </CardContent>
      </Card>

      <HowRunsCompared data={data} isLoading={isLoading} />
      <Sources data={data} isLoading={isLoading} />
      <AuditTrail />

      {/*
        The page's own caveat, at the bottom, where it annotates everything above it rather than
        standing between the reader and the numbers. It is here because the honest reading of these
        tallies depends on it: they count rows that exist, and rows can be deleted.
      */}
      <p className="border-t pt-4 text-xs leading-relaxed text-muted-foreground">
        These counts are taken from the runs and imports currently on file, not from a separate
        log — so a deleted run is absent rather than shown as deleted, and a rolled-back import is
        listed with its rows already removed.
      </p>
    </div>
  );
}

/** The four numbers the page leads with. At most one emphasis per row — runs, since that is what
 *  the page is about. */
function Headline({ data, isLoading }: { data?: AuditSummaryData; isLoading: boolean }) {
  const runs = data?.runs;
  const results = data?.results;
  const imports = data?.imports;
  const onFile = data?.data;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Comparison runs"
        value={isLoading ? "" : compactCount(runs?.total ?? 0)}
        hint={
          runs ? (
            <>
              {runs.completed.toLocaleString()} completed
              {runs.running > 0 && ` · ${runs.running.toLocaleString()} running`}
              {runs.failed > 0 && (
                <span className="text-confidence-low"> · {runs.failed.toLocaleString()} failed</span>
              )}
            </>
          ) : undefined
        }
        emphasis
        isLoading={isLoading}
      />
      <StatTile
        label="Matches found"
        value={isLoading ? "" : compactCount(results?.matched ?? 0)}
        hint={
          results
            ? `of ${results.total.toLocaleString()} result ${results.total === 1 ? "row" : "rows"}`
            : undefined
        }
        isLoading={isLoading}
      />
      <StatTile
        label="Imports"
        value={isLoading ? "" : compactCount(imports?.total ?? 0)}
        hint={
          imports ? (
            <>
              {imports.company.toLocaleString()} company · {imports.social.toLocaleString()} friends
              {imports.rolledBack > 0 && ` · ${imports.rolledBack.toLocaleString()} rolled back`}
            </>
          ) : undefined
        }
        isLoading={isLoading}
      />
      <StatTile
        label="On file"
        value={isLoading ? "" : compactCount(onFile?.friends ?? 0)}
        hint={
          onFile
            ? `friends · ${onFile.contacts.toLocaleString()} contacts at ${onFile.companies.toLocaleString()} ${
                onFile.companies === 1 ? "company" : "companies"
              }`
            : undefined
        }
        isLoading={isLoading}
      />
    </div>
  );
}

/**
 * The comparison axes — language, name part, and the full six-cell matrix.
 *
 * Three views of one tally, and they reconcile by construction: the server folds the two axes out
 * of the mode counts with the contract's own `compareByAxes`, so language and type are these same
 * runs cut two ways and each column sums to the run total.
 */
function HowRunsCompared({ data, isLoading }: { data?: AuditSummaryData; isLoading: boolean }) {
  const total = data?.runs.total ?? 0;

  const languageRows: BreakdownRow[] =
    data?.byLanguage.map((r) => ({
      key: r.language,
      label: LANGUAGE_LABEL[r.language],
      value: r.runs,
      hint: share(r.runs, total),
    })) ?? [];

  const typeRows: BreakdownRow[] =
    data?.byType.map((r) => ({
      key: r.type,
      label: TYPE_LABEL[r.type],
      value: r.runs,
      hint: share(r.runs, total),
    })) ?? [];

  const modeRuns = new Map((data?.byMode ?? []).map((m) => [m.mode, m.runs]));

  return (
    <section className="space-y-4">
      <SectionHeader
        title="How runs compared"
        description="Every run picks one language and one part of the name. These are the same runs, cut three ways."
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <Card>
          <CardContent className="space-y-3 p-5">
            <p className="text-xs font-medium text-muted-foreground">Language</p>
            <BreakdownBars
              rows={languageRows}
              isLoading={isLoading}
              emptyLabel="No runs yet."
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-5">
            <p className="text-xs font-medium text-muted-foreground">Name part</p>
            <BreakdownBars rows={typeRows} isLoading={isLoading} emptyLabel="No runs yet." />
          </CardContent>
        </Card>

        {/*
          The matrix as a list rather than a third bar chart. Six rows of mostly-zero bars would be
          a chart whose shape is decided by which two cells anyone has used; the interesting fact
          here is WHICH cells are non-zero, which a compact list states directly.
        */}
        <Card>
          <CardContent className="space-y-3 p-5">
            <p className="text-xs font-medium text-muted-foreground">Mode</p>
            {isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-5 rounded" />
                ))}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {COMPARE_BY_VALUES.map((mode) => {
                  const runs = modeRuns.get(mode) ?? 0;
                  return (
                    <li
                      key={mode}
                      className={cn(
                        "flex items-baseline justify-between gap-3 text-sm",
                        // A mode nobody has run stays on the page — "have we ever compared Thai
                        // surnames?" is answered by the zero — but recedes, so the modes in use
                        // are what the eye lands on.
                        runs === 0 && "text-muted-foreground"
                      )}
                    >
                      <span className="min-w-0 truncate">{compareByLabel(mode)}</span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {runs.toLocaleString()}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

/**
 * Import types, and everything on file that carries one.
 *
 * A table and not a chart: three measures per row cannot share one bar, and they routinely
 * disagree — a source can hold friends and no runs (imported, never compared) or runs and no
 * friends (every import carrying it was rolled back). Putting the three side by side is the point.
 */
function Sources({ data, isLoading }: { data?: AuditSummaryData; isLoading: boolean }) {
  // The pick-list's own spelling, so "linkedin" reads as "LinkedIn" here exactly as it does in the
  // import picker. Falls back to the contract's title-caser for a value the list has not heard of.
  const sourceList = useUploadSources();
  const labels = React.useMemo(
    () => new Map((sourceList.data ?? []).map((s) => [s.value, s.label])),
    [sourceList.data]
  );

  const rows = data?.bySource ?? [];

  return (
    <section className="space-y-4">
      <SectionHeader
        title="Import types"
        description="Where the data came from — and how much of it each source accounts for."
      />

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-8 rounded" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">
              Nothing imported yet — the source list fills in as data arrives.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th scope="col" className="px-5 py-2.5 text-left font-medium">
                      Source
                    </th>
                    <th scope="col" className="px-5 py-2.5 text-right font-medium">
                      Friends
                    </th>
                    <th scope="col" className="px-5 py-2.5 text-right font-medium">
                      Imports
                    </th>
                    <th scope="col" className="px-5 py-2.5 text-right font-medium">
                      Runs
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.source} className="border-b last:border-b-0">
                      <td className="px-5 py-2.5">
                        <span className="flex items-center gap-2">
                          <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          {labels.get(row.source) ?? sourceLabel(row.source)}
                        </span>
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums">
                        {row.friends.toLocaleString()}
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">
                        {row.imports.toLocaleString()}
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">
                        {row.runs.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/*
        The two things this table would otherwise be read wrongly for, said once underneath it.

        The first is the more dangerous: a run naming Facebook AND LinkedIn is counted under both,
        so the Runs column does not add up to the headline — which looks like a bug unless it says
        why. The second is the null-means-everything convention, which is the commonest kind of run
        and appears in no row at all.
      */}
      {!isLoading && rows.length > 0 && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          A run can name several sources and is counted under each, so the Runs column adds up to
          more than the run total.
          {data && data.allSourceRuns > 0 && (
            <>
              {" "}
              A further{" "}
              <span className="font-medium text-foreground">
                {data.allSourceRuns.toLocaleString()}
              </span>{" "}
              {data.allSourceRuns === 1 ? "run named" : "runs named"} no source at all, which means
              “{ALL_SOURCES_LABEL}” — every friend on file, whatever they were imported from.
            </>
          )}
        </p>
      )}
    </section>
  );
}

/** A row's share of the run total, as a hint beside its label. Empty at zero total rather than
 *  "0%", which would state a proportion of nothing as a finding. */
function share(value: number, total: number): string | undefined {
  if (total <= 0) return undefined;
  return `${Math.round((value / total) * 100)}%`;
}
