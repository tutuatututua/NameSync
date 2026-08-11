"use client";

import * as React from "react";
import {
  ArrowRight,
  Ban,
  Building2,
  CircleDashed,
  Search,
  TriangleAlert,
  Users,
} from "lucide-react";
import {
  compareByAxes,
  LANGUAGE_LABEL,
  type CompareLanguage,
  resolveScoredPair,
  rowVerdict,
  runRowBucket,
  scoreQualifier,
  DEFAULT_COMPARE_BY,
  type CompareType,
  type ComparisonProgress,
  type RunRowBucket,
  type RunRow,
} from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CompareModeBadge } from "@/components/compare-mode";
import { SourcesBadge } from "@/components/sources-badge";
import { MarkedName } from "@/components/marked-name";
import { Side } from "@/components/pair-side";
import { Provenance } from "@/components/provenance";
import { Score } from "@/components/score";
import { useFullWidth } from "@/components/main-container";
import { PAGE_SIZE, Pager } from "@/components/pagination";
import { useRunRows, useUploadSources } from "@/hooks/queries";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { RunRowsParams } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { parseExtra } from "@/lib/match";
import { cn } from "@/lib/utils";

/**
 * Every row a run looked at, and what it decided about each — the only table on this page.
 *
 * ── Why this stopped being a table ──
 *
 * It was a grid: [Friend | Owner][Contact | Company][extras][similarity][Outcome], two tinted
 * blocks with a rule between them, and it was the widest thing in the product before this change
 * asked it to also carry the uploader, a timestamp, the run's mode and a fifth outcome.
 *
 * A table's promise is that column N means the same thing on every row and is comparable down the
 * page. Of the facts here only the outcome and the score actually are. The owner, the company,
 * the importer and the date are read ONE ROW AT A TIME, to answer "do I act on this?" — putting
 * non-comparable facts in columns is what made it wide, and appending four more would have made
 * it unreadable while looking like progress.
 *
 * So each row is a sentence with the answer in it:
 *
 *     friend  สมชาย ใจดี  →  contact  สมชาย ใจดี  at BANGKOK BANK      [ 94% ]
 *     ⌂ Owner  Mint W.    ⤓ Uploaded by  Alex K.
 *     ─────────────────────────────────────────────────────────────────────────
 *     updated Jul 28, 2026
 *
 * The three slots of "to reach X at Y, talk to Z" get the three strongest positions; mode,
 * confidence and provenance are secondary and look it. Scanning is still served — by the filter
 * tabs and the sort, which is what people actually scan with on a paged list of 320.
 *
 * ── The row is a PAIRING, and it says so (2026-07-31) ──
 *
 * It used to lead with the contact alone, in the largest type on the row, and mention what that
 * contact was matched WITH down in the grey provenance line — `→ matched รัชดา นครทรัพย์`, wedged
 * between the importer's name and a timestamp. That put the run's entire evidence in the one place
 * on the row designed to be skipped, and left the two names it is a claim about at different sizes,
 * in different colours, three lines apart. A reader could not answer "which name from the company
 * was compared to which name in my friends list" without hovering.
 *
 * A turned-down row was worse: it showed the uploaded name and NOTHING ELSE, under a score. `พรทิพย์
 * โอสถานนท์ · surname 100%` — a hundred percent against whom? The counterpart was in the payload
 * (`matchedName`, kept for every scored row, matched or not) and was simply not rendered, so the one
 * number on the row referred to something the row did not contain.
 *
 * Both halves of the pairing are now on one line, at one size, in a fixed order — FRIEND ALWAYS ON
 * THE LEFT, CONTACT ALWAYS ON THE RIGHT, whichever direction the run runs in — each behind a small
 * role label, with `MarkedName` underlining the span that was actually scored on both sides at once.
 * The same reading `ConnectionCard` gives one connection on the company page, which is deliberate:
 * two renderings of "this was compared against that" would be two answers to one question.
 *
 * ── ONE ROW SHAPE. The verdict is off the row entirely (2026-07-31) ──
 *
 * Whether the matcher called a pairing a match used to be stated three times over, and every one of
 * them forked the layout: a filled-vs-bare score chip, a `✓ Match` / `⊘ Not a match` caption, a bold
 * -vs-medium name weight, and the owner named inline on accepted rows against `friend on Mint W.'s
 * list` on rejected ones — the same person, in a different place, at a different size. Fifty rows of one kind
 * of finding read as two kinds of thing, and the first question the finished page got was why some
 * scores had a box around them.
 *
 * All of it is gone. Every scored row is now laid out identically and the ONLY thing that varies is
 * the hue of the percent, which is the measurement. The reader draws their own line.
 *
 * This is not a claim that the verdict is worthless — it is a claim about where it belongs. It is a
 * fact about the RUN's mode far more than about any row: on a surname run every high score means
 * "same family name, verify the person", which `ScoreLegend` says once, above the list, instead of
 * fifty times inside it. The matcher's decision still drives the filter tabs, the headline count and
 * the sort. It is simply not a decoration on each row any more.
 *
 * The badge survives for rows with NO measurement to show: waiting, failed, never compared, and a
 * matcher that reported bare verdicts with no scores at all. Those are absences of a number, and a
 * tinted percent cannot state an absence.
 *
 * ── Direction ──
 *
 * Both kinds of run produce the same sentence from opposite sides, which is why there is one
 * layout and not two. The person you are trying to REACH is always the company contact, and the
 * person to ASK is always the friend's owner:
 *
 *   · friends import / compare — the row is a friend, the contact is what it matched.
 *   · company import          — the row is a contact, the friend is what it matched.
 *
 * `kind` picks which side supplies which, and nothing else about the row changes.
 */

