"use client";

import * as React from "react";
import {
  Building2,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  TriangleAlert,
  Users,
} from "lucide-react";
import { rowVerdict, type ComparisonProgress, type RowVerdict, type RunRow } from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfidenceBadge } from "@/components/confidence/ConfidenceBadge";
import { useRunRows } from "@/hooks/queries";
import type { RunRowsParams } from "@/lib/api/client";
import { cn } from "@/lib/utils";

/**
 * The rows of an import, and what the workflow has decided about each — updating as it decides.
 *
 * The progress panel above this says *how much* of a run is done. This says *which*, and it is the
 * thing someone watching their own import actually wants: a bar at 60% tells you to wait, a table
 * of names tells you what is happening to your data. Rows appear the moment they are imported, at
 * "Waiting", and their verdicts fill in underneath them.
 *
 * Held in insertion order, never re-sorted. The list is re-read every couple of seconds, and a
 * table that re-sorted as verdicts landed would move the line you were reading out from under you
 * on every tick. Still, a row's badge changes in place and you watch your file being decided —
 * which is the whole effect. Sorting *findings* by score is the results table's job, and it does
 * that once the run is over and the answer has stopped moving.
 *
 * The two directions are NOT the same table with the words swapped, which is why `kind` reaches all
 * the way into the headers and the cells. A friends import asks "does anyone I know work there?" —
 * so each row is a friend, and the match is a contact, who has an English name, a Thai name and an
 * employer. A company import asks the reverse — each row is a contact, and the match is a friend,
 * who has one name and, far more usefully, *somebody who knows them*. Rendered as one generic
 * "name → name" table, both questions lose their answer.
 */

const PAGE_SIZE = 25;

type Filter = NonNullable<RunRowsParams["filter"]>;
type Kind = RunRow["kind"];

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
 * What each side is called, in the reader's terms rather than the table's.
 *
 * `source` names what you uploaded; `target` names what it was compared against. They swap, and
 * saying so in the column headers is most of the fix: "Friend → Matched contact" and
 * "Contact → Matched friend" each answer, before a single row is read, the question the screenshot
 * could not — *which of these two did I just import?*
 */
const SIDES: Record<Kind, { icon: typeof Users; label: string; source: string; target: string }> = {
  facebook: {
    icon: Users,
    label: "Facebook friends",
    source: "Friend",
    target: "Matched contact",
  },
  company: {
    icon: Building2,
    label: "Company contacts",
    source: "Contact",
    target: "Matched friend",
  },
};

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
 * A person, in up to three lines: who they are, how else they are spelled, and where they belong.
 *
 * The second and third lines only exist when there is something to put in them, so a friend (one
 * name, one uploader) does not render two empty rows to keep a contact company. `lang="th"` on the
 * Thai line lets the browser pick a Thai face rather than falling back through a Latin one.
 */
function Person({
  name,
  nameTh,
  context,
  contextIcon: ContextIcon,
}: {
  name: string | null;
  nameTh: string | null;
  context: string | null;
  contextIcon?: typeof Users;
}) {
  if (!name && !nameTh && !context) return <span className="text-muted-foreground">—</span>;

  return (
    <div className="min-w-0 max-w-[18rem] space-y-0.5">
      <span className="block truncate font-medium" title={name ?? undefined}>
        {name ?? <span className="font-normal text-muted-foreground">—</span>}
      </span>

      {nameTh && (
        <span lang="th" className="block truncate text-sm text-muted-foreground" title={nameTh}>
          {nameTh}
        </span>
      )}

      {context && (
        <span
          className="flex items-center gap-1 truncate text-xs text-muted-foreground"
          title={context}
        >
          {ContextIcon && <ContextIcon className="h-3 w-3 shrink-0" aria-hidden />}
          <span className="truncate">{context}</span>
        </span>
      )}
    </div>
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
    { key: "pending", label: "Waiting", count: progress?.pending },
  ];

  // Only offered once there is one. A "Failed (0)" tab on a healthy run is an invitation to worry
  // about nothing; a "Failed (3)" tab on a broken one is the most important control on the page.
  if (progress && progress.failed > 0) {
    tabs.push({ key: "failed", label: "Failed", count: progress.failed });
  }

  return tabs;
}

