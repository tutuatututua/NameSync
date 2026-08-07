"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, History, Search, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { CompareModeBadge } from "@/components/compare-mode";
import { SourcesBadge } from "@/components/sources-badge";
import { ScopeBadge } from "@/components/scope-badge";
import { PAGE_SIZE as SHARED_PAGE_SIZE, Pager } from "@/components/pagination";
import { CompareScopeButton } from "@/components/network/CompareScopeButton";
import { sourcesLabel, type ComparisonListItem } from "@extensions/contract";
import type { RunListFilter } from "@/lib/api/client";
import { useRunSubjects, useUploadSources } from "@/hooks/queries";
import { useCarriedThreshold, withThreshold } from "@/hooks/useThreshold";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { usePermissions } from "@/components/auth-provider";
import { formatDate } from "@/lib/format";
import { rerunRequest, subjectTitles, type RunGroup } from "@/lib/run-groups";
import { cn } from "@/lib/utils";

/**
 * Comparison runs, newest first — including the ones each import kicks off on its own with the
 * external matcher. A run is immutable the moment it finishes, so there is no separate saved copy
 * to keep in step.
 *
 * ── ONE ROW PER SUBJECT, NOT PER RUN (2026-08-06) ──
 *
 * This was a flat list of runs, and it grew a near-duplicate row every time somebody used the
 * feature the page is built around. Re-running is "the same rows, compared differently", so a
 * second run of a subject arrives with the SAME auto-generated title as the first, one line below
 * it, differing only in two chips — and the more the product was used the less its own record of
 * itself could be read at a glance. Eight runs over four subjects looked like eight findings.
 *
 * Now `groupRuns` folds them by subject (`lib/run-groups.ts` owns the rules, and the run page shares
 * them): one row per company / owner / import / company-set, showing the NEWEST run's finding, with
 * the rest folded underneath as that subject's history. Nothing is hidden, nothing is aggregated —
 * every run is still one click away and still its own page. What changed is that the list answers
 * "what do I know about PTT" instead of "what runs exist", which is the question somebody opens
 * this tab holding.
 *
 * The order is by the subject's LATEST run, so pressing Compare moves that subject to the top —
 * where the reader is already looking for it.
 *
 * ── NOTHING HERE DELETES A RUN (2026-08-07) ──
 *
 * Each row carried an overflow menu whose one item was Delete, and it is gone. A run is the record
 * that a question was asked and what came back, and the Audit trail counts the rows that are still
 * there — so removing one edited the app's own history from a kebab menu, and left nothing behind
 * to say it had happened. The server refuses it too, for every account: the button was not the
 * enforcement (see the API's DELETE /api/comparisons/:id, which now answers 403 and says why).
 *
 * A list this cannot prune is a list that has to read well when it is long, which is what the
 * subject fold, the search box and the pager above are for.
 *
 * ── A RUN IS LISTED WHERE ITS SCOPE LIVES, AND ON RESULTS REGARDLESS ──
 *
 * The same component wherever a run has a home, each asking for the ones that belong to it:
 *
 *   · `/companies/[name]`  — `filter={{ axes: ['company'], value: name }}`
 *   · `/uploaders/[name]`  — `filter={{ axes: ['owner'],   value: name }}`
 *   · Network → Results    — no filter at all: every run in the product
 *
 * The scoped lists are not tidiness. "You already ran this — open it instead of running again" only
 * saves anybody a re-run if it is on screen at the moment they are about to press Run, and the
 * button that starts a scoped run lives on the scope's own page. On those pages the grouping
 * collapses to a single row by construction (every run there shares one scope), which is exactly
 * right: a company page should show ITS history, not a list that re-states the company four times.
 *
 * RESULTS IS THE OTHER HALF OF THAT, and it is unfiltered on purpose. The scoped lists answer "what
 * have I asked about THIS company" — the question you have while standing on the company. Results
 * answers "what has this product found", which is the question you arrive with, before you know
 * which company to stand on.
 */

/** Past runs only need a filter box once the list is long enough to scan badly. Counted in ROWS,
 *  which are subjects now — five subjects is a long list where five runs of one company is not.
 *  Measured against the SERVER's total rather than the page, so the box does not appear and vanish
 *  as you turn pages of a list that plainly needs it. */