/*
 * A `PAGE_SIZE = 25` stood here. It is 20 now and it comes from `components/pagination`, with every
 * other paged list in the app: the size only means anything to a reader if it is the same size
 * everywhere, and this table was the one list that answered "how far down is row 200" differently
 * from the rest.
 */

/**
 * Below this many rows, the table shows no filter tabs and no sort control.
 *
 * They are controls for a list you have to *navigate*, and a run with four rows in it is not
 * navigated, it is read. Under that size they are worse than useless: "All 2 · Matches 1 · No
 * match 1" is a third restatement of a headline two inches above it, and "Best first / File order"
 * offers to reorder a list you can take in whole. Chrome that cannot do anything reads as chrome
 * you have not understood yet.
 *
 * Ten because that is roughly where a list stops being a paragraph. It is a judgement, not a
 * measurement.
 */
const CONTROLS_MIN_ROWS = 10;

type Filter = NonNullable<RunRowsParams["filter"]>;
type Sort = NonNullable<RunRowsParams["sort"]>;
type Kind = RunRow["kind"];
type Origin = ComparisonProgress["origin"];

/**
 * The five outcomes, as they read on screen — for the rows a tinted score cannot speak for.
 *
 * `matched` and `unmatched` are still here and still correct, but on an ordinary run neither is
 * rendered any more: a row that was scored says so with the colour of its percent. They are reached
 * only where there is no number to tint — a workflow that posts a bare verdict, or a run whose
 * scores predate the `similarity` column. Deleting them would leave those rows with an empty gutter
 * and no statement at all, which is a worse trade than a badge that rarely appears.
 *
 * `unscored` is the one that is not a workflow status — it is derived from the run's mode and the
 * row's stored names (see `runRowBucket`), and it exists because reusing the no-match badge for it is the
 * single worst outcome available in this feature. "No match" is a finding: nobody at this company
 * is called that. "Not compared" is the absence of one: this row was never held up against
 * anything, because the run compared Thai names and this row has no Thai name on file. Rendering them
 * identically turns a question that was never asked into an answer.
 *
 * Its hint became a FACT rather than an inference on 2026-07-28: `friend` gained a column per
 * language, so the row was skipped because we hold no name in the run's language — checkable —
 * rather than because its characters read as the wrong script. `company_contact` has always had
 * the pair, so the same sentence is checkable on both sides of an import.
 *
 * IT ALSO HAS TO NAME THE RIGHT SIDE. The sentence said "for this friend" unconditionally, which
 * is exactly backwards on a COMPANY import: the row there is a contact out of the uploaded file,
 * and the friend is whatever it matched. A badge explaining a skipped contact by describing a
 * friend is the same class of error as the one this bucket exists to prevent — a true fact about
 * the wrong record — so it takes `kind` as well as the language.
 *
 * So they are told apart three ways at once, because one is not enough at a glance: a different
 * icon, a dashed rather than solid border, and a tooltip that says which fact it is.
 */
/**
 * The buckets this badge can express — the three that are a STATE rather than a verdict.
 *
 * `matched` and `unmatched` were in here and are deliberately typed out of it. A run row does not
 * announce what the matcher concluded any more (see the file header); the two of them reached this
 * badge only when there was no score to show, and what that row actually needs to say is that the
 * MEASUREMENT is missing — which `Score` says with a dash. Excluding them at the type level is what
 * stops "No match" quietly reappearing on the one class of run that has no numbers in it.
 */
type StateBucket = Exclude<RunRowBucket, "matched" | "unmatched">;

const VERDICT: Record<
  StateBucket,
  {
    label: string;
    icon: typeof CircleDashed;
    className: string;
    spin?: boolean;
    /** A function where the sentence needs the run's mode or direction to be exact — see
     *  `unscored`, which needs both. */
    hint?: string | ((language: CompareLanguage, kind: Kind) => string);
  }
> = {
  pending: {
    label: "Waiting",
    icon: CircleDashed,
    className: "border-border-strong bg-transparent text-muted-foreground",
    spin: true,
  },
  unscored: {
    label: "Not compared",
    icon: Ban,
    className: "border-dashed border-border-strong bg-transparent text-muted-foreground/80",
    // A CHECKABLE FACT since 2026-07-28, where it used to be an inference. It said "this name
    // isn't in the language this run compared", which was our reading of the characters — and for
    // an external run it was only ever a guess about what the workflow did. `friend` now has a
    // column per language, so the row was skipped because we hold no name in that one, full stop.
    // The language and the direction are filled in by the caller, which knows the run's mode and
    // which side its rows are — see the header on why naming the wrong side is not a wording nit.
    hint: (language: CompareLanguage, kind: Kind) =>
      `No ${LANGUAGE_LABEL[language]} name on file for this ${
        kind === "company" ? "contact" : "friend"
      }, so it was never scored against anyone.`,
  },
  failed: {
    label: "Failed",
    icon: TriangleAlert,
    className: "border-destructive/25 bg-destructive/10 text-destructive",
  },
};

/**
 * The panel's title and subtitle.
 *
 * Split on `origin` and not on `kind`, because this is the one thing the two imports agree about
 * and the compare does not: you handed over a file, so the rows are yours. A compare scored a
 * friend list that was already on file and may have been uploaded by somebody else entirely —
 * calling that "your rows" is a small lie that makes the whole panel read as someone else's data.
 */
