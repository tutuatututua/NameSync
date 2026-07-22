"use client";

import * as React from "react";
import {
  Building2,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  GitMerge,
  TriangleAlert,
  Users,
} from "lucide-react";
import { rowVerdict, type ComparisonProgress, type RowVerdict, type RunRow } from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFullWidth } from "@/components/main-container";
import { useRunRows } from "@/hooks/queries";
import type { RunRowsParams } from "@/lib/api/client";
import { parseExtra } from "@/lib/match";
import { cn } from "@/lib/utils";

/**
 * Every row a run looked at, and what it decided about each — the only table on this page.
 *
 * It used to be the second of two, under a results table that showed the same matches again with
 * fewer facts on them. That table read `comparison_result`, this one reads the rows themselves, and
 * on an import-driven run the first was a strict subset of the second: same friend, same contact,
 * same score, minus the company and minus the verdict. Worse, they did not merely duplicate — a
 * friend who matched several contacts was several rows up there and one row down here, and nothing
 * on screen said which count to believe. One table, one answer.
 *
 * All three kinds of run now feed it, and the differences between them are real but small:
 *
 *   · A friends import  — each row is a friend you uploaded; the match is a contact, and the fact
 *                         worth knowing about the match is the company they work for.
 *   · A company import  — each row is a contact you uploaded; the match is a friend, who has only a
 *                         name, so the fact worth knowing is *whose* friend they are.
 *   · A compare         — you picked a company and every friend on file was scored against it. Each
 *                         row is a friend. Nothing was uploaded, so these are not "your rows".
 *
 * `kind` decides the first two, `origin` the third, and both arrive on the progress payload rather
 * than being sniffed from `rows[0]` — the list is paged and filtered, and a page with no rows on it
 * still has to draw the right headers.
 *
 * Order is the caller's business, not this table's: see `sort` below. Held in import order while
 * the run is live, best-first once it stops.
 */

const PAGE_SIZE = 25;

/**
 * Below this many rows, the table shows no filter tabs and no sort control.
 *
 * They are controls for a table you have to *navigate*, and a run with four rows in it is not
 * navigated, it is read. Under that size they are worse than useless: "All 2 · Matches 1 · No
 * match 1" is a third restatement of a headline two inches above it, and "Best first / File order"
 * offers to reorder a list you can take in whole. Chrome that cannot do anything reads as chrome
 * you have not understood yet.
 *
 * Ten because that is roughly where a table stops being a paragraph and starts being a list. It is
 * a judgement, not a measurement.
 */
const CONTROLS_MIN_ROWS = 10;

type Filter = NonNullable<RunRowsParams["filter"]>;
type Sort = NonNullable<RunRowsParams["sort"]>;
type Kind = RunRow["kind"];
type Origin = ComparisonProgress["origin"];

/** The four verdicts, as they read on screen. Keyed by the shared `RowVerdict`, so a bucket
 *  cannot be renamed in the contract and left stale here. */
const VERDICT: Record<
  RowVerdict,
  { label: string; icon: typeof CheckCircle2; className: string; spin?: boolean }
> = {
  pending: {
    label: "Waiting",
    icon: CircleDashed,
    className: "border-border-strong bg-transparent text-muted-foreground",
    spin: true,
  },
  matched: {
    label: "Match",
    icon: CheckCircle2,
    className: "border-confidence-high/25 bg-confidence-high/10 text-confidence-high",
  },
  unmatched: {
    label: "No match",
    icon: CircleSlash,
    className: "border-border bg-muted text-muted-foreground",
  },
  failed: {
    label: "Failed",
    icon: TriangleAlert,
    className: "border-destructive/25 bg-destructive/10 text-destructive",
  },
};

/**
 * The two sides a row is welded from, described once each.
 *
 * A row here is two records stapled together by a fuzzy score, and it reads as one — a Facebook
 * name and a company name in adjacent columns, as if they had always belonged to the same record.
 * They didn't. Naming the side per *block* rather than per column is what says so: the top tier of
 * the header names the source and the table it physically came out of, the bottom names its fields,
 * and a tint plus a rule down the left keeps the grouping visible once you are reading rows.
 *
 * Both sides are described symmetrically because both directions exist. A run's SOURCE side is its
 * `kind` (a friends import scores friends) and its TARGET is the other one — so a company import is
 * this same table with the blocks swapped, not a different table. Each side keeps its colour in
 * both: Facebook is always cyan, company always indigo, whichever of them you happened to upload.
 *
 * The `context` column is the point of the whole layout. `uploaded_by` and `company_name` used to
 * be small grey lines stacked under the names, styled identically — so "mint.w@lakeshore.demo" and
 * "BANGKOK BANK" looked like the same kind of fact, when one is who knows this person and the other
 * is where they work, from two different tables. They are columns now, under headers that name them.
 */
