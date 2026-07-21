"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  Building2,
  GitCompareArrows,
  History,
  Loader2,
  RotateCcw,
  Search,
  Trash2,
  UploadCloud,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { CompanyPicker } from "@/components/company-picker";
import { LoadingButton } from "@/components/loading-button";
import { ConfirmButton } from "@/components/confirm-button";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ResultsView } from "@/components/results/ResultsView";
// Rendered bare, without a Verdict over it, for the live monitor below: a run in flight has no
// finding yet. Once it lands, `ResultsView` renders the same table with the answer above it.
import { RunRows } from "@/components/results/RunRows";
import { RunProgress } from "@/components/results/RunProgress";
import { useComparisonSocket } from "@/hooks/useComparisonSocket";
import { useCompareByCompany, useDeleteComparison } from "@/hooks/mutations";
import {
  useCompanies,
  useCompanyCount,
  useComparisonProgress,
  useComparisons,
  useFacebookCount,
  useResults,
} from "@/hooks/queries";
import { qk } from "@/hooks/queryKeys";
import { formatCompanies, formatDate, runTitle } from "@/lib/format";
import { fade, fadeUp } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Compare — the app's one job, and the record of every time you've done it.
 *
 * Running a comparison and looking at past comparisons are the same workflow at two points
 * in time, so they're one page: the action on top, the archive underneath. The archive hides
 * while a run is in flight or its results are on screen — at that moment you're reading a
 * result, not browsing for one.
 *
 * A run reaches this page two ways, and they end in the same place:
 *   · you pick a company and press Compare;
 *   · you import a file, which (with the external matcher) starts a run of its own and sends
 *     you here with `?run=<id>`.
 * Both land in `running` and then in `done`. The import flow deliberately does NOT get its own
 * "your upload is processing" screen — that would be a second page describing the same run, and
 * two screens showing one thing eventually disagree about it.
 */

type Mode = "choose" | "running" | "done";

/** Past runs only need a filter box once the list is long enough to scan badly. */
const SEARCH_THRESHOLD = 5;

export default function ComparePage() {
  // `useSearchParams` opts the subtree out of prerendering; without a boundary Next refuses to
  // build the route. The fallback is the page's own resting state, so nothing jumps.
  return (
    <React.Suspense fallback={<CompareSkeleton />}>
      <CompareScreen />
    </React.Suspense>
  );
}

function CompareScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();

  // The run an import just started and sent us here to watch.
  const importedRun = searchParams.get("run");

  // A list, because one run can span several companies — every friend is scored against the union
  // of their contacts and keeps its single closest match. See MatcherService.run.
  const [selected, setSelected] = React.useState<string[]>([]);
  const [sessionId, setSessionId] = React.useState<string | null>(importedRun);
  const [mode, setMode] = React.useState<Mode>(importedRun ? "running" : "choose");
  const [socketProgress, setSocketProgress] = React.useState(0);

  const companies = useCompanies();
  const compareMut = useCompareByCompany();
  const results = useResults(mode === "done" && sessionId ? sessionId : "");

  /**
   * Two clocks, because there are two matchers.
   *
   * The external workflow never speaks to us — it writes verdicts into Postgres and moves on —
   * so the only way to follow it is to keep counting the rows it has not stamped. That is this
   * poll, and it is also what *completes* the run server-side.
   *
   * The older callback-style matcher does push batches over the socket, so that stays. A run
   * driven by it has no import behind it, and the poll reports `total: 0` — which is the tell
   * we use below to decide which of the two to draw.
   */
  // Kept alive past the run, not only during it: the hook stops polling the moment the run is
  // terminal, so a finished run costs one request — and its counts are what label the row table's
  // filter tabs once the results are up.
  const progress = useComparisonProgress(sessionId);

  useComparisonSocket(mode === "running" ? sessionId : null, {
    onMessage: (m) => {
      if (m.type === "batch_received" && typeof m.progress === "number") setSocketProgress(m.progress);
    },
    onComplete: () => {
      setSocketProgress(100);
      setMode("done");
      qc.invalidateQueries({ queryKey: qk.results(sessionId ?? "") });
      qc.invalidateQueries({ queryKey: qk.runRowsAll(sessionId ?? "") });
    },
    onFailed: (m) => {
      toast.error(("message" in m && m.message) || "Comparison failed");
      setMode("choose");
    },
  });

  // The poll is the only completion signal the workflow gives us, so it has to be the thing
  // that ends the wait — and the run has to be re-read, because it only has results now.
  const polled = progress.data?.status;
  React.useEffect(() => {
    if (mode !== "running" || !sessionId) return;

    if (polled === "completed") {
      setMode("done");
      qc.invalidateQueries({ queryKey: qk.results(sessionId) });
      qc.invalidateQueries({ queryKey: qk.comparisons() });
      // The row table's last poll landed up to two seconds before the final rows were stamped,
      // and completing the run is what stops it polling — so the rows it is holding are one tick
      // short of the truth. Switching to the "done" panel happens to remount it, which happens to
      // refetch; that is a coincidence of the layout, not a guarantee, and the same table on the
      // run's own page has no such luck. Ask for the rows again, explicitly.
      qc.invalidateQueries({ queryKey: qk.runRowsAll(sessionId) });
    } else if (polled === "failed") {
      toast.error("The matching workflow never received this import.");
      setMode("choose");
    }
  }, [polled, mode, sessionId, qc]);

  async function compare() {
    if (selected.length === 0) return;
    try {
      const data = await compareMut.mutateAsync(selected);
      setSessionId(data.sessionId);

      // The internal matcher runs inside the request, so by the time this resolves the results
      // are already stored. Dropping into "running" to wait would mean waiting for something
      // that has already happened.
      if (data.status === "completed") {
        setSocketProgress(100);
        setMode("done");
        qc.invalidateQueries({ queryKey: qk.results(data.sessionId) });
        return;
      }

      setSocketProgress(0);
      setMode("running");
    } catch {
      /* mutations surface errors as toasts */
    }
  }

  function reset() {
    setMode("choose");
    setSessionId(null);
    setSocketProgress(0);
    // Drop `?run=` — otherwise "Run another" leaves the finished run in the URL, and a reload
    // drags you straight back into the result you just dismissed.
    if (importedRun) router.replace("/");
  }

  /**
   * Follow the URL back out of a run.
   *
   * Navigating from `/?run=7` to `/` — the sidebar's Compare link, the browser's back button —
   * does not remount this component: it is the same route, so React keeps the state and only
   * `useSearchParams` changes. Without this, `mode` stayed "running" and the page went on
   * showing the monitor for a run the URL no longer mentions, which made the Compare nav link
   * look broken. It was: you could click it all day and nothing moved.
   *
   * Guarded on the run we were actually watching, so a compare-by-company run — which never puts
   * anything in the URL — is not torn down by an effect that sees `?run=` absent and assumes it
   * has just been dismissed.
   */
  const watchedRef = React.useRef(importedRun);
  React.useEffect(() => {
    const previous = watchedRef.current;
    watchedRef.current = importedRun;
    if (previous && !importedRun && sessionId === previous) {
      setMode("choose");
      setSessionId(null);
      setSocketProgress(0);
    }
  }, [importedRun, sessionId]);

  const hasCompanies = (companies.data?.length ?? 0) > 0;

  // An import-driven run counts real rows; a callback-driven one has none to count.
  const rowProgress = progress.data && progress.data.total > 0 ? progress.data : null;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Compare"
        description="Pick a company to find out whether any uploader has a potential connection with people who belong to it."
      />

      {mode === "choose" && <DataSummary />}

      <AnimatePresence mode="wait" initial={false}>
        {mode === "choose" && (
          <motion.div key="choose" variants={fadeUp} initial="hidden" animate="show" exit="exit">
            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="space-y-1.5">
                  <Label htmlFor="company">
                    {/* Plural, because the field is. It reads as a mistake on a one-company run for
                        about as long as it takes to notice you can pick a second. */}
                    Companies
                  </Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="min-w-0 sm:flex-1">
                      <CompanyPicker
                        id="company"
                        companies={companies.data ?? []}
                        selected={selected}
                        onChange={setSelected}
                        disabled={!hasCompanies}
                        placeholder={hasCompanies ? "Select companies…" : "No companies yet"}
                      />
                    </div>
                    <LoadingButton
                      variant="gradient"
                      className="sm:w-36"
                      isLoading={compareMut.isPending}
                      disabled={selected.length === 0}
                      onClick={compare}
                    >
                      <GitCompareArrows className="h-4 w-4" /> Compare
                    </LoadingButton>
                  </div>
                  {/* Says what several companies actually does, at the one moment it is in doubt:
                      the first time you tick a second one. A run is one finding per friend — their
                      closest match anywhere in the set — not a match per company, and the difference
                      is the whole reason the results table has a Company column. */}
                  {selected.length > 1 && (
                    <p className="text-sm text-muted-foreground">
                      One run. Each friend is matched to their closest contact across all{" "}
                      {selected.length} companies.
                    </p>
                  )}
                </div>

                {!hasCompanies && !companies.isLoading && (
                  <p className="text-sm text-muted-foreground">
                    There&apos;s nothing to compare against yet.{" "}
                    <Link
                      href="/uploads"
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Import company data
                    </Link>{" "}
                    to build this list.
                  </p>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* A run started by an import has real rows to count, so it gets the real panel —
            "6 of 12 rows, 3 matched so far" — rather than a bar with a number painted on it,
            and under it the rows themselves, resolving one by one. */}
        {mode === "running" && rowProgress && (
          <motion.div
            key="running-rows"
            variants={fade}
            initial="hidden"
            animate="show"
            exit="exit"
            className="space-y-6"
          >
            <RunProgress progress={rowProgress} />

            {/*
              A way out.

              Watching a run takes over this page, and a large import can hold it for a long
              while — a thousand names is a thousand names. Without this the only exits were the
              browser's back button and a nav link that (until now) did nothing, so the honest
              description of the screen was "stuck". The run does not need a witness: the workflow
              writes to Postgres whether or not anyone is looking, the run is already saved, and
              it is already in Past runs — so leaving costs nothing, and the panel above says so.
            */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                You don&apos;t have to wait here — pick it back up from Past runs whenever.
              </p>
              <Button variant="outline" onClick={reset}>
                <GitCompareArrows className="h-4 w-4" /> Back to Compare
              </Button>
            </div>

            {sessionId && <RunRows comparisonId={sessionId} progress={rowProgress} live />}
          </motion.div>
        )}

        {mode === "running" && !rowProgress && (
          <motion.div key="running" variants={fade} initial="hidden" animate="show" exit="exit">
            <Card>
              <CardContent className="flex flex-col items-center gap-4 p-10">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <div className="space-y-1 text-center">
                  <p className="font-medium">
                    {formatCompanies(selected, { conjunction: "and" })
                      ? `Matching against ${formatCompanies(selected, { conjunction: "and" })}…`
                      : "Matching…"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    This runs in the background — you&apos;ll see results here when it finishes.
                  </p>
                </div>
                <div className="w-full max-w-sm space-y-1.5">
                  <Progress value={socketProgress} />
                  <p className="text-right text-xs tabular-nums text-muted-foreground">
                    {socketProgress}%
                  </p>
                </div>

                {/* The same way out, and here it matters more: this is the panel you get before
                    the first poll lands, and the one a run with nothing to count never leaves.
                    A spinner with no exit is a trap, however briefly it is usually on screen. */}
                <Button variant="outline" size="sm" onClick={reset}>
                  <GitCompareArrows className="h-4 w-4" /> Back to Compare
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {mode === "done" && (
          <motion.div
            key="done"
            variants={fadeUp}
            initial="hidden"
            animate="show"
            className="space-y-6"
          >
            {results.isLoading ? (
              <ResultsSkeleton />
            ) : results.data ? (
              <>
                {/* The same component the run's own page renders, with the same props — a finished
                    run reads identically whether you are looking at it here or came back to it a
                    week later. The rows that did NOT match are inside it now: they used to need a
                    second table bolted on underneath, because the results table could only ever
                    list winners. */}
                {sessionId && (
                  <ResultsView
                    comparisonId={sessionId}
                    results={results.data.results}
                    scoredCount={results.data.scoredCount}
                    selectedCompanies={results.data.selectedCompanies}
                    progress={progress.data}
                    live={false}
                  />
                )}

                {/* No "Save to history" button. The run was written to the database before
                    this screen rendered and is already in Past runs, so a save button would
                    be asking you to keep a second copy of something you already have. */}
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    Kept automatically — it&apos;s in Past runs.
                  </p>
                  <Button variant="outline" onClick={reset}>
                    <RotateCcw className="h-4 w-4" /> Run another
                  </Button>
                </div>
              </>
            ) : (
              <EmptyState
                icon={Search}
                title="No results"
                description="The comparison finished but returned nothing to show."
                action={
                  <Button variant="outline" onClick={reset}>
                    <RotateCcw className="h-4 w-4" /> Run another
                  </Button>
                }
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {mode === "choose" && <PastRuns />}
    </div>
  );
}

/**
 * How much there is to compare against. Doubles as the way into Uploads — the answer to
 * "that number is too low" is to add more, not to go read the rows one by one.
 */
function DataSummary() {
  const company = useCompanyCount();
  const facebook = useFacebookCount();

  const tiles = [
    { icon: Building2, label: "Company records", q: company },
    { icon: Users, label: "Facebook records", q: facebook },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {tiles.map(({ icon: Icon, label, q }) => (
        <Link key={label} href="/uploads" className="group rounded-lg outline-none">
          <Card interactive className="h-full">
            <CardContent className="flex items-center gap-3.5 p-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                {q.isLoading ? (
                  <Skeleton className="h-7 w-16" />
                ) : (
                  <p className="font-display text-2xl font-semibold leading-none tracking-tight">
                    {(q.data ?? 0).toLocaleString()}
                  </p>
                )}
                <p className="mt-1 text-sm text-muted-foreground">{label}</p>
              </div>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors group-hover:text-foreground">
                <UploadCloud className="h-4 w-4" />
                <span className="hidden sm:inline">Upload</span>
              </span>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

/** The page's resting shape, for the Suspense boundary — header, tiles, the picker. */
function CompareSkeleton() {
  return (
    <div className="space-y-10">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-[74px] rounded-lg" />
        <Skeleton className="h-[74px] rounded-lg" />
      </div>
      <Skeleton className="h-[118px] rounded-lg" />
    </div>
  );
}

/** Shape-matched to ResultsView, so finishing a run doesn't shove the page around. */
function ResultsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-[116px] rounded-lg" />
      <Skeleton className="h-56 rounded-lg" />
      <Skeleton className="h-72 rounded-lg" />
    </div>
  );
}

/**
 * Every comparison, not just the ones you remembered to save.
 *
 * This lists the runs themselves. There used to be a second table of saved snapshots, and
 * a run only appeared here if you pressed "Save to history" — which meant every other run
 * still sat in the database, invisible and un-deletable, accumulating forever. A run is
 * already immutable the moment it finishes (its results store names and scores as text, not
 * references), so the copy protected against nothing and only gave the same data a second
 * shape to drift out of.
 */
function PastRuns() {
  const { data, isLoading } = useComparisons();
  const del = useDeleteComparison();
  const [query, setQuery] = React.useState("");

  const runs = data ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? runs.filter((h) =>
        // Every company, not just the first: on a multi-company run the title elides past the third,
        // so filtering on what's rendered would refuse to find a run by a company it genuinely
        // covers — and the run would sit there, matching, invisible.
        [h.name, ...h.selectedCompanies].some((v) => v?.toLowerCase().includes(needle))
      )
    : runs;

  return (
    <section className="space-y-4">
      <SectionHeader
        title="Past runs"
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
                aria-label="Filter past runs"
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
          title="No runs yet"
          description="Every comparison you run is kept here automatically."
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
        /* A history reads top-down, newest first — one run per line, not a grid you have
           to scan in two directions. The API already returns them created_at DESC. */
        <div className="overflow-hidden rounded-lg border">
          {shown.map((h) => (
            <div
              key={h.id}
              className="group relative flex items-center gap-4 border-b p-4 transition-colors last:border-b-0 hover:bg-muted/40 focus-within:bg-muted/40"
            >
              {/*
                Name on the left, what happened on the right.

                There used to be a third thing: a confidence badge ("100% High") pinned to the right
                edge, with the date and counts stacked under the title. It is gone, and the counts
                have taken its place — which is a straight trade of a number for the sentence that
                number was trying to summarise. The badge averaged the run's ten best scores, so on a
                list where every completed run found *something* it printed "100% High" against
                nearly all of them: a column of identical green pills, sorted by nothing, telling you
                apart runs that had already told you apart one line to the left ("34 matches" vs "3
                matches"). Two summaries of one run, and the louder one carried less.

                Stacks under the title on a narrow screen, where there is no room for two columns and
                a right-aligned block would just be a cramped second line anyway.
              */}
              <div className="flex min-w-0 flex-1 flex-col gap-x-4 gap-y-0.5 sm:flex-row sm:items-center sm:justify-between">
                {/* The whole row is the click target, not just the title: `absolute inset-0`
                    stretches this link over the line. Anything that must stay clickable on
                    top of it (the delete button) needs its own stacking context. */}
                <Link
                  href={`/comparisons/${h.id}`}
                  className="min-w-0 outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
                >
                  <p className="truncate font-medium">{runTitle(h)}</p>
                </Link>

                <p className="shrink-0 text-sm tabular-nums text-muted-foreground sm:text-right">
                  {formatDate(h.date)}
                  {" · "}
                  {/* Matches, not rows. `rowCount` is the size of the friend list, so it is the
                      same number on every run made against the same friends — this list used to
                      print "320 rows" three times and leave you to click each one to find out
                      which had found anything. */}
                  {h.status === "completed" ? (
                    <>
                      <span className={h.matchCount > 0 ? "font-medium text-foreground" : undefined}>
                        {h.matchCount.toLocaleString()}{" "}
                        {h.matchCount === 1 ? "match" : "matches"}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        of {h.scoredCount.toLocaleString()} scored
                      </span>
                    </>
                  ) : (
                    /* The one thing the badge said that the counts cannot: a run that has no counts
                       yet, or never will. Dropping the badge without this would leave a run in
                       flight and a run that died both rendering as a bare date — the two states
                       where the list has the most to tell you and would suddenly say nothing. */
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

              {/* Hidden until the row is hovered or something inside it takes focus — a
                  delete button on every line is a column of little red targets you never
                  asked for. focus-within keeps it reachable by keyboard. */}
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