const SEARCH_THRESHOLD = 5;

/**
 * Subjects per page.
 *
 * Counted in subjects, which is the unit the server pages by (`ComparisonSubjectsQuerySchema`) —
 * each one arriving with all of its runs, so a page is twenty rows and some bounded number of runs
 * rather than twenty runs cut wherever the twentieth fell.
 */
const PAGE_SIZE = SHARED_PAGE_SIZE;

export function RecentRuns({
  filter,
  title = "Recent comparisons",
  emptyDescription,
  canStartRuns = false,
}: {
  /** WHICH runs — see `RunListFilter`. Omitted is every run. */
  filter?: RunListFilter;
  /** The heading. Defaulted, because the workspace wants the plain one. */
  title?: string;
  /** What "nothing here yet" should say, when the generic "import some data" is the wrong advice —
   *  on a company page the data plainly exists, and what is missing is a run over it. */
  emptyDescription?: string;
  /**
   * Offer "New comparison" in the header — a run that starts from nothing, with every axis still
   * open in the dialog.
   *
   * OFF by default and ON only for Results, because every other place this list appears already
   * has one in ITS header, scoped to the page: a company's page and an owner's page each carry a
   * `CompareScopeButton` above this list, and a second unscoped button beneath it would offer to
   * start a broader run than the page the reader is standing on — the same "did it take my filter?"
   * confusion that got the workspace's version removed.
   *
   * Results has no scope to inherit, which is exactly why it needs this: until 2026-08-06 a run
   * could only be STARTED from a company or an owner, so a question about neither had no way in.
   * Every row here repeats a past run; this is the one control that originates one.
   */
  canStartRuns?: boolean;
} = {}) {
  const { canWrite } = usePermissions();
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(1);

  /**
   * The search is the SERVER's now, so it is debounced rather than applied per keystroke.
   *
   * It used to filter an array already in the browser, which is instant and free and was the only
   * reason it could be. Once the list is one page of a larger answer, filtering what is in hand
   * answers "does page one contain a LinkedIn run" — a question nobody has, and one whose answer
   * silently changes when you turn the page.
   */
  const q = useDebouncedValue(query.trim(), 300);
  // A new question is a new page 1. Landing on page 4 of a narrower list reads as "there are none".
  React.useEffect(() => setPage(1), [q, filter?.value, filter?.includeUnscoped]);

  const { data, isLoading, isFetching } = useRunSubjects({
    ...filter,
    q,
    page,
    limit: PAGE_SIZE,
  });

  const sourceList = useUploadSources();
  const sourceLabels = React.useMemo(
    () => new Map((sourceList.data ?? []).map((s) => [s.value, s.label])),
    [sourceList.data]
  );

  /**
   * The server's subjects, given their display title here.
   *
   * `key`, the axis and the runs come down the wire — the server owns the FOLD, because it owns the
   * page boundary and two implementations of a grouping rule cannot be allowed to disagree about
   * what a page contains. What a subject is CALLED stays here: it strips a date off an auto-named
   * run, prefers an import's filename over its re-runs' scope wording, and falls back through a
   * company list. That is display formatting, and `subjectTitle` already had it.
   *
   * Titled over the WHOLE PAGE at once rather than row by row, because one of the rules needs to
   * see its neighbours: the same file imported twice is two subjects with one name, and
   * `subjectTitles` stamps the arrival time on exactly the ones that would otherwise be
   * indistinguishable from something else on screen.
   */
  const groups: RunGroup[] = React.useMemo(() => {
    const subjects = data?.data ?? [];
    const titles = subjectTitles(subjects);
    return subjects.map((s, i) => ({
      key: s.key,
      title: titles[i]!,
      filterBy: s.filterBy,
      filterValue: s.filterValue,
      runs: s.runs,
      latest: s.runs[0]!,
    }));
  }, [data]);

  const searching = q.length > 0;
  const totalSubjects = data?.pagination.total ?? 0;
  const totalPages = data?.pagination.totalPages ?? 0;
  // How many RUNS this page is carrying. It cannot be the whole table's run count any more — that
  // number is not on the page and inventing one would be worse than saying nothing. See `countLine`.
  const runsOnPage = groups.reduce((n, g) => n + g.runs.length, 0);
  /**
   * The box stays up once it has been earned, and `searching` is what earns it back.
   *
   * `totalSubjects` is the count for the CURRENT query, so a search narrowing 40 subjects to 2
   * would otherwise drop below the threshold and remove the box the reader is typing into — with
   * their text still in it.
   */
  const showSearch = searching || totalSubjects > SEARCH_THRESHOLD;

  return (
    <section className="space-y-4">
      <SectionHeader
        title={title}
        // Counted over what MATCHES, not over what is on screen — one page of twenty subjects out
        // of ninety must not describe itself as twenty. The run half is explicitly this page's,
        // because the whole answer's run count is not something a paged read knows. See `countLine`.
        description={countLine(totalSubjects, runsOnPage, searching)}
        actions={
          showSearch || canStartRuns ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {showSearch && (
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
              )}
              {/* No `scope` — this is the run that starts from nothing, and the dialog it opens
                  asks for the companies and the sources rather than inheriting them. Renders
                  nothing for a reviewer, from inside the button. See `canStartRuns`. */}
              {canStartRuns && (
                <CompareScopeButton label="New comparison" covers="every row on file" />
              )}
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
      ) : groups.length === 0 && searching ? (
        /* The SEARCH found nothing — escaped by clearing the box, not by importing. Keyed on
           `searching` rather than on a second array being empty, which is how the two empty states
           told themselves apart while the filtering happened in the browser and both a filtered and
           an unfiltered list were in hand at once. Only one is now. */
        <EmptyState
          icon={Search}
          title={`No runs match “${q}”`}
          description="Try a shorter search, or clear the filter."
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery("")}>
              Clear filter
            </Button>
          }
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={History}
          title="No comparisons yet"
          description={
            // A scoped list says what is missing HERE. "Import some data" is wrong advice on a
            // company page — the data is plainly on screen above it; what has not happened is a run.
            emptyDescription ??
            (canWrite
              ? "Import a friend list and some company data — a run is kept here automatically."
              : "No runs have been recorded yet.")
          }
          action={
            // The import prompt belongs only to the list that really is empty for want of data.
            // On a scoped page the Compare button in the header is the action, and a second one
            // pointing at Uploads would send the reader away from it.
            canWrite && !emptyDescription ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/uploads">
                  <UploadCloud className="h-4 w-4" /> Import data
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Dimmed while the next page or the next search is in flight — `keepPreviousData` holds
              the last answer on screen so there is something to read, and the fade is what stops it
              from being mistaken for the new one. The controls above and below deliberately do not
              fade: an input that greys out under the cursor reads as disabled. */}
          <div
            className={cn(
              "overflow-hidden rounded-lg border transition-opacity",
              isFetching && "opacity-60"
            )}
          >
            {groups.map((group) => (
              <SubjectRow key={group.key} group={group} sourceLabels={sourceLabels} />
            ))}
          </div>

          {/* Counted in SUBJECTS, which is the unit the pages are cut in — see `PAGE_SIZE`. The
              run count belongs to the header line above, where it is already stated as this page's
              rather than the whole table's. */}
          <Pager
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            label="comparisons"
            pending={isFetching}
            summary={`Page ${page.toLocaleString()} of ${totalPages.toLocaleString()} · ${totalSubjects.toLocaleString()} ${
              totalSubjects === 1 ? "subject" : "subjects"
            }`}
          />
        </>
      )}
    </section>
  );
}