function heading(origin: Origin, live: boolean, company: string | null): { title: string; description: string } {
  if (origin === "compare") {
    return {
      title: "Friends scored",
      // Named only when the run picked one. A legacy whole-table run has no selected company, and
      // "someone at this company" would point at a company the page has already said it doesn't
      // have — the panel above it reads "All companies on file".
      description: company
        ? `Every friend on file, and how close they came to someone at ${company}.`
        : "Every friend on file, and the closest contact each one has.",
    };
  }
  return {
    title: "Your rows",
    description: live
      ? "Each name you uploaded, and what the matcher has said about it so far."
      : "Each name you uploaded, and what the matcher said about it.",
  };
}

function VerdictBadge({
  bucket,
  language,
  kind,
}: {
  bucket: StateBucket;
  language: CompareLanguage;
  /** Which side this run's rows are. `unscored` explains itself about the row in front of the
   *  reader, and on a company import that row is a contact — see the VERDICT header. */
  kind: Kind;
}) {
  const { label, icon: Icon, className, spin, hint } = VERDICT[bucket];
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 gap-1.5", className)}
      title={typeof hint === "function" ? hint(language, kind) : hint}
    >
      <Icon className={cn("h-3 w-3 shrink-0", spin && "animate-spin [animation-duration:2.5s]")} aria-hidden />
      {label}
    </Badge>
  );
}

/**
 * The filter tabs, each carrying its own count.
 *
 * The counts come from the progress endpoint rather than from this list, because this list only
 * ever holds one page: counting its rows would label the "Match" tab with the number of matches
 * *on screen*, which on page 1 of 13 is a different and much smaller number than the truth.
 */
function filterTabs(progress: ComparisonProgress | undefined) {
  const tabs: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: "All", count: progress?.total },
    { key: "matched", label: "Matches", count: progress?.matched },
    { key: "unmatched", label: "No match", count: progress?.unmatched },
  ];

  /**
   * "Not compared" is a tab only where the rows can actually be reached.
   *
   * On an import run they exist — the workflow was handed them and stamped them, and they sit in
   * `friend` / `company_contact` waiting to be filtered to. On a compare run they do not: the
   * internal matcher writes no result row for a name its mode could not score, so the count is
   * real (taken from the friend table) but there is nothing for a tab to page through. A tab
   * promising 280 rows and delivering an empty list is worse than no tab; the count is stated
   * once, in the panel subtitle, and left there.
   */
  if (progress && progress.unscored > 0 && progress.origin === "import") {
    tabs.push({ key: "unscored", label: "Not compared", count: progress.unscored });
  }

  // "Waiting" is not a state a compare-by-company run can be in — the matcher finished inside the
  // request that created it, so a row exists only once it has been decided. The tab would be a
  // permanent zero, which reads as "none waiting yet" rather than "this cannot happen".
  if (!progress || progress.origin === "import") {
    tabs.push({ key: "pending", label: "Waiting", count: progress?.pending });
  }

  // Only offered once there is one. A "Failed (0)" tab on a healthy run is an invitation to worry
  // about nothing; a "Failed (3)" tab on a broken one is the most important control on the page.
  if (progress && progress.failed > 0) {
    tabs.push({ key: "failed", label: "Failed", count: progress.failed });
  }

  return tabs;
}

interface Props {
  comparisonId: string;
  /** The counts above the list — also what labels the filter tabs, what says which way round the
   *  run is, and which mode it ran under. */
  progress?: ComparisonProgress;
  /** Keep polling. False for a run that has stopped moving; its rows are still worth reading. */
  live: boolean;
  /** The company this run picked, if it picked one. Only used to name it in the subtitle. */
  company?: string | null;
  /*
   * A `threshold` prop stood here, passed to the SERVER so the paged list and the tab counts were
   * graded at one bar. Nothing sends one now: the slider moved to the Network page, where it grades
   * the pooled answer instead of one historical run. The endpoint still accepts `?threshold=`, so
   * this is a prop away from coming back if a run ever needs re-reading again.
   */
}

