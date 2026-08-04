"use client";

import * as React from "react";
import Link from "next/link";
import { History, Search, Trash2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmButton } from "@/components/confirm-button";
import { SectionHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { CompareModeBadge } from "@/components/compare-mode";
import { SourcesBadge } from "@/components/sources-badge";
import { sourcesLabel } from "@extensions/contract";
import { useComparisons, useUploadSources } from "@/hooks/queries";
import { useDeleteComparison } from "@/hooks/mutations";
import { usePermissions } from "@/components/auth-provider";
import { formatDate, runTitle } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Every comparison run, newest first — including the ones each import kicks off on its own with
 * the external matcher. This is the record of how the network data was built, so it lives on the
 * Overview beneath the current state rather than behind a tab of its own. A run is immutable the
 * moment it finishes, so there is no separate saved copy to keep in step.
 */

/** Past runs only need a filter box once the list is long enough to scan badly. */
const SEARCH_THRESHOLD = 5;

export function RecentRuns() {
  const { data, isLoading } = useComparisons();
  const del = useDeleteComparison();
  const { canWrite } = usePermissions();
  const [query, setQuery] = React.useState("");

  const sourceList = useUploadSources();
  const sourceLabels = React.useMemo(
    () => new Map((sourceList.data ?? []).map((s) => [s.value, s.label])),
    [sourceList.data]
  );

  const runs = data ?? [];
  const needle = query.trim().toLowerCase();
  // The filter searches the SOURCES TOO, because they are now part of how a run is identified —
  // typing "linkedin" to find the LinkedIn runs is the obvious move once the chips are on screen,
  // and a filter that ignored the thing it just showed you would read as broken. Matched on the
  // rendered label as well as the stored value, so "LinkedIn" and "linkedin" both find it.
  const shown = needle
    ? runs.filter((h) =>
        [h.name, ...h.selectedCompanies, ...(h.sources ?? []), sourcesLabel(h.sources, sourceLabels)].some(
          (v) => v?.toLowerCase().includes(needle)
        )
      )
    : runs;

  return (
    <section className="space-y-4">
      <SectionHeader
        title="Recent comparisons"
        description={runs.length ? `${runs.length} run${runs.length === 1 ? "" : "s"}` : undefined}
        actions={
          runs.length > SEARCH_THRESHOLD ? (
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name…"
                className="h-8 pl-8"
                aria-label="Filter comparisons"
              />
            </div>
          ) : undefined
        }
      />

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-[104px] rounded-lg" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={History}
          title="No comparisons yet"
          description={
            canWrite
              ? "Import a friend list and some company data — a run is kept here automatically."
              : "No runs have been recorded yet."
          }
          action={
            canWrite ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/uploads">
                  <UploadCloud className="h-4 w-4" /> Import data
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Search}
          title={`No runs match “${query}”`}
          description="Try a shorter search, or clear the filter."
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery("")}>
              Clear filter
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          {shown.map((h) => (
            <div
              key={h.id}
              className="group relative flex items-center gap-4 border-b p-4 transition-colors last:border-b-0 hover:bg-muted/40 focus-within:bg-muted/40"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-x-4 gap-y-0.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <Link
                    href={`/comparisons/${h.id}`}
                    className="min-w-0 outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
                  >
                    <p className="truncate font-medium">{runTitle(h)}</p>
                  </Link>
                  {/*
                    THE TWO AXES, ON EVERY ROW. This list is the only place runs are seen side by
                    side, and since a run can be repeated with a different mode or a different set
                    of sources, the title alone stopped identifying one: three rows reading "PTT ·
                    2026-08-03" are three different questions with the same name, and without these
                    chips the only way to tell them apart is to open all three.

                    That is also the whole reason re-running is allowed rather than blocked — the
                    feature only works if its results are distinguishable afterwards, so the chips
                    are the other half of that decision, not decoration on it.

                    `relative z-10` keeps them above the row's stretched link so the title's click
                    target does not swallow the tooltip on the sources chip.
                  */}
                  <div className="relative z-10 mt-1 flex flex-wrap items-center gap-1.5">
                    <CompareModeBadge mode={h.compareBy} className="text-2xs" />
                    <SourcesBadge sources={h.sources} labels={sourceLabels} className="text-2xs" />
                  </div>
                </div>

                <p className="shrink-0 text-sm tabular-nums text-muted-foreground sm:text-right">
                  {formatDate(h.date)}
                  {" · "}
                  {h.status === "completed" ? (
                    <>
                      <span className={h.matchCount > 0 ? "font-medium text-foreground" : undefined}>
                        {h.matchCount.toLocaleString()} {h.matchCount === 1 ? "match" : "matches"}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        of {h.scoredCount.toLocaleString()} scored
                      </span>
                    </>
                  ) : (
                    <span
                      className={cn(
                        "font-medium",
                        h.status === "failed" ? "text-destructive" : "text-foreground"
                      )}
                    >
                      {h.status === "failed" ? "Failed" : "Running"}
                    </span>
                  )}
                </p>
              </div>

              {canWrite && (
                <ConfirmButton
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${runTitle(h)}`}
                  title="Delete this comparison?"
                  description="The run and its results are removed. This cannot be undone."
                  confirmLabel="Delete"
                  isLoading={del.isPending}
                  onConfirm={() => del.mutateAsync(h.id)}
                  className="relative z-10 shrink-0 opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </ConfirmButton>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
