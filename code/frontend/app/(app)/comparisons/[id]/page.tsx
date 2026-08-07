"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { SearchX } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { ResultsData } from "@extensions/contract";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Callout } from "@/components/callout";
import { CompareModeBadge } from "@/components/compare-mode";
import { ScopeBadge } from "@/components/scope-badge";
import { SourcesBadge } from "@/components/sources-badge";
import { CompareScopeButton } from "@/components/network/CompareScopeButton";
import { ResultsView } from "@/components/results/ResultsView";
import { RunProgress } from "@/components/results/RunProgress";
import { RunSiblings, useSubjectRuns } from "@/components/results/RunSiblings";
import { useComparisonProgress, useResults, useUploadSources } from "@/hooks/queries";
import { qk } from "@/hooks/queryKeys";
import { useCarriedThreshold, withThreshold } from "@/hooks/useThreshold";
import { formatDate } from "@/lib/format";
import { rerunRequest, subjectHeading } from "@/lib/run-groups";

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
 *
 * ── There is no threshold here any more (2026-07-31) ──
 *
 * This page carried the match-threshold slider, and it was tuning the wrong thing. A run is a
 * historical event: re-reading run 3 at 0.9 answered a question about run 3 and moved nothing the
 * reader acts on, because what they act on is the POOLED answer on the Network page — who reaches
 * which company, whose friends were placed — assembled from every run on file. The bar now lives
 * there, on the workspace, and grades everything at once (see `NetworkThreshold`).
 *
 * What this page shows is what the matcher decided. That is the honest thing for a page about one
 * run to show, and it is now the only thing it shows: the endpoints still accept `?threshold=`
 * (documented in the contract, exercised by threshold.test.ts), but nothing here sends one, so a
 * run always reads at its own verdicts.
 *
 * ── IT STILL CARRIES THE WORKSPACE'S BAR, WITHOUT READING AT IT (2026-08-07) ──
 *
 * Having no bar of its own was taken to mean having nothing to do with one, and that made this page
 * the hole the tuning fell through. A reader sets 60% on Network, opens a result, and every way out
 * of here was built from nothing: Back went to `/?tab=results` bare, and the relationship owner on a
 * row linked to that roster bare — so the drill-down people actually use ("who is this owner, what
 * else of theirs is unplaced") landed at the default bar, and the workspace they returned to had
 * quietly reset. The control promises "the bar follows you into a company or a roster"; this was the
 * page where it stopped.
 *
 * So `?threshold=` now rides IN on the links that open a run and OUT on the links that leave it. It
 * is a pass-through and nothing else: it is never sent to `useResults` or `useComparisonProgress`,
 * no number on this page moves because of it, and there is deliberately nothing on screen about it —
 * a bar announced over a run's own verdicts would be claiming to have graded them. See
 * `useCarriedThreshold`, which exists to keep that distinction from being made by accident.
 */
export default function ComparisonDetailPage() {
  const params = useParams<{ id: string }>();
  const id = String(params.id);
  const qc = useQueryClient();

  const { data, isLoading } = useResults(id);

  /** The `upload_source` labels the sources chip renders with — without them it title-cases the
   *  stored value, which gets 'Facebook' right and 'LinkedIn' slightly wrong. */
  const sourceList = useUploadSources();
  const sourceLabels = React.useMemo(
    () => new Map((sourceList.data ?? []).map((s) => [s.value, s.label])),
    [sourceList.data]
  );

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
    // The PREFIX rather than the exact key. Nothing on this page reads a run at a bar any more, so
    // in practice there is one reading to invalidate — but the endpoints still take `?threshold=`,
    // and a prefix cannot be wrong about how many readings exist.
    qc.invalidateQueries({ queryKey: qk.resultsAll(id) });
    qc.invalidateQueries({ queryKey: qk.comparisonsAll() });
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
      <RunHeader id={id} run={data} running={running} sourceLabels={sourceLabels} />

      {/*
        THE SUBJECT'S OTHER ANSWERS.

        High on the page rather than under the table, because it is navigation and its whole value
        is being seen while the reader still has this run's finding in mind — "15 of 26 here, what
        did the Facebook one say". Renders nothing when this run is the only one of its subject,
        which is most runs. See `RunSiblings`.
      */}
      <RunSiblings run={data} currentId={id} />

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
          <Callout
            tone="info"
            title="This run is still going. Results appear as rows are matched."
          />
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

/**
 * Who this run is about, what it was, and the one verb it offers.
 *
 * Its own component because the TITLE needs the subject's other runs (`useSubjectRuns`) and the
 * page above cannot ask for them: it early-returns on a missing run, so a hook after that point
 * would be a conditional one. The query is shared with `RunSiblings` through React Query's cache,
 * not fetched twice — see `useSubjectRuns`.
 */
function RunHeader({
  id,
  run,
  running,
  sourceLabels,
}: {
  id: string;
  run: ResultsData;
  running: boolean;
  sourceLabels: ReadonlyMap<string, string>;
}) {
  const siblings = useSubjectRuns(run);
  // The bar the reader arrived carrying, put back on the way out. Read here rather than passed
  // down: this component owns the only link that leaves for the workspace. See the file header.
  const threshold = useCarriedThreshold();

  return (
    // The header and the run's identity chips are ONE block — the chips qualify the title, and the
    // page's `space-y-8` would otherwise float them halfway down to the results.
    <div className="space-y-3">
      <PageHeader
        /*
            BACK TO THE LIST THIS PAGE IS THE INSIDE OF.

            It went to "/" — the Network page's default tab, which is Company. A reader who opened a
            run from Results and pressed Back arrived somewhere they had not been, with their filter
            and their expanded history gone. Results is where every run is listed, whichever page
            the reader started from, so it is the honest destination even for someone who arrived
            from a company page (whose own list is a narrowed view of this one).

            WITH THE BAR ON IT. Results hides the threshold control but deliberately keeps its value
            in the URL, so a reader who tuned the workspace, opened a run and pressed Back has to
            land on the workspace they left — not on a rail that reverted to the default while they
            were reading one run. See the file header.
          */
        backHref={withThreshold("/?tab=results", threshold)}
        backLabel="Results"
        /*
            THE SUBJECT, named the way Results names it.

            This read `formatCompanies(selectedCompanies)`, which is the right title for exactly one
            kind of run — the unscoped one, where the company list IS the question. Every scoped run
            reaches this page with `selected_companies` empty (its scope decides the rows, not a
            picker) and was therefore titled "Run 41": an owner's run, an import's run and a
            company's run, all landing on a page headed by a database id. `subjectHeading` gives
            each of them the name the row that linked here used, so following a link no longer loses
            the thing you clicked.
          */
        title={subjectHeading({ ...run, id }, siblings)}
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
        /*
            ASK IT AGAIN, DIFFERENTLY — the same action every row on Results carries, from the same
            rule (`rerunRequest`), on the page where somebody is actually reading an answer and
            deciding it was the wrong question. Until 2026-08-06 this page was where re-running
            stopped being possible: you had to go back to a list to repeat the run in front of you.

            This corner previously held a BADGE with the match count, removed because the Verdict
            states the same finding two inches below. That reasoning is untouched — what fills the
            corner now is a verb, which is what `actions` is for on every other page.
          */
        actions={<CompareAgainButton run={run} />}
      />

      {/*
          WHAT THIS RUN WAS — the three facts that tell it from the run beside it in the history.

          The same three chips Results puts on every row, in the same order and from the same
          components, so a reader who followed a row here sees the labels they clicked rather than
          having to re-derive them. The date leads because within one subject it is the only thing
          that orders the answers.
        */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm tabular-nums text-muted-foreground">{formatDate(run.date)}</span>
        <ScopeBadge filterBy={run.filterBy} filterValue={run.filterValue} />
        <CompareModeBadge mode={run.compareBy} />
        <SourcesBadge sources={run.sources} labels={sourceLabels} />
      </div>
    </div>
  );
}

/**
 * "Compare again" — `rerunRequest` wired to the shared button, exactly as each Results row wires it.
 *
 * Its own component so the mapping is read where it is used rather than inlined into a header that
 * is already carrying a title, a back link and four comments. It renders nothing for a reviewer;
 * the check is inside `CompareScopeButton`, which is the only place it should ever be written.
 */
function CompareAgainButton({ run }: { run: ResultsData }) {
  const { scope, scopeSelects, initial, covers } = rerunRequest(run);
  return (
    <CompareScopeButton
      label="Compare again"
      scope={scope}
      scopeSelects={scopeSelects}
      initial={initial}
      covers={covers}
    />
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