export function RunRows({ comparisonId, progress, live, company = null }: Props) {
  const [filter, setFilter] = React.useState<Filter>("all");
  const [page, setPage] = React.useState(1);
  /**
   * The search box — a name, a company, an owner.
   *
   * SERVER-side, like the sort and for the same reason: a 320-row run is sixteen pages, and
   * "somchai" typed at a page of 20 would search the 20 rows in front of you and report nothing
   * about the other 300. Debounced, because it is a request per pause and the list may also be
   * polling itself while the run is live.
   */
  const [query, setQuery] = React.useState("");
  const q = useDebouncedValue(query.trim(), 300);

  useFullWidth();

  // Where the run came from. Derived from the poll (a prop) up here, because the default sort
  // below depends on it.
  const origin: Origin = progress?.origin ?? "import";
  const compareBy = progress?.compareBy ?? DEFAULT_COMPARE_BY;
  const { type: compareType, language: compareLanguage } = compareByAxes(compareBy);
  // The unit every score on this run is in — null on a whole-name run, where the bare percent
  // already means what it looks like. Resolved once here; it is the same for all 20 rows.
  const qualifier = scoreQualifier(compareBy);
  // Which friends were in the run. Null (every source) is a value here, not an absence — the badge
  // renders it as "All sources" rather than hiding, see SourcesBadge.
  const sources = progress?.sources ?? null;
  // The pick-list, only so the chip shows 'LinkedIn' rather than the title-cased 'Linkedin' its
  // fallback would produce. Cached hard and shared with every other screen that reads it.
  const sourceList = useUploadSources();
  const sourceLabels = React.useMemo(
    () => new Map((sourceList.data ?? []).map((s) => [s.value, s.label])),
    [sourceList.data]
  );

  /**
   * Whether this run carries a per-row similarity to rank and show.
   *
   * The run's own answer, from the progress poll, rather than a guess from `origin` — an external
   * matcher that reports `similarity` has it stored in the same column the internal one writes, so
   * "does this run have scores" is a fact about the rows and only they can answer it.
   * `origin === "compare"` survives as the fallback for the first frame, before the poll lands.
   */
  const showSimilarity = progress?.hasSimilarity ?? origin === "compare";

  /**
   * Null until the reader says otherwise.
   *
   * The default follows `live`, because the only reason to hold import order is that the list is
   * moving: it re-reads every couple of seconds, and rows that re-sorted as verdicts landed would
   * slide out from under the line you were reading. The moment the run stops, that reason is gone
   * and import order becomes the problem instead — the four matches of a 320-row run are scattered
   * across 13 pages. An explicit choice is never overridden.
   */
  const [sortOverride, setSortOverride] = React.useState<Sort | null>(null);
  /**
   * A finished run with no scores falls back to file order, NOT to "status".
   *
   * It used to default to `status` — matches first — which was the best available answer while
   * that was an offered sort. It is not offered any more, and a default the control cannot display
   * is worse than a duller one: every segment renders inactive, so the toggle shows three options
   * and claims none of them is in effect.
   */
  const sort: Sort = sortOverride ?? (!live && showSimilarity ? "similarity" : "row");

  // All three re-page from the top: page 4 of "all" is not page 4 of "matches", still less page 4
  // of a search, and landing on an empty page you didn't ask for reads as "there are none".
  React.useEffect(() => setPage(1), [filter, sort, q]);

  const params = React.useMemo<RunRowsParams>(
    // `q || undefined` — an empty string would be sent as `?q=`, which the schema's `min(1)`
    // rejects, and the box starts empty on every run.
    () => ({ page, limit: PAGE_SIZE, filter, sort, q: q || undefined }),
    [page, filter, sort, q]
  );
  const rowsQuery = useRunRows(comparisonId, params, live);

  const rows = rowsQuery.data?.data ?? [];
  const total = rowsQuery.data?.pagination.total ?? 0;
  const totalPages = rowsQuery.data?.pagination.totalPages ?? 0;
  const tabs = filterTabs(progress);

  const kind: Kind = progress?.kind ?? rows[0]?.kind ?? "facebook";
  const extraKeys = progress?.extraKeys ?? [];

  /**
   * Are the controls worth their space?
   *
   * Measured on the run's own size (`progress.total`), never on the page's — the pagination total
   * moves with the filter, so a list filtered down to two rows would hide the very tabs you would
   * need to get back out of it. A failed row overrides the size test outright: on a 4-row run
   * "Failed 3" is the only thing on the screen that matters.
   */
  const runSize = progress?.total ?? 0;
  const showControls = runSize >= CONTROLS_MIN_ROWS || (progress?.failed ?? 0) > 0;

  const { title, description } = heading(origin, live, company);

  // Said in the subtitle rather than as a tab, for compare runs where the rows do not exist to be
  // filtered to. Without it a Thai-name run over 320 friends reports a 40-row run and never
  // mentions the 280 it ruled out, which reads as "you only have 40 friends".
  const unscored = progress?.unscored ?? 0;
  const unscoredNote =
    unscored > 0 && origin === "compare"
      ? ` ${unscored.toLocaleString()} more have no ${
          LANGUAGE_LABEL[compareByAxes(compareBy).language]
        } name on file and weren't scored.`
      : "";

  return (
    <Card>
      <CardContent className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-lg font-semibold leading-none tracking-tight">{title}</h3>
              {/* Which side this run is about. */}
              <Badge variant="secondary" className="gap-1.5">
                {kind === "facebook" ? (
                  <Users className="h-3 w-3 shrink-0" aria-hidden />
                ) : (
                  <Building2 className="h-3 w-3 shrink-0" aria-hidden />
                )}
                {kind === "facebook" ? "Friends" : "Company contacts"}
              </Badge>
              {/*
                The run's mode, on the run and never on the row — it is constant for all 20 of
                them. A full-name English finding and a last-name Thai finding are not comparable
                results, and a list that does not say which it is holding invites exactly that
                comparison. One place, always visible, impossible to page past.
              */}
              <CompareModeBadge mode={compareBy} />
              {/*
                And WHOSE friends, beside HOW — the other half of the run's question, and the half
                that explains a denominator. A LinkedIn-only run against 318 of 1,564 friends looks
                identical to a full run that lost 1,246 rows somewhere; this chip is the difference.

                Only on a run whose rows are friends. A company-contact run's rows are contacts,
                which have no source — the axis describes where a FRIENDS list came from, and a
                chip here would be labelling the wrong side of the comparison.
              */}
              {kind === "facebook" && <SourcesBadge sources={sources} labels={sourceLabels} />}
            </div>
            <p className="text-sm text-muted-foreground">
              {description}
              {unscoredNote}
            </p>
          </div>

          {showControls && (
            <div className="flex flex-wrap items-center gap-3">
              {/* Beside the tabs rather than above them, because it is the same kind of control:
                  both narrow WHICH rows, and they compose — "the matches called somchai". The
                  tabs' counts stay the run's, which is why the line under the list states how many
                  rows the search actually left. */}
              <div className="relative w-full sm:w-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search these rows…"
                  className="h-8 pl-8"
                  aria-label="Search rows by name"
                />
              </div>

              <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter rows by outcome">
                {tabs.map((t) => (
                  <Button
                    key={t.key}
                    role="tab"
                    aria-selected={filter === t.key}
                    variant={filter === t.key ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setFilter(t.key)}
                    className="gap-1.5"
                  >
                    {t.label}
                    {t.count !== undefined && (
                      <span className="tabular-nums text-muted-foreground">{t.count.toLocaleString()}</span>
                    )}
                  </Button>
                ))}
              </div>

              <SortToggle sort={sort} onChange={setSortOverride} showSimilarity={showSimilarity} />
            </div>
          )}
        </div>

        {/* Held until there are rows AND scores to explain: a legend over a skeleton, an empty
            filter or a run of bare verdicts describes a column that is not on the screen. */}
        {showSimilarity && !rowsQuery.isLoading && rows.length > 0 && (
          <ScoreLegend qualifier={qualifier} partial={compareType !== "full"} />
        )}

        {/* What the SEARCH left, stated whenever one is on. The filter tabs above carry the run's
            own counts (they come from the progress endpoint, which knows nothing about this box),
            so without this line a search that leaves 2 of 320 rows sits under a tab reading
            "All 320". */}
        {q && !rowsQuery.isLoading && rows.length > 0 && (
          <p className="text-sm tabular-nums text-muted-foreground">
            {total.toLocaleString()} row{total === 1 ? "" : "s"} match “{q}”
          </p>
        )}

        <div className="overflow-hidden rounded-lg border">
          {rowsQuery.isLoading ? (
            <div className="divide-y">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="p-4">
                  <Skeleton className="h-12 w-full" />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            /* The search is named first when there is one: "this run has no rows" is alarming and
               false the moment a box above the list is holding a typo. */
            <p className="py-10 text-center text-sm text-muted-foreground">
              {q
                ? `No ${filter === "all" ? "" : "matching "}row contains “${q}”.`
                : filter === "all"
                  ? `This run has no rows${live ? " yet" : ""}.`
                  : `No rows in this view${live ? " yet" : ""}.`}
            </p>
          ) : (
            <ul className="divide-y">
              {rows.map((r) => (
                <Row
                  key={r.id}
                  row={r}
                  kind={kind}
                  type={compareType}
                  language={compareLanguage}
                  extraKeys={extraKeys}
                  showSimilarity={showSimilarity}
                  qualifier={qualifier}
                />
              ))}
            </ul>
          )}
        </div>

        {/* The row count stays in the summary: on a filtered or searched list it is the only place
            the reader learns how many rows they are actually paging through. */}
        <Pager
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          label="run rows"
          /* `isPlaceholderData` and NOT `isFetching`, which is the one place in the app where the
             difference is load-bearing: a live run re-reads this list every couple of seconds, so
             `isFetching` would leave "Loading page 1…" blinking under a table nobody asked to move.
             `isPlaceholderData` is true only while a page, filter, sort or search the reader
             actually asked for is still in flight. */
          pending={rowsQuery.isPlaceholderData}
          summary={`Page ${page.toLocaleString()} of ${totalPages.toLocaleString()} · ${total.toLocaleString()} row${
            total === 1 ? "" : "s"
          }`}
        />
      </CardContent>
    </Card>
  );
}

