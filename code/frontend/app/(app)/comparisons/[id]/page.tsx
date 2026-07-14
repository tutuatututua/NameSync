"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { SearchX } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Callout } from "@/components/callout";
import { ResultsView } from "@/components/results/ResultsView";
import { RunOutcome } from "@/components/results/RunOutcome";
import { RunProgress } from "@/components/results/RunProgress";
import { RunRows } from "@/components/results/RunRows";
import { useComparisonProgress, useResults } from "@/hooks/queries";
import { qk } from "@/hooks/queryKeys";

/**
 * One run — whether it finished a month ago or is finishing as you watch.
 *
 * Reads the run's actual results (GET /api/comparisons/:id/results) — the same call the
 * Compare screen makes, rendered by the same component. It used to read a saved JSON copy
 * through a different endpoint and render a cut-down table of it, which is how the two views
 * came to disagree: the copy was written in one shape and read in another, and a saved run
 * quietly displayed a table of dashes.
 *
 * This is also where you land after an import, when the external workflow is the matcher: the
 * import opened a run, and the run is the thing you want to watch. It is deliberately not a
 * separate "your upload is processing" screen — that would be a second page showing the same
 * run, which would eventually disagree with this one. Same run, same page, whatever state it
 * is in.
 */
export default function ComparisonDetailPage() {
  const params = useParams<{ id: string }>();
  const id = String(params.id);
  const { data, isLoading } = useResults(id);
  const qc = useQueryClient();

  const running = data?.status === "processing";

  /**
   * Asked for unconditionally, not only while the run is going.
   *
   * The hook stops itself the moment the run reaches a terminal state, so a finished run costs
   * exactly one request — and that request is worth making: its counts are what label the row
   * table's filter tabs ("Matches 4", "No match 9"), and those numbers cannot come from the table
   * itself, which only ever holds one page of rows.
   *
   * It is also the call that *completes* a run, server-side. Fetching it on any visit to this page
   * — not just a visit that happens to catch it mid-flight — is what stops a run whose watcher
   * closed the tab from sitting at 'processing' forever.
   */
  const progress = useComparisonProgress(id);

  // The poll is what *completes* the run (server-side), so the moment it reports 'completed'
  // the results endpoint has something new to say — and it is the only signal we get, since
  // the workflow never talks to us. Without this the page would sit on a finished run still
  // showing a progress bar until someone reloaded it.
  const finished = progress.data?.status === "completed";
  React.useEffect(() => {
    if (!finished) return;
    qc.invalidateQueries({ queryKey: qk.results(id) });
    qc.invalidateQueries({ queryKey: qk.comparisons() });
    // The rows too, and this one is easy to forget because it looks like it polls itself.
    //
    // It does — but only while the run is live, and "the run is no longer live" is precisely the
    // news that stops it. The last poll landed up to two seconds BEFORE the final rows were
    // stamped, so without this the table freezes one tick short of the truth: a handful of names
    // left reading "Waiting" under a header that says the run is finished, and no further poll
    // coming to correct them. Unlike the Compare screen, this component never unmounts on
    // completion, so there is no remount to quietly refetch on its behalf.
    qc.invalidateQueries({ queryKey: qk.runRowsAll(id) });
  }, [finished, id, qc]);

  if (isLoading) return <DetailSkeleton />;

  if (!data) {
    return (
      <EmptyState
        icon={SearchX}
        title="Comparison not found"
        description="It may have been deleted, or the link may be wrong."
        action={
          <Button asChild variant="outline">
            <Link href="/">Back to Compare</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        backHref="/"
        backLabel="Compare"
        title={data.selectedCompany ?? `Run ${id}`}
        /* "320 rows" was the same subtitle on every run against the same friend list. The
           run's own finding goes here instead; Verdict says it again in full, but a header
           that repeats the answer is better than one that withholds it. */
        description={
          data.status === "completed"
            ? `${data.matchCount.toLocaleString()} ${
                data.matchCount === 1 ? "match" : "matches"
              } · ${data.scoredCount.toLocaleString()} names scored`
            : running
              ? // `rowCount` counts stored results, which is 0 until the workflow writes the
                // first one — "0 friends scored" would be a false statement about a run that
                // is scoring them right now. The progress panel below carries the real numbers.
                "Matching in progress…"
              : `${data.rowCount.toLocaleString()} friends scored`
        }
        /* The same badge, from the same fields, as the row you clicked to get here — so a run
           cannot say one thing in the list and another on its own page. */
        actions={
          <RunOutcome
            status={data.status ?? "processing"}
            matchCount={data.matchCount}
            topConfidence={data.topConfidence}
          />
        }
      />

      {data.status === "failed" && (
        <Callout tone="danger" title="This run failed — it never produced any results." />
      )}

      {/* A run in flight gets the progress panel, not an empty results table. `progress.data`
          may not have arrived on the first frame, so fall back to a neutral note rather than
          flashing "no results" at someone whose run started two seconds ago. */}
      {running ? (
        progress.data ? (
          <RunProgress progress={progress.data} />
        ) : (
          <Callout tone="info" title="This run is still going. Results appear as rows are matched." />
        )
      ) : data.results.length > 0 ? (
        <ResultsView
          results={data.results}
          scoredCount={data.scoredCount}
          selectedCompany={data.selectedCompany}
        />
      ) : (
        <EmptyState icon={SearchX} title="No results" description="This run stored no matches." />
      )}

      {/*
        The import's own rows, in both states — and the reason it is not inside the branch above.

        While the run goes, this is the monitor: names resolving from Waiting to Match one by one.
        When it ends, it is the only view that shows the names that *didn't* match beside the ones
        that did — `comparison_result` can't answer that, because a workflow is only obliged to
        write a result row for a name it matched, so the results table above is a list of winners
        with no record of who else ran. A run that matched 4 of 320 has 316 rows that exist nowhere
        else on this page.

        Renders nothing at all for a run with no import behind it (the internal matcher stamps no
        row statuses), so the older compare-by-company runs are unaffected.
      */}
      <RunRows comparisonId={id} progress={progress.data} live={running} />
    </div>
  );
}

/** Matches the loaded page's shape so the layout doesn't jump when data lands. */
function DetailSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-5 w-40" />
      </div>
      <Skeleton className="h-[116px] rounded-lg" />
      <Skeleton className="h-56 rounded-lg" />
      <Skeleton className="h-72 rounded-lg" />
    </div>
  );
}