/**
 * "6 subjects · 8 runs" — what the list is showing, in words.
 *
 * ── THE TWO NUMBERS COUNT DIFFERENT THINGS NOW, AND THAT IS DELIBERATE ──
 *
 * `subjects` is the whole ANSWER's count, straight off `pagination.total`: it is what the pager
 * divides into pages, and reporting page one's twenty out of ninety would make the pager look
 * broken. `runs` is THIS PAGE's, because a paged read genuinely does not know the run count of the
 * pages it has not fetched — and a made-up number beside a real one is worse than one number.
 *
 * So the run half is dropped whenever the two would be read as counting the same set: on a single
 * page (where "6 subjects · 8 runs" is honest, both being everything) it stays, and once there is
 * more than one page it goes, leaving the subject count and the pager to agree with each other.
 *
 * Undefined at zero — the empty state carries that news, and says something more useful with it.
 */
function countLine(subjects: number, runsOnPage: number, searching: boolean): string | undefined {
  if (subjects === 0) return undefined;
  const subjectWord = `${subjects.toLocaleString()} subject${subjects === 1 ? "" : "s"}`;
  // A search's count is the thing the reader is watching change as they type, so it is named as a
  // result rather than left to look like the database's size.
  if (searching) return `${subjectWord} match${subjects === 1 ? "es" : ""}`;
  // One subject is the whole list — the scoped pages, where the subject is the page you are on and
  // "1 subject" is the heading again. Equal counts mean nothing was folded, and naming both numbers
  // would be the same fact twice.
  if (subjects === 1 || subjects === runsOnPage) {
    return `${runsOnPage} run${runsOnPage === 1 ? "" : "s"}`;
  }
  // Only when this page IS the answer; see above.
  if (subjects <= runsOnPage) return `${subjectWord} · ${runsOnPage} runs`;
  return subjectWord;
}

