"use client";

import * as React from "react";
import Link from "next/link";
import type { ComparisonListItem, ResultsData } from "@extensions/contract";
import { CompareModeBadge } from "@/components/compare-mode";
import { SourcesBadge } from "@/components/sources-badge";
import { useComparisons, useUploadSources } from "@/hooks/queries";
import { useCarriedThreshold, withThreshold } from "@/hooks/useThreshold";
import { formatDate } from "@/lib/format";
import { subjectFilter, subjectKey } from "@/lib/run-groups";
import { cn } from "@/lib/utils";

/**
 * The OTHER times this question was asked — every run over the same subject, as a strip of links.
 *
 * ── WHY THE RUN PAGE NEEDS IT ──
 *
 * Results lists one row per subject and folds a subject's runs underneath it, so the comparison
 * "Facebook found 8, CMA found 15" is one press away there. Following either of those links used to
 * leave that behind: the run page was a dead end that knew about exactly one run, so answering "and
 * what did the other one say" meant going back and re-expanding. This is the same history, carried
 * to the page where somebody is actually reading an answer and wondering how it compares.
 *
 * Each entry leads with its DATE and its two settings, and nothing else — within one subject the
 * scope is constant, so repeating it would be the page's own title, four times over. Those settings
 * are the whole reason two runs of one subject disagree, which makes them the only labels worth the
 * width.
 *
 * ── IT ASKS THE SERVER RATHER THAN HOLDING THE LIST ──
 *
 * `subjectFilter` turns this run's scope into the `GET /comparisons` query that returns its
 * siblings — the endpoint has taken that shape since scoped runs existed, and an import's two axes
 * (`upload` and `file`) go across together because they are one subject. The unscoped case is the
 * one the server cannot answer alone: a run with no scope is identified by its COMPANY LIST, which
 * `filter_value` has no way to match, so the request asks for every unscoped run and `subjectKey`
 * narrows it here — the same key the grouped list folds on, so the two surfaces cannot disagree
 * about what counts as the same question.
 *
 * Renders nothing when there are no siblings, which is most runs. A heading over an empty strip
 * would suggest a history that does not exist.
 */
/**
 * Every run over this run's subject, newest first — INCLUDING this one.
 *
 * A hook rather than a prop drilled down from the page, because two things on that page need the
 * same answer and neither owns the other: the strip below, and the header, which titles an
 * import-scoped run by the FILENAME of the import that opened it — a fact that lives on a sibling
 * run and nowhere in this run's own payload. React Query serves both from one request: the key is
 * derived from the filter, and the filter is derived from the run, so the second caller is a cache
 * hit rather than a second fetch.
 *
 * The client-side narrowing is for the unscoped case alone; see the file header for why the server
 * cannot do it.
 */
export function useSubjectRuns(run: ResultsData): ComparisonListItem[] {
  const { data } = useComparisons(subjectFilter(run));
  const key = subjectKey(run);
  return React.useMemo(() => (data ?? []).filter((r) => subjectKey(r) === key), [data, key]);
}

export function RunSiblings({ run, currentId }: { run: ResultsData; currentId: string }) {
  const siblings = useSubjectRuns(run);
  // Run to run, the workspace bar rides along — these links move sideways between historical events
  // and must not be the step that quietly drops it. It grades nothing here; see the run page.
  const threshold = useCarriedThreshold();

  const sourceList = useUploadSources();
  const sourceLabels = React.useMemo(
    () => new Map((sourceList.data ?? []).map((s) => [s.value, s.label])),
    [sourceList.data]
  );

  if (siblings.filter((r) => r.id !== currentId).length === 0) return null;

  return (
    <section className="rounded-lg border bg-muted/30 p-3">
      <p className="mb-2 px-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {/* Counted over the whole subject, not over `others` — "3 comparisons" beside a strip of two
            says where the reader is standing, where "2" would leave them to work out whether the
            page they are on is one of them. */}
        {siblings.length} comparisons of this subject
      </p>
      <ol className="flex flex-col gap-1">
        {siblings.map((sibling) => {
          const current = sibling.id === currentId;
          const body = (
            <>
              <span className="shrink-0 text-sm tabular-nums">{formatDate(sibling.date)}</span>
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <CompareModeBadge mode={sibling.compareBy} className="text-2xs" />
                <SourcesBadge
                  sources={sibling.sources}
                  labels={sourceLabels}
                  className="text-2xs"
                />
              </span>
              <span className="ml-auto shrink-0 text-sm tabular-nums text-muted-foreground">
                {sibling.status === "completed" ? (
                  <>
                    <span
                      className={sibling.matchCount > 0 ? "font-medium text-foreground" : undefined}
                    >
                      {sibling.matchCount.toLocaleString()}
                    </span>{" "}
                    of {sibling.scoredCount.toLocaleString()}
                  </>
                ) : sibling.status === "failed" ? (
                  <span className="font-medium text-destructive">Failed</span>
                ) : (
                  <span className="font-medium text-foreground">Running</span>
                )}
              </span>
            </>
          );

          return (
            <li key={sibling.id}>
              {/*
                The run being read is listed but NOT a link, and that is the point of listing it: it
                is what tells the reader which of these answers is on screen. A link to the page you
                are on reads as an action and does nothing.
              */}
              {current ? (
                <div
                  aria-current="page"
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-dashed bg-background px-2 py-2"
                >
                  {body}
                </div>
              ) : (
                <Link
                  href={withThreshold(`/comparisons/${sibling.id}`, threshold)}
                  className={cn(
                    "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2",
                    "transition-colors hover:bg-background focus-visible:bg-background focus-visible:outline-none"
                  )}
                >
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
