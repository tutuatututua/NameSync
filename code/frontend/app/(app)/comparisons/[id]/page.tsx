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
import { useComparisonProgress, useResults } from "@/hooks/queries";
import { qk } from "@/hooks/queryKeys";
import { formatCompanies } from "@/lib/format";

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

  /**
   * The run's status, from the one query that actually re-asks.
   *
   * `useResults` is fetched once and has no interval, so `data.status` is frozen at whatever was
   * true when the page mounted — reading liveness from it meant a run that started as 'processing'
   * stayed 'processing' on this page forever, no matter what it went on to do. That was survivable
   * only for runs that complete, because the effect below refetches the results on completion and
   * unfreezes it. A run that FAILED had nothing to unfreeze it: the progress poll stopped itself,
   * `data.status` never moved off 'processing', and the page sat there claiming "Matching in
   * progress…" — with the failure callout below never rendering, the Verdict permanently
   * suppressed, and the row table polling a dead run every two seconds until the tab closed.
   *
   * `progress.data.status` is the same field from the endpoint that polls, so it is simply the
   * current answer. Falling back to `data.status` covers the first frame, before the poll lands.
   */
  const status = progress.data?.status ?? data?.status ?? "processing";
  const running = status === "processing" || status === "pending";

  // The poll is what *completes* the run (server-side), so the moment it reaches a terminal state
  // the results endpoint has something new to say — and it is the only signal we get, since the
  // workflow never talks to us. Without this the page would sit on a finished run still showing a
  // progress bar until someone reloaded it.
  //
  // Fires on 'failed' as well as 'completed'. Both are the end of the run, both leave this page
  // holding a stale `results`, and a failed run is exactly the one whose reader most needs the
  // page to stop pretending.
  const finished = progress.data?.status === "completed" || progress.data?.status === "failed";
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
            <Link href="/">Back to Network</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        backHref="/"
        backLabel="Network"
        /* Named "and", not "or": this identifies the run — the set of companies it was pointed at —
           rather than making a claim about any one match. The Verdict below says "or", because
           there it IS a claim about each matched friend, who works at one of them. */
        title={formatCompanies(data.selectedCompanies, { conjunction: "and" }) ?? `Run ${id}`}
        /*
          The finding is NOT repeated here.

          This used to read "1 match · 2 names scored", directly above a card reading "1 friend
          matches a contact on file, out of 2 scored" — the same two numbers, twice, four lines
          apart. The comment defending it said a header that repeats the answer beats one that
          withholds it, which was true when the Verdict might have been below the fold. It is the
          next thing on the page.

          So the header identifies the run and the Verdict states the finding, once. The exception
          is a run still going: the Verdict is deliberately not rendered then (it would read its
          facts from an empty array and announce a confident zero), so this is the only line that
          can say anything, and "Matching in progress…" is what there is to say.
        */
        description={running ? "Matching in progress…" : undefined}
        /* The same badge, from the same fields, as the row you clicked to get here — so a run
           cannot say one thing in the list and another on its own page. */
        actions={<RunOutcome status={status} matchCount={data.matchCount} />}
      />

      {status === "failed" && (
        <Callout tone="danger" title="This run failed — it never produced any results." />
      )}

      {/* A run in flight gets the progress panel above its rows. `progress.data` may not have
          arrived on the first frame, so fall back to a neutral note rather than flashing
          anything at someone whose run started two seconds ago. */}
      {running &&
        (progress.data ? (
          <RunProgress progress={progress.data} />
        ) : (
          <Callout tone="info" title="This run is still going. Results appear as rows are matched." />
        ))}

      {/*
        One block, in every state and for every kind of run — which is the point.

        This used to be a branch: a results table for a finished run, an empty state for a finished
        run that stored no matches, and a *second* table underneath for the run's own rows. The
        second one was the honest view (it had the names that didn't match, which `comparison_result`
        cannot answer for an import) and the first was a subset of it. Both rendered, both described
        the same run, and they disagreed at the edges.

        The empty state has gone with it: "this run stored no matches" was tested on `results`, so a
        run that scored 320 friends and matched nobody replaced its own table — the one place those
        320 rows are listed — with a sentence saying there was nothing to see.
      */}
      <ResultsView
        comparisonId={id}
        results={data.results}
        scoredCount={data.scoredCount}
        selectedCompanies={data.selectedCompanies}
        progress={progress.data}
        live={running}
      />
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