/**
 * One subject: its newest answer on the face, its whole history one press away.
 *
 * ── WHAT THE COLLAPSED ROW SAYS, AND WHY IT IS THE NEWEST RUN'S FACTS ──
 *
 * The mode and source chips describe the LATEST run, not the group — a subject asked twice has two
 * of each, and averaging or listing them would describe a run that never happened. They are here
 * because they qualify the finding printed beside them, which is also the latest run's: this row
 * says "here is what we most recently found about PTT, and how we asked". The count button says
 * plainly that there are others, and opening it is the only way this row talks about them.
 *
 * The title links to that same latest run, so the row's obvious click and its stated summary agree.
 */
function SubjectRow({
  group,
  sourceLabels,
}: {
  group: RunGroup;
  sourceLabels: ReadonlyMap<string, string>;
}) {
  const [open, setOpen] = React.useState(false);
  const { latest, runs } = group;
  const many = runs.length > 1;
  /*
    THE WORKSPACE BAR, THROUGH THE RUN PAGE.

    Every surface that lists runs — the Results tab, a company's page, an owner's — is a workspace
    surface with the bar in its URL, and a run page is the one place a reader routinely goes from
    them and comes back out of (to Results, or sideways into a roster through a row's owner link).
    Dropping it here made that trip a silent reset: 60% on the way in, the default on the way out.

    The run itself is still read at its matcher's own verdicts and this changes nothing about that —
    see the run page. The parameter rides in the URL and grades nothing on it.
  */
  const threshold = useCarriedThreshold();

  return (
    <div className="border-b last:border-b-0">
      <div className="group relative flex items-center gap-3 p-4 transition-colors hover:bg-muted/40 focus-within:bg-muted/40">
        <div className="flex min-w-0 flex-1 flex-col gap-x-4 gap-y-0.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <Link
              href={withThreshold(`/comparisons/${latest.id}`, threshold)}
              className="min-w-0 outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
            >
              {/* The SUBJECT, not the run's name. A scoped run is auto-named after its own scope,
                  so printing `runTitle` here put "Owner · Nalinee Boonmee" directly above a chip
                  reading "Owner · Nalinee Boonmee". See `subjectTitle`. */}
              <p className="truncate font-medium">{group.title}</p>
            </Link>
            {/* `relative z-10` keeps the chips above the row's stretched link so the title's click
                target does not swallow the tooltip on the sources chip. */}
            <div className="relative z-10 mt-1 flex flex-wrap items-center gap-1.5">
              {/* AXIS ONLY — the value is the title now. This chip says what KIND of subject the
                  heading names, which is the part the heading cannot say for itself. */}
              <ScopeBadge
                axisOnly
                filterBy={latest.filterBy}
                filterValue={latest.filterValue}
                className="text-2xs"
              />
              <CompareModeBadge mode={latest.compareBy} className="text-2xs" />
              <SourcesBadge sources={latest.sources} labels={sourceLabels} className="text-2xs" />
            </div>
          </div>

          <p className="shrink-0 text-sm tabular-nums text-muted-foreground sm:text-right">
            {formatDate(latest.date)}
            {" · "}
            <RunFinding run={latest} />
          </p>
        </div>

        {/*
          THE HISTORY, AS A COUNT YOU CAN PRESS.

          Only when there is one — a "1 run" toggle on every single-run subject would be a control
          that opens a restatement of the row above it, on what is usually most of the list.

          It is a button rather than a link because the history opens IN PLACE: the reader is
          comparing this subject's answers to each other, and sending them to another page to do it
          would lose the row they are comparing against.
        */}
        {many && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="relative z-10 shrink-0 gap-1.5 text-muted-foreground"
          >
            <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
            {runs.length} runs
          </Button>
        )}

        {/*
          ASK IT AGAIN, DIFFERENTLY — the action this list exists to offer, seeded from the newest
          run of the subject because that is the question the reader is looking at.

          `relative z-10` lifts it above the title's stretched link, or the anchor would swallow the
          click and navigate instead. Writers only, enforced inside the button rather than here —
          see `CompareScopeButton`. That is what lets this whole list be a page a reviewer can open.
        */}
        <RerunButton run={latest} />
      </div>

      {open && <RunHistory group={group} sourceLabels={sourceLabels} />}
    </div>
  );
}