type Side = "facebook" | "company";

interface SideMeta {
  /** The source, as the top tier announces it. */
  eyebrow: string;
  /** The table it physically came out of — the literal answer to "where is this from". */
  table: string;
  icon: typeof Users;
  /** Header for the name column. */
  name: string;
  /** Header for the context column: who knows them, or where they work. */
  context: string;
  /** The block's wash. Deliberately faint — it groups columns, it does not highlight them. */
  tint: string;
  /** The rule under the top tier, in the side's own colour. */
  rule: string;
  /** How the panel header names a run of this kind. */
  badge: string;
}

const SIDE: Record<Side, SideMeta> = {
  facebook: {
    eyebrow: "Facebook",
    table: "friend",
    icon: Users,
    name: "Friend",
    context: "Uploaded by",
    tint: "bg-brand-2/[0.07]",
    rule: "border-b-brand-2",
    badge: "Facebook friends",
  },
  company: {
    eyebrow: "Company",
    table: "company_contact",
    icon: Building2,
    name: "Contact",
    context: "Company",
    tint: "bg-brand/[0.07]",
    rule: "border-b-brand",
    badge: "Company contacts",
  },
};

/** The vertical rule that opens each block — the grouping, once the header has scrolled away. */
const DIVIDER = "border-l border-l-border-strong";

/**
 * The panel's title and subtitle.
 *
 * Split on `origin` and not on `kind`, because this is the one thing the two imports agree about
 * and the compare does not: you handed over a file, so the rows are yours. A compare scored a
 * friend list that was already on file and may have been uploaded by somebody else entirely —
 * calling that "your rows" is a small lie that makes the whole panel read as someone else's data.
 */
function heading(
  origin: Origin,
  live: boolean,
  company: string | null
): { title: string; description: string } {
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

/**
 * The row's outcome — the workflow's word on whether it is *done*, and our word on whether it
 * *matched*. See `rowVerdict`: the split is deliberate, and it is what stops this badge and the
 * count above it coming from two different definitions of "match".
 */
function VerdictBadge({ status }: { status: string | null }) {
  const verdict = rowVerdict(status);
  const { label, icon: Icon, className, spin } = VERDICT[verdict];

  return (
    <Badge variant="outline" className={cn("gap-1.5", className)}>
      <Icon className={cn("h-3 w-3 shrink-0", spin && "animate-spin [animation-duration:2.5s]")} aria-hidden />
      {label}
    </Badge>
  );
}

/**
 * A person: who they are, and how else they are spelled.
 *
 * The Thai line only exists when there is something to put in it, so a friend — who has one name —
 * does not render an empty second row to keep a contact company. `lang="th"` lets the browser pick
 * a Thai face rather than falling back through a Latin one.
 *
 * No third line. Where they belong is a column now, under a header that says which of the two kinds
 * of "where" it is.
 */
function Person({ name, nameTh }: { name: string | null; nameTh: string | null }) {
  if (!name && !nameTh) return <span className="text-muted-foreground">—</span>;

  return (
    <div className="min-w-0 max-w-[16rem] space-y-0.5">
      <span className="block truncate font-medium" title={name ?? undefined}>
        {name ?? <span className="font-normal text-muted-foreground">—</span>}
      </span>

      {nameTh && (
        <span lang="th" className="block truncate text-sm text-muted-foreground" title={nameTh}>
          {nameTh}
        </span>
      )}
    </div>
  );
}

/** A context cell — the uploader, or the company. Its header says which. */
function Context({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="block max-w-[14rem] truncate text-sm text-muted-foreground" title={value}>
      {value}
    </span>
  );
}

/**
 * The filter tabs, each carrying its own count.
 *
 * The counts come from the progress endpoint rather than from this table, because this table only
 * ever holds one page: counting its rows would label the "Match" tab with the number of matches
 * *on screen*, which on page 1 of 13 is a different and much smaller number than the truth.
 */
function filterTabs(progress: ComparisonProgress | undefined) {
  const tabs: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: "All", count: progress?.total },
    { key: "matched", label: "Matches", count: progress?.matched },
    { key: "unmatched", label: "No match", count: progress?.unmatched },
  ];

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
  /** The counts above the table — also what labels the filter tabs, and what says which way round
   *  the run is. */
  progress?: ComparisonProgress;
  /** Keep polling. False for a run that has stopped moving; its rows are still worth reading. */
  live: boolean;
  /** The company this run picked, if it picked one. Only used to name it in the subtitle. */
  company?: string | null;
}