/**
 * How to read a row — one sentence, once, above the list.
 *
 * A legend is usually a confession that a picture does not label itself, and this codebase deleted
 * one (`MergeSummary`) on exactly that argument. This one earns its line because it states the
 * caveat that used to be smeared across all fifty rows: on a run that compared part of a name, a
 * perfect score is NOT a claim about identity. That is a property of the run's mode, constant for
 * every row, so it belongs here — said once, in words — rather than in a per-row glyph the reader
 * has to decode fifty times.
 *
 * It no longer explains the chip's appearance, because there is nothing left to explain: every
 * score renders identically and only the hue moves. That paragraph existed to make a two-state
 * encoding legible, and deleting the encoding was the better fix.
 */
function ScoreLegend({ qualifier, partial }: { qualifier: string; partial: boolean }) {
  return (
    <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
      Each row pairs a <span className="font-medium text-foreground/70">friend</span> (left) with a{" "}
      <span className="font-medium text-foreground/70">contact</span> (right). Every score measures
      the underlined part — <span className="font-medium text-foreground/70">{qualifier}</span> on
      this run.
      {/* Gated on the TYPE, not on whether `qualifier` is set: every mode names itself now, so a
          truthiness test would fire on full-name runs too, where the warning is false. */}
      {partial && (
        <>
          {" "}
          Nothing else was compared, so 100% means the {qualifier} matched — not that it is the same
          person. Check before asking for an introduction.
        </>
      )}
    </p>
  );
}

/**
 * Best match, or the order of the file.
 *
 * Each is a legitimate reading and none modifies another, so a segmented control rather than a
 * checkbox. File order is not a curiosity: it is the order your source file is in, which is what
 * you want when you are checking this list against the thing you uploaded.
 *
 * "Best match" is only offered when the run has scores to rank by — see `showSimilarity`.
 *
 * "Matches first" (`sort=status`) was a third option and is gone. The filter tabs beside this
 * control already isolate the matches — "Matches 4" is the same question answered exactly rather
 * than by pushing them to the top of a list that still holds all 50. The server still accepts the
 * sort; nothing here asks for it.
 */