/**
 * A subject's runs, oldest question and newest side by side.
 *
 * Each line leads with its DATE and its two settings, because within one subject those are the only
 * things that differ — the scope is the row above and repeating it here would be four copies of the
 * heading. That is the whole comparison this panel exists to support: "the Facebook run found 8,
 * the CMA run found 15", which is a sentence nobody could assemble while those two runs were
 * separate rows in a list sorted by date.
 */
function RunHistory({
  group,
  sourceLabels,
}: {
  group: RunGroup;
  sourceLabels: ReadonlyMap<string, string>;
}) {
  // Same reason as the collapsed row above: a history entry is a link INTO a run, and the bar has
  // to survive the trip.
  const threshold = useCarriedThreshold();

  return (
    <div className="border-t bg-muted/30 px-4 py-3">
      <p className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Comparison history
      </p>
      <ol className="space-y-0.5">
        {group.runs.map((run, i) => (
          <li
            key={run.id}
            className="relative flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2 transition-colors hover:bg-background focus-within:bg-background"
          >
            <Link
              href={withThreshold(`/comparisons/${run.id}`, threshold)}
              className="shrink-0 text-sm tabular-nums outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
            >
              {formatDate(run.date)}
            </Link>

            <div className="relative z-10 flex min-w-0 flex-wrap items-center gap-1.5">
              <CompareModeBadge mode={run.compareBy} className="text-2xs" />
              <SourcesBadge sources={run.sources} labels={sourceLabels} className="text-2xs" />
              {/* Which of these the row above is quoting. Only on the first, and only when there is
                  something for it to be newest OF. */}
              {i === 0 && (
                <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Latest
                </span>
              )}
            </div>

            <p className="ml-auto shrink-0 text-sm tabular-nums text-muted-foreground">
              <RunFinding run={run} />
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What a run found, or what it is still doing — one spelling for the collapsed row and the history
 *  line, so a subject's summary and its own first history entry cannot disagree. */
function RunFinding({ run }: { run: ComparisonListItem }) {
  if (run.status !== "completed") {
    return (
      <span
        className={cn(
          "font-medium",
          run.status === "failed" ? "text-destructive" : "text-foreground"
        )}
      >
        {run.status === "failed" ? "Failed" : "Running"}
      </span>
    );
  }
  return (
    <>
      <span className={run.matchCount > 0 ? "font-medium text-foreground" : undefined}>
        {run.matchCount.toLocaleString()} {run.matchCount === 1 ? "match" : "matches"}
      </span>{" "}
      <span className="text-muted-foreground">of {run.scoredCount.toLocaleString()} scored</span>
    </>
  );
}

/**
 * One row's "ask this again" — `rerunRequest` wired to the shared button.
 *
 * Its own component so the mapping is read where it is used rather than inlined into a row that is
 * already carrying a link, three badges and a menu. It renders nothing for a reviewer; the check is
 * inside `CompareScopeButton`, which is the only place it should ever be written.
 */
function RerunButton({ run }: { run: ComparisonListItem }) {
  const { scope, scopeSelects, initial, covers } = rerunRequest(run);
  return (
    <CompareScopeButton
      scope={scope}
      scopeSelects={scopeSelects}
      initial={initial}
      covers={covers}
      variant="outline"
      size="sm"
      className="relative z-10 shrink-0"
    />
  );
}