interface Props {
  comparisonId: string;
  /** The counts above the table — also what labels the filter tabs. */
  progress?: ComparisonProgress;
  /** Keep polling. False for a run that has stopped moving; its rows are still worth reading. */
  live: boolean;
}

export function RunRows({ comparisonId, progress, live }: Props) {
  const [filter, setFilter] = React.useState<Filter>("all");
  const [page, setPage] = React.useState(1);

  // Changing the filter re-pages from the top: page 4 of "all" is not page 4 of "matches", and
  // landing on an empty page you didn't ask for reads as "there are none".
  React.useEffect(() => setPage(1), [filter]);

  const params = React.useMemo<RunRowsParams>(
    () => ({ page, limit: PAGE_SIZE, filter }),
    [page, filter]
  );
  const q = useRunRows(comparisonId, params, live);

  const rows = q.data?.data ?? [];
  const total = q.data?.pagination.total ?? 0;
  const totalPages = q.data?.pagination.totalPages ?? 0;
  const tabs = filterTabs(progress);

  // Nothing to monitor: a run with no import behind it (the internal matcher scores in-request and
  // stamps no rows). Say nothing rather than showing an empty table that implies the rows are late.
  if (!q.isLoading && total === 0 && filter === "all") return null;

  // Every row of a run is the same kind — it is one file, from one source. Take it from the first
  // row rather than threading it down from the page, which would have to fetch the run to know it.
  const kind: Kind = rows[0]?.kind ?? "facebook";
  const side = SIDES[kind];
  const SideIcon = side.icon;
  const ContextIcon = kind === "company" ? Building2 : Users;
  const MatchedContextIcon = kind === "company" ? Users : Building2;

  return (
    <Card>
      <CardContent className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-lg font-semibold leading-none tracking-tight">
                Your rows
              </h3>
              {/* Which file this run is about. The screen used to be identical for a friends
                  import and a company import, so the only way to tell them apart was to remember
                  what you had uploaded a minute ago. */}
              <Badge variant="secondary" className="gap-1.5">
                <SideIcon className="h-3 w-3 shrink-0" aria-hidden />
                {side.label}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {live
                ? "Each name you uploaded, and what the matcher has said about it so far."
                : "Each name you uploaded, and what the matcher said about it."}
            </p>
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
                  <span className="tabular-nums text-muted-foreground">
                    {t.count.toLocaleString()}
                  </span>
                )}
              </Button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                {/* The headers name the two sides rather than saying "Name" and "Matched with",
                    which were true of both directions and therefore told you nothing about either. */}
                <TableHead>{side.source}</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>{side.target}</TableHead>
                <TableHead className="text-right">Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.isLoading ? (
                Array.from({ length: 5 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={4}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                    No rows in this view{live ? " yet" : ""}.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <Row
                    key={r.id}
                    row={r}
                    contextIcon={ContextIcon}
                    matchedContextIcon={MatchedContextIcon}
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

function Row({
  row,
  contextIcon,
  matchedContextIcon,
}: {
  row: RunRow;
  contextIcon: typeof Users;
  matchedContextIcon: typeof Users;
}) {
  const verdict = rowVerdict(row.status);

  return (
    <TableRow>
      <TableCell className="align-top">
        <Person
          name={row.name}
          nameTh={row.nameTh}
          context={row.context}
          contextIcon={contextIcon}
        />
      </TableCell>

      <TableCell className="align-top">
        <VerdictBadge status={row.status} />
      </TableCell>

      <TableCell className="align-top">
        <Person
          name={row.matchedName}
          nameTh={row.matchedNameTh}
          context={row.matchedContext}
          contextIcon={matchedContextIcon}
        />
      </TableCell>

      {/* A null score is not a zero. The workflow need only write a result row for a name it
          matched, so a finished row can legitimately have no score at all — printing 0% there
          would invent a confident measurement of something that was never measured. */}
      <TableCell className="text-right align-top">
        {row.score !== null ? (
          <ConfidenceBadge score={row.score} className="ml-auto" />
        ) : (
          <span className="text-sm text-muted-foreground">
            {verdict === "pending" ? "—" : "No score"}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}