function SortToggle({
  sort,
  onChange,
  showSimilarity,
}: {
  sort: Sort;
  onChange: (s: Sort) => void;
  showSimilarity: boolean;
}) {
  const options: { value: Sort; label: string }[] = [
    ...(showSimilarity ? [{ value: "similarity" as const, label: "Best match" }] : []),
    { value: "row", label: "File order" },
  ];

  return (
    <div role="group" aria-label="Row order" className="inline-flex shrink-0 rounded-lg border bg-muted p-0.5">
      {options.map((o) => {
        const active = sort === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium",
              "transition-colors duration-fast ease-swift",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              active ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One finding: who to reach, where, and who to ask.
 *
 * `kind` only decides which side supplies which name — see the file header. Everything below this
 * line is direction-agnostic, which is the point of resolving them first.
 */
function Row({
  row,
  kind,
  type,
  language,
  extraKeys,
  showSimilarity,
  qualifier,
}: {
  row: RunRow;
  kind: Kind;
  type: CompareType;
  /** The run's language — what `name` is a spelling OF, and what `nameAlt` is not. */
  language: CompareLanguage;
  extraKeys: string[];
  showSimilarity: boolean;
  /**
   * What this run's scores are a measurement OF — `full name`, `given name` or `surname`, never
   * absent.
   *
   * Resolved once for the run and handed down, because it is constant for all 20 rows. It has to
   * reach the row anyway: the mode badge in the panel header scrolls out of sight, and a bare
   * "100%" fifteen rows down a surname run is read as "the same person" when it means "the same
   * surname" — which on this run is the difference between six matches and twenty-one.
   */
  qualifier: string;
}) {
  const isFriendRow = kind === "facebook";

  // The person to REACH is always the company contact; the person to ASK is always the friend's
  // owner. Which side of the row each comes from is the only thing that flips.
  const companyName = isFriendRow ? row.matchedContext : row.context;
  const owner = row.relationshipOwner;

  /**
   * THE PAIRING, IN ONE SCRIPT — four locals and three different language guesses ago.
   *
   * What stood here picked each side's spelling off the run's language axis INDEPENDENTLY and then
   * declared each side's language from the column it had just picked. Both halves of that are wrong
   * on the live database and the second one is what made it visible:
   *
   *   · The columns are not reliably in the language they are named for. `comparison_result`
   *     .person_name_en holds the THAI spelling on all 993 rows of run 4 — an external workflow
   *     writes the contact it matched into both columns — so an `en` run read `person_name_en`,
   *     got Thai, and rendered it with no `lang` at all.
   *   · With the sides resolved independently there was nothing to stop them disagreeing, and they
   *     did: `watchara ciaxoensuk → วัชระ เจริญสุข`, `full name 100%` between them. Two strings that
   *     were demonstrably never compared, under a percentage and an underline claiming they were.
   *
   * `resolveScoredPair` answers both at once: it re-files every name by SCRIPT (the rule the writers
   * already apply, see `nameSpellings`) and then picks the one language that holds BOTH sides,
   * preferring the run's own and falling back to the other. Rows 1–6 of run 4 resolve to the Thai
   * pair, which is the one the matcher can actually have looked at.
   *
   * The mode is still what the run ASKED FOR; these names are what HAPPENED. Where they conflict
   * `pair.agreed` goes false and the score below stops naming a unit — see `Score.qualifier`.
   *
   * One call for both directions, where the old code had a branch per side: a friend is a friend
   * whichever file was uploaded, so the only thing `kind` decides is which column supplies which
   * half. `row.name` / `row.nameAlt` are handed over as loose strings rather than as a typed pair
   * because that is what they are — the server coalesces `name` to the run's language and the two
   * are equal when that column was empty, which the script test resolves without needing to know.
   */
  const pair = resolveScoredPair(
    language,
    isFriendRow ? [row.name, row.nameAlt] : [row.matchedName, row.matchedNameTh],
    isFriendRow ? [row.matchedName, row.matchedNameTh] : [row.name, row.nameTh]
  );
  const friendName = pair.friend;
  const contactName = pair.contact;

  /**
   * What each side IS, for the role label's tooltip.
   *
   * The labels themselves are direction-agnostic — a friend is a friend whichever file was
   * uploaded — but WHICH OF THE TWO CAME OUT OF THE FILE flips, and that is the one thing the
   * reader cannot recover from the row. On a friends import the left-hand name is theirs and the
   * contact was found for it; on a company import it is the other way round.
   */
  const friendHint = isFriendRow
    ? "From the file you uploaded. Someone on your team knows this person."
    : "Someone on your team already knows this person — this is what the uploaded contact matched.";
  const contactHint = isFriendRow
    ? "The person at the company, found by the matcher."
    : "From the file you uploaded — the person at the company.";

  /**
   * WHY THE RUN'S MODE IS NOT WHAT LABELS THIS ROW.
   *
   * The uncompared spelling of each side stays in the `title` rather than on the row — one line of
   * height on every row is a real cost for something the run's finding does not rest on, and a hover
   * still answers "what else is this person called?". `pair.friendAlt` / `pair.contactAlt` are
   * already null where that spelling is the one being shown, so neither side can repeat itself.
   *
   * What the row can no longer do is state what the score MEASURED when its own names contradict the
   * mode. `qualifier` is the run's (`full name`, `given name`, `surname`) and it is only as good as
   * the mode it came from: on a run whose recorded names are Thai and whose `compare_by` says
   * English, the type axis is as unverified as the language axis was — `narong sinthu` against
   * `narong sinthu` scores 100% as a full name, a given name or a surname alike. So the unit is
   * dropped on those rows and `Score` says the measurement was not recorded, which is the case its
   * nullable `qualifier` was built for.
   */
  const rowQualifier = pair.agreed ? qualifier : null;

  /**
   * The pairing's two names are in different scripts and no single language holds both.
   *
   * Kept and SAID, not hidden: we hold a name for each of these two people and the reader needs
   * both, but nothing here supports the claim that they were measured against each other. See
   * preference 3 in `resolveScoredPair`.
   */
  const crossScript = !pair.sameScript;

  // Which of the five states this row is in. Still needed to decide what the row can SHOW — is
  // there a counterpart, is there a measurement — but no longer to decide how any of it LOOKS: a
  // matched row and a rejected one are laid out identically now. See the file header.
  const bucket = runRowBucket(rowVerdict(row.status), row.scored);

  /**
   * Is there a pairing to show — two names this run actually held against each other?
   *
   * The bucket test, not the verdict test, and that is the whole change. A REJECTED row has a
   * counterpart too: the matcher keeps each row's closest candidate whatever it decides about it,
   * so `matchedName` is populated for `unmatched` exactly as it is for `matched`. Showing it only
   * on the winners left a turned-down `surname 100%` with no second name anywhere on the row, which
   * is a measurement with no stated subject — and on a surname run the rejected pairs are the rows
   * a human most needs to look at.
   *
   * `pending`, `failed` and `unscored` have no counterpart and get the single-name form: nothing was
   * held against them, and inventing a left-hand side for a row nobody compared would be the same
   * mistake `unscored` exists to prevent.
   */
  const paired =
    (bucket === "matched" || bucket === "unmatched") && Boolean(friendName && contactName);

  /**
   * Is there a measurement to show instead of a verdict?
   *
   * All three conditions, and each rules out a real row. `showSimilarity` is the RUN's answer (an
   * external workflow may have scored nothing at all); `typeof …=== "number"` is the ROW's, since a
   * matcher can score most of a run and not all of it; and the bucket test keeps `pending`,
   * `failed` and `unscored` on the badge — a row nobody finished deciding is not a low score, and
   * `pending` rows can carry a stale number from a previous pass.
   */
  const graded =
    showSimilarity &&
    typeof row.similarity === "number" &&
    (bucket === "matched" || bucket === "unmatched");

  // Parsed per row rather than per run: `extra` is one blob per result, and a row that matched
  // nobody has none at all.
  const extras = extraKeys.length > 0 ? parseExtra(row.extras) : {};

  return (
    <li className="grid gap-x-6 gap-y-2 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0 space-y-1">
        {paired ? (
          /* THE PAIRING, on one line and at one size. Friend left, contact right, the arrow
             between them meaning "was compared against" — and a role label on each, because
             "which of these two is the one at the company" is the question this row exists to
             answer and a Thai name beside a Thai name does not answer it by itself.

             "at" stays a preposition rather than a column header, so the contact and their
             employer read as a phrase instead of two fields that happen to be adjacent. */
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <Side label="friend" hint={friendHint}>
              <MarkedName
                name={friendName}
                type={type}
                lang={pair.friendLang === "th" ? "th" : undefined}
                alt={pair.friendAlt}
                className="font-display text-base font-semibold leading-snug"
              />
            </Side>

            <ArrowRight
              className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground/70"
              aria-label="was compared against"
            />

            <Side label="contact" hint={contactHint}>
              <MarkedName
                name={contactName}
                type={type}
                lang={pair.contactLang === "th" ? "th" : undefined}
                alt={pair.contactAlt}
                className="font-display text-base font-semibold leading-snug"
              />
            </Side>

            {companyName && (
              <>
                <span className="text-xs text-muted-foreground">at</span>
                <span className="min-w-0 truncate font-medium" title={companyName}>
                  {companyName}
                </span>
              </>
            )}
          </p>
        ) : (
          // NOTHING TO PAIR IT WITH: the row itself is the subject. Reached by `pending`, `failed`
          // and `unscored`, and by a matcher that reported a verdict without naming the counterpart
          // — in every one of those cases there is no second name that exists to be shown, and the
          // question this row answers is "what happened to the name I gave you".
          //
          // The role label stays, so a single-name row and the left half of a paired one are read
          // the same way rather than looking like two different kinds of thing.
          //
          // The row's own half of the pair is the whole of it — the spelling this run COMPARED when
          // it had one, and otherwise whatever spelling we hold, which is the entire content of an
          // unscored row ("we hold this person, just not in the language this run needed"). The
          // uncompared spelling stays in the title rather than on the row: putting it on the row
          // adds height to EVERY row for something the run's finding does not depend on.
          <p className="flex flex-wrap items-baseline gap-x-2">
            <Side
              label={isFriendRow ? "friend" : "contact"}
              hint={isFriendRow ? friendHint : contactHint}
            >
              <MarkedName
                name={isFriendRow ? friendName : contactName}
                type={type}
                // The row's OWN side, so the language is the one belonging to that side. They are
                // not interchangeable: on a company import `friendLang` describes the friend this
                // contact matched, which is not the string being rendered here.
                lang={(isFriendRow ? pair.friendLang : pair.contactLang) === "th" ? "th" : undefined}
                alt={isFriendRow ? pair.friendAlt : pair.contactAlt}
                className="font-display text-base font-medium leading-snug"
              />
            </Side>
          </p>
        )}

        {/* WHOSE RELATIONSHIP, AND WHO FILED IT — the same strip the company page puts under a
            connection, from the same component, so the two names are labelled the same way, carry
            the same icons and link to the same roster wherever a reader meets them.

            This row used to say it in two places and two registers: the owner on an accent-coloured
            line of its own above (`relationship owner  Mint W.`, no icon, not a link) on paired
            rows, and `Mint W.'s list` down in the grey run-on line on unpaired ones — with the
            importer folded into that same grey line between them, wordless and dropped when null.
            Three renderings of two facts. The header's claim that this matched "what
            `ConnectionCard` calls it" was never true of anything but the phrase.

            The owner does lose the accent line, which was deliberate once — it is the answer to
            "who do I ask", and it sat directly under the pairing for that reason. It is still the
            first name on the strip, still the only linked one, and now unmissably labelled; the
            product having ONE way to render provenance is worth more than this row having the
            loudest one. */}
        <Provenance owner={owner} uploadedBy={row.uploaderName} />

        {/*
          WHERE THIS ROW'S NAMES AND ITS RUN'S MODE DISAGREE — on the row, because the row is the
          only thing that knows.

          The mode chip in the panel header states what the run was CONFIGURED to compare, once, for
          all 20 rows. It cannot say that a particular row's stored names contradict it, and that is
          a per-row fact: a workflow may honour `compare_by` on some rows and not others, and on this
          database `comparison_result.person_name_en` holds the Thai spelling for every row of run 4.

          `text-confidence-medium` — the app's one amber, the token `Callout`'s warning tone uses, and
          the same one `ConnectionCard` puts on the same caveat. The wording is deliberately close to
          that card's: a reader who meets this pairing on both screens should not have to work out
          whether the two notices mean the same thing.

          Only on rows making a claim (`paired`). A single-name row has no pairing for a language to
          be wrong about, which is why `resolveScoredPair` reports `sameScript` true when a side is
          missing rather than leaving that judgement to each caller.
        */}
        {paired && !pair.agreed && (
          <p className="text-xs text-confidence-medium">
            {crossScript
              ? "the two names above are in different scripts — no spelling of both exists in one language, so what this score measured is unconfirmed"
              : `set to compare ${LANGUAGE_LABEL[language]}, but recorded ${
                  LANGUAGE_LABEL[pair.language]
                } names — what this score measured is unconfirmed`}
          </p>
        )}

        {/* What is left of the old provenance line: facts about the RECORD, not about the people —
            how old it is, and whatever the file carried alongside the name.

            A `→ matched <name>` clause used to lead this line, and it was the run's only statement
            of what the row was compared against — the evidence for the finding, in the type size
            reserved for things you may skip. It is the pairing above now, at full size, on matched
            and rejected rows alike. */}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {/* `friend.updated_at` / `company_contact.updated_at` — when this RECORD last moved, not
              when the verdict was written. A re-run would date every row today, and "how old is
              this relationship" is what someone deciding whether to act on it is asking.

              AN ACTUAL DATE, not "2h ago". The relative form is built for a feed you are watching,
              and it earned its place while these rows filled in live — but it is read most often on
              a finished run, where "2h ago" and "3d ago" are answers you then have to convert to
              decide whether a roster predates someone changing jobs. A date is the fact; the exact
              timestamp stays on hover for the rare case where the hour matters. */}
          {row.updatedAt && (
            <span title={new Date(row.updatedAt).toLocaleString()}>
              updated {formatDate(row.updatedAt)}
            </span>
          )}
          {extraKeys.map((k) => {
            const v = extras[k];
            if (v === null || v === undefined || v === "") return null;
            return (
              <span key={k}>
                {k.replace(/_/g, " ")} <span className="text-foreground/70">{String(v)}</span>
              </span>
            );
          })}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3 sm:justify-end">
        {/*
          THE MEASUREMENT, and nothing else — one chip, the same shape on every scored row, tinted
          by how close the two names came. What the matcher concluded about the pairing is not here
          any more; it is in the filter tabs and the headline, where it is a fact about the run
          rather than a second thing to read on all fifty rows.

          The badge survives for rows with NO number to show: "waiting", "failed" and "never
          compared" are absences of a measurement rather than a low one, and a red 0% would state a
          finding nobody made. It also still catches `matched` / `unmatched` on a run whose matcher
          reported bare verdicts and no scores at all — rare, and the alternative there is an empty
          gutter on every row of the run.
        */}
        {graded ? (
          // `rowQualifier`, not `qualifier` — the run's unit, dropped on the rows whose own recorded
          // names disprove the mode it came from. See the note above it.
          <Score value={row.similarity} qualifier={rowQualifier} />
        ) : bucket === "matched" || bucket === "unmatched" ? (
          // Decided, but with no number recorded — an external workflow that posts verdicts and no
          // `similarity`. The verdict is exactly what this column no longer says, so what is left to
          // state is the absence of the measurement: a muted dash, with the reason on hover. NOT a
          // 0%, which would colour a missing measurement bright red and read as a confident finding
          // of "nothing in common".
          <Score value={null} qualifier={rowQualifier} />
        ) : (
          // The three buckets that are STATES rather than verdicts, and are therefore untouched by
          // the decision to stop rendering verdicts: a row still being worked on, a row that broke,
          // and a row this run's mode could never have scored. None of them is a low score, and a
          // dash would tell all three of them apart from each other not at all.
          <VerdictBadge bucket={bucket} language={language} kind={kind} />
        )}
      </div>
    </li>
  );
}
