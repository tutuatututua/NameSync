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
import { useComparisons } from "@/hooks/queries";
import { useDeleteComparison } from "@/hooks/mutations";
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
  const [query, setQuery] = React.useState("");

  const runs = data ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? runs.filter((h) =>
        [h.name, ...h.selectedCompanies].some((v) => v?.toLowerCase().includes(needle))
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
          description="Import a friend list and some company data — a run is kept here automatically."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/uploads">
                <UploadCloud className="h-4 w-4" /> Import data
              </Link>
            </Button>
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
                <Link
                  href={`/comparisons/${h.id}`}
                  className="min-w-0 outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
                >
                  <p className="truncate font-medium">{runTitle(h)}</p>
                </Link>

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
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