export function RunRows({ comparisonId, progress, live, company = null }: Props) {
  const [filter, setFilter] = React.useState<Filter>("all");
  const [page, setPage] = React.useState(1);

  /**
   * The widest thing in the product, so it asks for the window.
   *
   * Here and not in `ResultsView`, because this table is also rendered bare — the Compare screen's
   * live monitor has no verdict over it, and it would want the room just as much. The container's
   * route list cannot see either case: the Compare screen is `/`, which is capped, and it renders
   * this at both of them.
   */
  useFullWidth();

  // Where the run came from. Derived from the poll (a prop) up here, because the default sort below
  // depends on it. `kind` is derived lower down, where it can also fall back to `rows[0]`.
  const origin: Origin = progress?.origin ?? "import";

  /**
   * Whether this run carries a per-row similarity to rank and show.
   *
   * Only a compare-by-company run does: its rows are `comparison_result` rows the internal matcher
   * scored. An import-driven run reads its rows from `friend` / `company_contact`, which have no
   * score, so the column would be all "—" and the "Best match" sort a no-op — both hidden there.
   */
  const showSimilarity = origin === "compare";

  /**
   * Null until the reader says otherwise, and that is the whole design.
   *
   * The default follows `live`, because the only reason to hold import order is that the table is
   * moving: it re-reads every couple of seconds, and rows that re-sorted as verdicts landed would
   * slide out from under the line you were reading. The moment the run stops, that reason is gone
   * and import order becomes the problem instead — the four matches of a 320-row run are scattered
   * across 13 pages, and the first screen is whichever names happened to be inserted first.
   *
   * So a finished run defaults to its best ordering: "Best match" (similarity) when it has scores to
   * rank by — a compare run — and "Matches first" otherwise. Watching a run holds import order until
   * it stops, which is exactly when your question turns from "is this working" to "what did it find".
   * An explicit choice is never overridden — asking for file order survives the run finishing.
   */
  const [sortOverride, setSortOverride] = React.useState<Sort | null>(null);
  const sort: Sort = sortOverride ?? (live ? "row" : showSimilarity ? "similarity" : "status");

  // Both re-page from the top: page 4 of "all" is not page 4 of "matches", and page 4 of file
  // order is not page 4 of matches-first. Landing on an empty page you didn't ask for reads as
  // "there are none".
  React.useEffect(() => setPage(1), [filter, sort]);

  const params = React.useMemo<RunRowsParams>(
    () => ({ page, limit: PAGE_SIZE, filter, sort }),
    [page, filter, sort]
  );
  const q = useRunRows(comparisonId, params, live);

  const rows = q.data?.data ?? [];
  const total = q.data?.pagination.total ?? 0;
  const totalPages = q.data?.pagination.totalPages ?? 0;
  const tabs = filterTabs(progress);

  // From the run, not from `rows[0]`, which is only reachable when there is nothing to correct it:
  // a company run filtered to a bucket with nothing in it would draw a friends run's headers.
  const kind: Kind = progress?.kind ?? rows[0]?.kind ?? "facebook";
  const extraKeys = progress?.extraKeys ?? [];

  /**
   * Are the controls worth their space?
   *
   * Measured on the run's own size (`progress.total`), never on the page's — the pagination total
   * moves with the filter, so a table filtered down to two rows would hide the very tabs you would
   * need to get back out of it.
   *
   * A failed row overrides the size test outright. On a 300-row run "Failed 3" is a tab; on a
   * 4-row run it is the only thing on the screen that matters, and it is exactly the run where
   * hiding it would look like a clean result.
   */
  const runSize = progress?.total ?? 0;
  const showControls = runSize >= CONTROLS_MIN_ROWS || (progress?.failed ?? 0) > 0;

  /**
   * Which side is which.
   *
   * The run's `kind` IS its source side — a friends import scores friends — and the target is
   * whatever the other one is. So a company import is this table with the two blocks swapped, and
   * nothing else about it changes.
   */
  const src = SIDE[kind];
  const tgt = SIDE[kind === "facebook" ? "company" : "facebook"];
  const SrcIcon = src.icon;
  const TgtIcon = tgt.icon;

  const { title, description } = heading(origin, live, company);
  // name + context, per side, then whatever the matcher sent, then similarity (compare runs only),
  // then the verdict.
  const colCount = 4 + extraKeys.length + (showSimilarity ? 1 : 0) + 1;

  return (
    <Card>
      <CardContent className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-lg font-semibold leading-none tracking-tight">
                {title}
              </h3>
              {/* Which side this run is about. The screen used to be identical for a friends
                  import and a company import, so the only way to tell them apart was to remember
                  what you had uploaded a minute ago. */}
              <Badge variant="secondary" className="gap-1.5">
                <SrcIcon className="h-3 w-3 shrink-0" aria-hidden />
                {src.badge}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>

          {showControls && (
            <div className="flex flex-wrap items-center gap-3">
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
                      <span className="tabular-nums text-muted-foreground">
                        {t.count.toLocaleString()}
                      </span>
                    )}
                  </Button>
                ))}
              </div>

              <SortToggle sort={sort} onChange={setSortOverride} showSimilarity={showSimilarity} />
            </div>
          )}
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              {/* Tier one: where the columns beneath it came from, and out of which table. This is
                  the whole answer to "which of these is my company data and which is Facebook" —
                  the colour is the fast version of it, the name and the table are the exact one. */}
              <TableRow className="hover:bg-transparent">
                <TableHead colSpan={2} className={cn("border-b-2", src.rule, src.tint)}>
                  <SourceLabel icon={SrcIcon} eyebrow={src.eyebrow} table={src.table} />
                </TableHead>

                <TableHead colSpan={2} className={cn("border-b-2", tgt.rule, tgt.tint, DIVIDER)}>
                  <SourceLabel icon={TgtIcon} eyebrow={tgt.eyebrow} table={tgt.table} />
                </TableHead>

                {/* Not a source. The similarity, the verdict and whatever the matcher sent are the
                    only things on the row that neither table contributed — they are what the
                    *comparison* made. */}
                <TableHead
                  colSpan={1 + extraKeys.length + (showSimilarity ? 1 : 0)}
                  className={cn("border-b-2 border-b-border-strong bg-muted/40", DIVIDER)}
                >
                  <span className="inline-flex items-center gap-1.5 text-foreground">
                    <GitMerge className="h-3 w-3" aria-hidden /> Match
                  </span>
                </TableHead>
              </TableRow>

              <TableRow className="hover:bg-transparent">
                <TableHead className={src.tint}>{src.name}</TableHead>
                <TableHead className={src.tint}>{src.context}</TableHead>
                <TableHead className={cn(tgt.tint, DIVIDER)}>{tgt.name}</TableHead>
                <TableHead className={tgt.tint}>{tgt.context}</TableHead>
                {/* The rule opens the Match block, so it belongs to whichever column comes first in
                    it — the extras if the matcher sent any, else similarity, else the verdict. */}
                {extraKeys.map((k, i) => (
                  <TableHead key={k} className={cn(i === 0 && DIVIDER)}>
                    {k.replace(/_/g, " ")}
                  </TableHead>
                ))}
                {showSimilarity && (
                  <TableHead className={cn("text-right", extraKeys.length === 0 && DIVIDER)}>
                    Similarity
                  </TableHead>
                )}
                <TableHead
                  className={cn("text-right", extraKeys.length === 0 && !showSimilarity && DIVIDER)}
                >
                  Outcome
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.isLoading ? (
                Array.from({ length: 5 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={colCount}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={colCount}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    {filter === "all"
                      ? `This run has no rows${live ? " yet" : ""}.`
                      : `No rows in this view${live ? " yet" : ""}.`}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <Row
                    key={r.id}
                    row={r}
                    extraKeys={extraKeys}
                    src={src}
                    tgt={tgt}
                    showSimilarity={showSimilarity}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm tabular-nums text-muted-foreground">
              Page {page.toLocaleString()} of {totalPages.toLocaleString()} ·{" "}
              {total.toLocaleString()} row{total === 1 ? "" : "s"}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Best match, matches first, or the order of the file.
 *
 * Each is a legitimate reading and none modifies another, so a segmented control rather than a
 * checkbox. File order is not a curiosity: it is the order your source file is in, which is what you
 * want when you are checking this table against the thing you uploaded.
 *
 * "Best match" (similarity) is only offered when the run has scores to rank by — a compare run.
 * It ranks *within* the matches, which "Matches first" cannot: that one brings the matches to the
 * top and, on a compare run, orders them by similarity too, but on an import (no score) it stops at
 * matched-vs-not and leaves the file's order inside each group.
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
    { value: "status", label: "Matches first" },
    { value: "row", label: "File order" },
  ];

  return (
    <div
      role="group"
      aria-label="Row order"
      className="inline-flex shrink-0 rounded-lg border bg-muted p-0.5"
    >
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
              active
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** The top tier's label for one block: the source, and the table it physically came out of. */
function SourceLabel({
  icon: Icon,
  eyebrow,
  table,
}: {
  icon: typeof Users;
  eyebrow: string;
  table: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-foreground">
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      {eyebrow}
      <code className="ml-1 font-mono text-2xs normal-case tracking-normal text-muted-foreground">
        {table}
      </code>
    </span>
  );
}

/** A similarity in [0, 1] as a whole-number percent, or "—" when the row kept no score. */
function SimilarityCell({ value, className }: { value: number | null; className?: string }) {
  return (
    <TableCell className={cn("text-right align-top tabular-nums text-sm text-muted-foreground", className)}>
      {value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`}
    </TableCell>
  );
}

function Row({
  row,
  extraKeys,
  src,
  tgt,
  showSimilarity,
}: {
  row: RunRow;
  extraKeys: string[];
  src: SideMeta;
  tgt: SideMeta;
  showSimilarity: boolean;
}) {
  // Parsed per row rather than per run: `extra` is one blob per result, and a row that matched
  // nobody has none at all.
  const extras = extraKeys.length > 0 ? parseExtra(row.extras) : {};

  return (
    <TableRow>
      {/* The side you uploaded (or, on a compare, the side that was already on file). */}
      <TableCell className={cn("align-top", src.tint)}>
        <Person name={row.name} nameTh={row.nameTh} />
      </TableCell>
      <TableCell className={cn("align-top", src.tint)}>
        <Context value={row.context} />
      </TableCell>

      {/* The side it was held up against. */}
      <TableCell className={cn("align-top", tgt.tint, DIVIDER)}>
        <Person name={row.matchedName} nameTh={row.matchedNameTh} />
      </TableCell>
      <TableCell className={cn("align-top", tgt.tint)}>
        <Context value={row.matchedContext} />
      </TableCell>

      {extraKeys.map((k, i) => {
        const v = extras[k];
        return (
          <TableCell
            key={k}
            className={cn("align-top text-sm text-muted-foreground", i === 0 && DIVIDER)}
          >
            {v === null || v === undefined || v === "" ? "—" : String(v)}
          </TableCell>
        );
      })}

      {/*
        Similarity, then the verdict — but only on a compare run, which is the only kind that keeps a
        per-row score.

        This once said the score column was gone for good ("the badge won that argument"), and for an
        import that is still true: those rows have no score, and a matcher that sends one on the
        callback has it carried into `extra` as before. What is back is `comparison_result.similarity`
        — display and sort only, beside the badge rather than instead of it. The badge is still the
        verdict; the percent only says how close, and never overrules it.
      */}
      {showSimilarity && (
        <SimilarityCell value={row.similarity} className={cn(extraKeys.length === 0 && DIVIDER)} />
      )}
      <TableCell
        className={cn(
          "text-right align-top",
          extraKeys.length === 0 && !showSimilarity && DIVIDER
        )}
      >
        <VerdictBadge status={row.status} />
      </TableCell>
    </TableRow>
  );
}
